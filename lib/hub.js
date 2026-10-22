'use strict';

// The chat state machine: sign-on, rooms, messages, buddies, ignore, reports, kick and idle timers.
// Every rule here follows docs/PROTOCOL.md. Server addenda (section 15) are marked "addendum".

const { WebSocket } = require('ws');
const {
  BUDDY_MAX,
  IGNORE_MAX,
  MEMBER_ROOM_CAPACITY,
  PROFILE_FIELD_MAX,
  RATE_BURST,
  RATE_PER_SECOND,
  TEXT,
  TEXT_MAX,
  AWAY_MAX,
  byNameIgnoringCase,
  checkRoomName,
  checkScreenName,
  codePointCount,
  isReservedRoomName,
  makeError,
  normalize,
  parseFormat,
  refFor,
} = require('./protocol');
const { RateLimiter, monotonicMs } = require('./ratelimit');
const { IncidentLog } = require('./incidents');
const { ART, ART_INTERVAL_MS, ArtScroller } = require('./art');
const { MAX_BUFFERED_BYTES } = require('./security');

const MAX_TIMEOUT_MS = 2147483647; // setTimeout overflows above this and would fire at once.

function minutesToMs(minutes) {
  return Math.min(minutes * 60000, MAX_TIMEOUT_MS);
}

// Returns the parsed frame object, or null when the text is not a JSON object with a string type.
function parseFrame(data) {
  let frame;
  try {
    frame = JSON.parse(data.toString('utf8'));
  } catch {
    return null;
  }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return null;
  if (typeof frame.type !== 'string') return null;
  return frame;
}

class Client {
  constructor(ws, clock) {
    this.ws = ws;
    this.limiter = new RateLimiter({ capacity: RATE_BURST, perSecond: RATE_PER_SECOND, now: clock });
    this.idleTimer = null;
    this.graceTimer = null;
    this.clearSession();
  }

  get signedOn() {
    return this.name !== null;
  }

  // Everything below is session-only and is discarded at sign-off (PROTOCOL.md section 3).
  clearSession() {
    this.name = null; // canonical casing, set at sign-on
    this.key = null; // lowercase name, used for every comparison
    this.room = null;
    this.buddies = new Map(); // key -> name as typed when added, in add order
    this.ignores = new Set(); // keys
    this.away = '';
    this.profile = { location: '', hobbies: '', quote: '' };
  }
}

class ChatHub {
  constructor({ config, incidents = new IncidentLog(), logger = console, now = Date.now, monotonic = monotonicMs }) {
    this.config = config;
    this.incidents = incidents;
    this.logger = logger;
    this.now = now; // Wall-clock time, used only for the ts field of messages and for report times.
    this.monotonic = monotonic; // Used for rate limiting (addendum A1), so a clock change cannot affect it.
    this.rooms = new Map(); // room key -> room
    this.online = new Map(); // key -> Client, signed-on sessions only
    this.sockets = new Set(); // every connected Client, signed on or not
    this.art = new ArtScroller();
    this.closing = false;
    this.ensureLobby(1); // Lobby 1 exists from start-up and is never removed (rule 11.4).
  }

  // ---- connections -------------------------------------------------------

  attach(ws) {
    const client = new Client(ws, this.monotonic);
    this.sockets.add(client);
    ws.on('message', (data, isBinary) => this.onMessage(client, data, isBinary));
    ws.on('close', () => this.onClose(client));
    // A socket error always ends in a close event, which does the cleanup. Nothing more to do here.
    ws.on('error', () => {});
  }

  onClose(client) {
    this.stopIdle(client);
    this.endSession(client, 'closed');
    this.sockets.delete(client);
  }

  onMessage(client, data, isBinary) {
    // Any inbound message counts as activity for the idle timer, even one that is dropped or malformed.
    this.noteActivity(client);

    if (!client.limiter.take()) {
      // A dropped frame is never processed. It still gets its own error (addendum A1), so the client can match it.
      this.rateLimited(client, isBinary ? null : parseFrame(data));
      return;
    }
    if (isBinary) {
      this.fail(client, null, 'bad_frame');
      return;
    }
    const frame = parseFrame(data);
    if (frame === null) {
      this.fail(client, null, 'bad_frame');
      return;
    }
    try {
      this.dispatch(client, frame);
    } catch (err) {
      this.logger.error(`Internal error handling "${frame.type}": ${err && err.stack ? err.stack : err}`);
      this.fail(client, frame.type, 'internal_error');
    }
  }

