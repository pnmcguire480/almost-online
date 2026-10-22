'use strict';

// Shared constants, value rules and frame helpers from docs/PROTOCOL.md (sections 2, 4 and 7).

const FRAME_MAX_BYTES = 4096;
const TEXT_MAX = 250;
const AWAY_MAX = 120;
const PROFILE_FIELD_MAX = 60;
const ROOM_NAME_MAX = 24;
const BUDDY_MAX = 50;
const IGNORE_MAX = 100;
const MEMBER_ROOM_CAPACITY = 23;
const ERROR_REF_MAX = 40;

// Per-connection inbound rate limit (token bucket). Server addendum A1 in PROTOCOL.md.
const RATE_BURST = 20;
const RATE_PER_SECOND = 5;

const SCREEN_NAME_RE = /^[A-Za-z0-9]{3,10}$/;
const ROOM_NAME_RE = /^[A-Za-z0-9 '!.\-]{1,24}$/;
const RESERVED_ROOM_RE = /^lobby [1-9][0-9]*$/i;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g;

// The 16 Windows VGA colours (PROTOCOL.md section 2.3). Stored uppercase.
const PALETTE = Object.freeze([
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#C0C0C0',
  '#808080', '#FF0000', '#00FF00', '#FFFF00', '#0000FF', '#FF00FF', '#00FFFF', '#FFFFFF',
]);

const TEXT = Object.freeze({
  screenName: 'Screen names are 3 to 10 letters or numbers.',
  roomName: "Room names are 1 to 24 letters, numbers, spaces, or these marks: ' ! . -",
  messageText: 'Message text is missing or is not text.',
  messageLength: 'Messages can be at most 250 characters.',
  awayText: 'The away message is missing or is not text.',
  awayLength: 'Away messages can be at most 120 characters.',
  format: 'Formatting must be an object with true or false for b, i and u.',
  color: 'Color must be one of the 16 colors in the palette, or null.',
  profileText: 'Profile fields must be text.',
  profileLength: 'Profile fields can be at most 60 characters.',
  onFlag: 'On must be true or false.',
  self: 'You cannot do that to yourself.',
  notInRoom: 'That person is not in this room.',
});

// Standard messages from PROTOCOL.md section 7.4.
const ERROR_TEXT = Object.freeze({
  bad_frame: 'That message could not be read.',
  unknown_type: 'The server does not know that request.',
  not_signed_on: 'Sign on first.',
  already_signed_on: 'You are already signed on.',
  invalid_field: 'That value is not allowed.',
  name_taken: 'That screen name is already signed on. Try another.',
  text_too_long: 'Messages can be at most 250 characters.',
  room_name_reserved: 'Names like Lobby 1 are reserved for public lobbies.',
  room_name_taken: 'A room with that name is already open.',
  no_such_room: 'That room is no longer open.',
  room_full: 'That room is full. Try another room.',
  recipient_offline: 'That screen name is not signed on.',
  invalid_target: 'You cannot do that to yourself.',
  buddy_limit: 'Your buddy list is full.',
  ignore_limit: 'Your ignore list is full.',
  not_host: 'Only the host can do that.',
  rate_limited: 'You are sending messages too fast. Wait a moment.',
  art_busy: 'A scroll is already printing. Use /art stop first.',
  internal_error: 'Something went wrong on the server.',
});

// Trims per PROTOCOL.md 2.1: control characters become spaces, then JS trim.
// Returns null when the value is not a string.
function normalize(value) {
  if (typeof value !== 'string') return null;
  return value.replace(CONTROL_CHARS_RE, ' ').trim();
}

function codePointCount(text) {
  return [...text].length;
}

// Returns the normalized screen name, or null when it breaks the rule.
function checkScreenName(value) {
  const name = normalize(value);
  return name !== null && SCREEN_NAME_RE.test(name) ? name : null;
}

// Returns the normalized room name, or null when it breaks the rule (reserved names are checked separately).
function checkRoomName(value) {
  const name = normalize(value);
  return name !== null && ROOM_NAME_RE.test(name) ? name : null;
}

function isReservedRoomName(name) {
  return RESERVED_ROOM_RE.test(name);
}

// Parses an optional `fmt` value (PROTOCOL.md 2.3).
// Returns { ok: true, value } where value is null for plain text, or { ok: false, field }.
function parseFormat(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, field: 'fmt' };

  const flags = {};
  for (const key of ['b', 'i', 'u']) {
    const flag = raw[key];
    if (flag === undefined) flags[key] = false;
    else if (typeof flag === 'boolean') flags[key] = flag;
    else return { ok: false, field: 'fmt' };
  }

  let color = null;
  if (raw.color !== undefined && raw.color !== null) {
    if (typeof raw.color !== 'string') return { ok: false, field: 'fmt.color' };
    const upper = normalize(raw.color).toUpperCase();
    if (!PALETTE.includes(upper)) return { ok: false, field: 'fmt.color' };
    color = upper;
  }

  if (!flags.b && !flags.i && !flags.u && color === null) return { ok: true, value: null };
  return { ok: true, value: { b: flags.b, i: flags.i, u: flags.u, color } };
}

// The `ref` of an error is the request type, cut to 40 characters (PROTOCOL.md 7.4).
function refFor(type) {
  if (typeof type !== 'string') return null;
  return [...type].slice(0, ERROR_REF_MAX).join('');
}

function makeError(code, message, ref, field) {
  return {
    type: 'error',
    code,
    message: message || ERROR_TEXT[code],
    ref: ref ?? null,
    field: field ?? null,
  };
}

// Sorts screen names and room names case-insensitively (ASCII rules).
function byNameIgnoringCase(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

module.exports = {
  FRAME_MAX_BYTES,
  TEXT_MAX,
  AWAY_MAX,
  PROFILE_FIELD_MAX,
  ROOM_NAME_MAX,
  BUDDY_MAX,
  IGNORE_MAX,
  MEMBER_ROOM_CAPACITY,
  RATE_BURST,
  RATE_PER_SECOND,
  PALETTE,
  TEXT,
  ERROR_TEXT,
  normalize,
  codePointCount,
  checkScreenName,
  checkRoomName,
  isReservedRoomName,
  parseFormat,
  refFor,
  makeError,
  byNameIgnoringCase,
};