  // Addendum A1: one rate_limited error for each dropped frame. ref is that frame's type (PROTOCOL.md 7.1),
  // or null when the frame has no readable type.
  rateLimited(client, frame) {
    const ref = frame ? refFor(frame.type) : null;
    this.send(client, makeError('rate_limited', null, ref, null));
  }

  dispatch(client, frame) {
    const { type } = frame;

    if (!client.signedOn) {
      if (type === 'sign_on') return this.signOn(client, frame);
      return this.fail(client, type, 'not_signed_on');
    }
    if (type === 'sign_on') return this.fail(client, type, 'already_signed_on');

    switch (type) {
      case 'sign_off':
        return this.endSession(client, 'user');
      case 'list_rooms':
        return this.send(client, this.roomListFrame());
      case 'create_room':
        return this.createRoom(client, frame);
      case 'join_room':
        return this.joinRoom(client, frame);
      case 'leave_room':
        return this.leaveRoom(client);
      case 'say':
        return this.say(client, frame);
      case 'art':
        return this.artCommand(client, frame);
      case 'im':
        return this.im(client, frame);
      case 'set_away':
        return this.setAway(client, frame);
      case 'get_profile':
        return this.getProfile(client, frame);
      case 'set_profile':
        return this.setProfile(client, frame);
      case 'buddy_add':
        return this.buddyAdd(client, frame);
      case 'buddy_remove':
        return this.buddyRemove(client, frame);
      case 'ignore':
        return this.ignore(client, frame);
      case 'report':
        return this.report(client, frame);
      case 'still_here':
        return undefined; // Counts as activity only, which noteActivity already handled.
      case 'kick':
        return this.kick(client, frame);
      default:
        return this.fail(client, type, 'unknown_type');
    }
  }

  send(client, frame) {
    const { ws } = client;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      ws.close(1013, 'Client is not keeping up');
      return;
    }
    ws.send(JSON.stringify(frame), () => {});
  }

  fail(client, type, code, message = null, field = null) {
    this.send(client, makeError(code, message, refFor(type), field));
  }

  // The chat-facing name for a key: the canonical casing when signed on, otherwise the name as typed.
  displayName(key, typed) {
    const online = this.online.get(key);
    return online ? online.name : typed;
  }

  // ---- sign-on and sign-off -------------------------------------------

  signOn(client, frame) {
    const name = checkScreenName(frame.screen_name);
    if (name === null) return this.fail(client, 'sign_on', 'invalid_field', TEXT.screenName, 'screen_name');
    const key = name.toLowerCase();
    if (this.online.has(key)) return this.fail(client, 'sign_on', 'name_taken', null, 'screen_name');

    client.name = name;
    client.key = key;
    this.online.set(key, client);
    this.send(client, { type: 'signed_on', screen_name: name });
    this.startIdle(client);

    const lobby = this.placeInLobby();
    this.enterRoom(client, lobby);
    this.sendRoomState(client, lobby, null);
    this.notifyWatchers(key, name, true);
    this.finishRoomChange();
  }

  // Order follows PROTOCOL.md 8 (O7): member_left, buddy_status, room_list, then signed_off for a user or idle sign-off.
  endSession(client, reason) {
    if (!client.signedOn) return;
    this.stopIdle(client);

    const { name, key } = client;
    this.departRoom(client, 'signed_off');
    this.online.delete(key);
    this.notifyWatchers(key, name, false);
    client.clearSession();
    this.finishRoomChange();

    // Addendum A2: an idle sign-off uses the same sequence as a user sign-off.
    if (reason === 'user' || reason === 'idle') {
      this.send(client, { type: 'signed_off', reason });
    }
  }

  notifyWatchers(key, name, online) {
    for (const other of this.online.values()) {
      if (other.buddies.has(key)) {
        this.send(other, { type: 'buddy_status', screen_name: name, online });
      }
    }
  }

  // ---- rooms -------------------------------------------------------------

  ensureLobby(number) {
    const key = `lobby ${number}`;
    let room = this.rooms.get(key);
    if (!room) {
      room = {
        key,
        name: `Lobby ${number}`,
        kind: 'lobby',
        number,
        capacity: this.config.lobbyCapacity,
        members: new Set(),
        host: null,
      };
      this.rooms.set(key, room);
    }
    return room;
  }

  lobbies() {
    return [...this.rooms.values()]
      .filter((room) => room.kind === 'lobby')
      .sort((a, b) => a.number - b.number);
  }

  memberRooms() {
    return [...this.rooms.values()]
      .filter((room) => room.kind === 'member')
      .sort((a, b) => byNameIgnoringCase(a.name, b.name));
  }

  // Automatic placement (rule 11.1): the first lobby with room, else a new lobby after the highest number.
  placeInLobby() {
    const lobbies = this.lobbies();
    const open = lobbies.find((lobby) => lobby.members.size < lobby.capacity);
    if (open) return open;
    return this.ensureLobby(lobbies[lobbies.length - 1].number + 1);
  }

  roomListFrame() {
    const rooms = [...this.lobbies(), ...this.memberRooms()].map((room) => ({
      name: room.name,
      kind: room.kind,
      count: room.members.size,
      capacity: room.capacity,
    }));
    return { type: 'room_list', rooms };
  }

  broadcastRoomList() {
    const frame = this.roomListFrame();
    for (const client of this.online.values()) this.send(client, frame);
  }

  // Runs after every change to rooms or occupancy: empty rooms go, then room_list is sent (rule 11.4).
  finishRoomChange() {
    this.removeEmptyRooms();
    this.broadcastRoomList();
  }

  removeEmptyRooms() {
    for (const [key, room] of this.rooms) {
      if (room.members.size === 0 && (room.kind === 'member' || room.number !== 1)) {
        this.rooms.delete(key);
      }
    }
  }

  roomStateFrame(room, redirectedFrom) {
    const members = [...room.members].map((member) => member.name).sort(byNameIgnoringCase);
    return {
      type: 'room_state',
      room: room.name,
      kind: room.kind,
      capacity: room.capacity,
      members,
      host: room.host ? room.host.name : null,
      redirected_from: redirectedFrom ?? null,
    };
  }

  sendRoomState(client, room, redirectedFrom) {
    this.send(client, this.roomStateFrame(room, redirectedFrom));
  }

  // Adds the client to the room and tells the others who were already there.
  enterRoom(client, room) {
    room.members.add(client);
    client.room = room;
    for (const member of room.members) {
      if (member !== client) {
        this.send(member, { type: 'member_joined', room: room.name, screen_name: client.name });
      }
    }
  }

  // Removes the client from its room and tells the remaining occupants. The caller sends room_left to the client if needed.
  departRoom(client, reason) {
    this.art.cancel(client);
    const room = client.room;
    if (!room) return;
    room.members.delete(client);
    client.room = null;
    for (const member of room.members) {
      this.send(member, { type: 'member_left', room: room.name, screen_name: client.name, reason });
    }
    // Addendum A3: when the host leaves, the remaining occupants get a room_state refresh with host null.
    if (room.host === client) {
      room.host = null;
      if (room.members.size > 0) {
        const frame = this.roomStateFrame(room, null);
        for (const member of room.members) this.send(member, frame);
      }
    }
  }

  // Moves the client from its current room (if any) into the target room.
  moveTo(client, target, redirectedFrom) {
    const previous = client.room;
    if (previous) {
      this.departRoom(client, 'switched');
      this.send(client, { type: 'room_left', room: previous.name, reason: 'switched' });
    }
    this.enterRoom(client, target);
    this.sendRoomState(client, target, redirectedFrom);
    this.finishRoomChange();
  }

  createRoom(client, frame) {
    const name = checkRoomName(frame.name);
    if (name === null) return this.fail(client, 'create_room', 'invalid_field', TEXT.roomName, 'name');
    if (isReservedRoomName(name)) return this.fail(client, 'create_room', 'room_name_reserved', null, 'name');
    const key = name.toLowerCase();
    if (this.rooms.has(key)) return this.fail(client, 'create_room', 'room_name_taken', null, 'name');

    const room = {
      key,
      name,
      kind: 'member',
      number: null,
      capacity: MEMBER_ROOM_CAPACITY,
      members: new Set(),
      host: client,
    };
    this.rooms.set(key, room);
    this.moveTo(client, room, null);
  }

  joinRoom(client, frame) {
    const name = checkRoomName(frame.name);
    if (name === null) return this.fail(client, 'join_room', 'invalid_field', TEXT.roomName, 'name');
    const room = this.rooms.get(name.toLowerCase());
    if (!room) return this.fail(client, 'join_room', 'no_such_room', null, 'name');
    if (client.room === room) return this.sendRoomState(client, room, null);

    if (room.kind === 'member') {
      if (room.members.size >= room.capacity) return this.fail(client, 'join_room', 'room_full', null, 'name');
      return this.moveTo(client, room, null);
    }
    if (room.members.size < room.capacity) return this.moveTo(client, room, null);
    return this.redirect(client, room);
  }

  // Rule 11.2 step 5: a full lobby sends the joiner to the next lobby with room, creating one when needed.
  redirect(client, full) {
    for (let number = full.number + 1; ; number += 1) {
      const candidate = this.rooms.get(`lobby ${number}`);
      if (!candidate) return this.moveTo(client, this.ensureLobby(number), full.name);
      if (candidate.members.size < candidate.capacity) {
        // Addendum A4: if the candidate is the lobby the client is already in, it sends room_state only.
        if (candidate === client.room) return this.sendRoomState(client, candidate, full.name);
        return this.moveTo(client, candidate, full.name);
      }
    }
  }

  leaveRoom(client) {
    const previous = client.room;
    if (previous) {
      this.departRoom(client, 'left');
      this.send(client, { type: 'room_left', room: previous.name, reason: 'left' });
    }
    // Addendum A5: placement can return the client to the lobby it just left, and the notices follow the rules literally.
    const lobby = this.placeInLobby();
    this.enterRoom(client, lobby);
    this.sendRoomState(client, lobby, null);
    this.finishRoomChange();
  }

  kick(client, frame) {
    const name = checkScreenName(frame.screen_name);
    if (name === null) return this.fail(client, 'kick', 'invalid_field', TEXT.screenName, 'screen_name');
    const room = client.room;
    if (room.kind !== 'member' || room.host !== client) {
      return this.fail(client, 'kick', 'not_host', null, 'screen_name');
    }
    const key = name.toLowerCase();
    if (key === client.key) return this.fail(client, 'kick', 'invalid_target', TEXT.self, 'screen_name');
    const target = this.online.get(key);
    if (!target || target.room !== room) {
      return this.fail(client, 'kick', 'invalid_target', TEXT.notInRoom, 'screen_name');
    }

    this.departRoom(target, 'kicked');
    this.send(target, { type: 'room_left', room: room.name, reason: 'kicked' });
    const lobby = this.placeInLobby();
    this.enterRoom(target, lobby);
    this.sendRoomState(target, lobby, null);
    this.finishRoomChange();
  }

  // ---- messages --------------------------------------------------------

  say(client, frame) {
    if (typeof frame.text !== 'string') {
      return this.fail(client, 'say', 'invalid_field', TEXT.messageText, 'text');
    }
    const text = normalize(frame.text);
    if (text === '') return undefined; // Accepted and ignored (rule 7.6).
    if (codePointCount(text) > TEXT_MAX) return this.fail(client, 'say', 'text_too_long', TEXT.messageLength, 'text');
    const fmt = parseFormat(frame.fmt);
    if (!fmt.ok) return this.fail(client, 'say', 'invalid_field', TEXT.format, fmt.field);

    const { room } = client;
    const out = { type: 'room_message', room: room.name, from: client.name, text, fmt: fmt.value, ts: this.now() };
    this.broadcastMessage(client, room, out);
    return undefined;
  }

  broadcastMessage(client, room, out) {
    for (const member of room.members) {
      // Ignored senders are dropped for the ignoring member only. The sender always sees its own messages.
      if (member === client || !member.ignores.has(client.key)) this.send(member, out);
    }
  }

  artCommand(client, frame) {
    const value = frame.name === undefined ? '' : normalize(frame.name);
    if (value === null) return this.fail(client, 'art', 'invalid_field', 'Choose an art name.', 'name');
    const name = value.toLowerCase() === 'middlefinger' ? 'finger' : value.toLowerCase();
    if (['', 'list', 'help'].includes(name)) {
      return this.send(client, {
        type: 'art_status', state: 'catalog', interval_ms: ART_INTERVAL_MS,
        pieces: Object.entries(ART).map(([name, piece]) => ({ name, ...piece })),
      });
    }
    if (name === 'stop') {
      this.art.cancel(client);
      return this.send(client, { type: 'art_status', state: 'stopped' });
    }
    if (!Object.hasOwn(ART, name)) {
      return this.fail(client, 'art', 'invalid_field', 'Try /art skull, finger, banner, divider or stop.', 'name');
    }
    if (this.art.jobs.has(client)) return this.fail(client, 'art', 'art_busy');
    const room = client.room;
    this.send(client, { type: 'art_status', state: 'started', name, interval_ms: ART_INTERVAL_MS });
    this.art.start(client, name, (text, art) => {
      this.broadcastMessage(client, room, {
        type: 'room_message', room: room.name, from: client.name, text, fmt: null, art, ts: this.now(),
      });
    }, () => this.send(client, { type: 'art_status', state: 'finished', name }));
  }

  im(client, frame) {
    const to = checkScreenName(frame.to);
    if (to === null) return this.fail(client, 'im', 'invalid_field', TEXT.screenName, 'to');
    if (typeof frame.text !== 'string') return this.fail(client, 'im', 'invalid_field', TEXT.messageText, 'text');
    const text = normalize(frame.text);
    if (text === '') return undefined; // Accepted and ignored (rule 7.6).
    if (codePointCount(text) > TEXT_MAX) return this.fail(client, 'im', 'text_too_long', TEXT.messageLength, 'text');
    const fmt = parseFormat(frame.fmt);
    if (!fmt.ok) return this.fail(client, 'im', 'invalid_field', TEXT.format, fmt.field);

    const key = to.toLowerCase();
    if (key === client.key) return this.fail(client, 'im', 'invalid_target', TEXT.self, 'to');
    const target = this.online.get(key);
    if (!target) return this.fail(client, 'im', 'recipient_offline', null, 'to');

    // Rule 12.2 with frame order from rule O8: im to target, im_sent to sender, then the automatic reply.
    const ignored = target.ignores.has(client.key);
    const ts = this.now();
    if (!ignored) {
      this.send(target, { type: 'im', from: client.name, text, fmt: fmt.value, ts, auto_reply: false });
    }
    this.send(client, { type: 'im_sent', to: target.name, text, fmt: fmt.value, ts });
    if (!ignored && target.away !== '') {
      this.send(client, { type: 'im', from: target.name, text: target.away, fmt: null, ts: this.now(), auto_reply: true });
    }
    return undefined;
  }

  setAway(client, frame) {
    if (typeof frame.message !== 'string') return this.fail(client, 'set_away', 'invalid_field', TEXT.awayText, 'message');
    const message = normalize(frame.message);
    if (codePointCount(message) > AWAY_MAX) {
      return this.fail(client, 'set_away', 'text_too_long', TEXT.awayLength, 'message');
    }
    client.away = message;
    return this.send(client, { type: 'away_status', message });
  }

  // ---- profiles ----------------------------------------------------------

  getProfile(client, frame) {
    const name = checkScreenName(frame.screen_name);
    if (name === null) return this.fail(client, 'get_profile', 'invalid_field', TEXT.screenName, 'screen_name');
    const online = this.online.get(name.toLowerCase());
    if (online) {
      return this.send(client, { type: 'profile', screen_name: online.name, signed_on: true, ...online.profile });
    }
    return this.send(client, {
      type: 'profile',
      screen_name: name,
      signed_on: false,
      location: '',
      hobbies: '',
      quote: '',
    });
  }

  setProfile(client, frame) {
    const profile = {};
    for (const field of ['location', 'hobbies', 'quote']) {
      const raw = frame[field];
      if (raw === undefined) {
        profile[field] = ''; // Absent means empty (rule 2.2).
        continue;
      }
      const value = normalize(raw);
      if (value === null) return this.fail(client, 'set_profile', 'invalid_field', TEXT.profileText, field);
      if (codePointCount(value) > PROFILE_FIELD_MAX) {
        return this.fail(client, 'set_profile', 'invalid_field', TEXT.profileLength, field);
      }
      profile[field] = value;
    }
    client.profile = profile;
    return this.send(client, { type: 'profile', screen_name: client.name, signed_on: true, ...profile });
  }

  // ---- buddies and ignore -------------------------------------------------

  buddyList(client) {
    const buddies = [...client.buddies].map(([key, name]) => ({
      screen_name: name,
      online: this.online.has(key),
    }));
    return { type: 'buddy_list', buddies };
  }

  buddyAdd(client, frame) {
    const name = checkScreenName(frame.screen_name);
    if (name === null) return this.fail(client, 'buddy_add', 'invalid_field', TEXT.screenName, 'screen_name');
    const key = name.toLowerCase();
    if (key === client.key) return this.fail(client, 'buddy_add', 'invalid_target', TEXT.self, 'screen_name');
    // Adding a name already in the list changes nothing and keeps the casing first typed (rule 2.2).
    if (!client.buddies.has(key)) {
      if (client.buddies.size >= BUDDY_MAX) return this.fail(client, 'buddy_add', 'buddy_limit', null, 'screen_name');
      client.buddies.set(key, name);
    }
    return this.send(client, this.buddyList(client));
  }

  buddyRemove(client, frame) {
    const name = checkScreenName(frame.screen_name);
    if (name === null) return this.fail(client, 'buddy_remove', 'invalid_field', TEXT.screenName, 'screen_name');
    client.buddies.delete(name.toLowerCase());
    return this.send(client, this.buddyList(client));
  }

  ignore(client, frame) {
    const name = checkScreenName(frame.screen_name);
    if (name === null) return this.fail(client, 'ignore', 'invalid_field', TEXT.screenName, 'screen_name');
    if (typeof frame.on !== 'boolean') return this.fail(client, 'ignore', 'invalid_field', TEXT.onFlag, 'on');
    const key = name.toLowerCase();
    if (key === client.key) return this.fail(client, 'ignore', 'invalid_target', TEXT.self, 'screen_name');

    if (frame.on && !client.ignores.has(key) && client.ignores.size >= IGNORE_MAX) {
      return this.fail(client, 'ignore', 'ignore_limit', null, 'screen_name');
    }
    if (frame.on) client.ignores.add(key);
    else client.ignores.delete(key);
    return this.send(client, {
      type: 'ignore_status',
      screen_name: this.displayName(key, name),
      ignored: frame.on,
    });
  }

  // ---- reports ------------------------------------------------------------

  report(client, frame) {
    const name = checkScreenName(frame.screen_name);
    if (name === null) return this.fail(client, 'report', 'invalid_field', TEXT.screenName, 'screen_name');
    const key = name.toLowerCase();
    if (key === client.key) return this.fail(client, 'report', 'invalid_target', TEXT.self, 'screen_name');

    // The incident holds only the reported name and the time. The reporter and message text are never recorded.
    const reported = this.displayName(key, name);
    const time = new Date(this.now()).toISOString();
    this.incidents.add({ screen_name: reported, time });
    this.logger.log(`Report filed: ${reported} at ${time}`);
    return this.send(client, { type: 'report_ack', screen_name: reported });
  }

  // ---- idle timer (PROTOCOL.md section 9) -------------------------------------

  startIdle(client) {
    this.stopIdle(client);
    client.idleTimer = setTimeout(() => this.onIdle(client), minutesToMs(this.config.idleMinutes));
  }

  noteActivity(client) {
    if (!client.signedOn) return;
    if (client.graceTimer) {
      clearTimeout(client.graceTimer);
      client.graceTimer = null;
    }
    this.startIdle(client);
  }

  onIdle(client) {
    client.idleTimer = null;
    if (!client.signedOn) return;
    const graceSeconds = Math.ceil(this.config.graceMinutes * 60);
    this.send(client, { type: 'idle_warning', grace_seconds: graceSeconds });
    client.graceTimer = setTimeout(() => this.onGraceExpired(client), minutesToMs(this.config.graceMinutes));
  }

  onGraceExpired(client) {
    client.graceTimer = null;
    this.endSession(client, 'idle');
  }

  stopIdle(client) {
    if (client.idleTimer) clearTimeout(client.idleTimer);
    if (client.graceTimer) clearTimeout(client.graceTimer);
    client.idleTimer = null;
    client.graceTimer = null;
  }

  // ---- shutdown (PROTOCOL.md section 10) ------------------------------------

  shutdown() {
    if (this.closing) return;
    this.closing = true;
    this.art.shutdown();
    for (const client of this.online.values()) {
      this.stopIdle(client);
      this.send(client, { type: 'signed_off', reason: 'server_shutdown' });
    }
    for (const client of this.sockets) {
      this.stopIdle(client);
      client.ws.close(1001, 'server shutting down');
    }
  }
}

module.exports = { ChatHub, parseFrame };
