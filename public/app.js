/* Chat Room '96: browser client.
 * Plain JavaScript, no framework, no build step. Speaks the wire contract in docs/PROTOCOL.md.
 * Every piece of server or user text goes onto the page with textContent or createTextNode.
 * innerHTML is never used. Rich text is built from span elements with style properties only.
 */
(function () {
  'use strict';

  // ---------- Constants (PROTOCOL.md sections 2 and 4) ----------
  var PALETTE = ['#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#C0C0C0',
                 '#808080', '#FF0000', '#00FF00', '#FFFF00', '#0000FF', '#FF00FF', '#00FFFF', '#FFFFFF'];
  var PALETTE_NAMES = ['Black', 'Maroon', 'Green', 'Olive', 'Navy', 'Purple', 'Teal', 'Silver',
                       'Gray', 'Red', 'Lime', 'Yellow', 'Blue', 'Fuchsia', 'Aqua', 'White'];
  var SMILEYS = [
    { code: ':)', glyph: '☺', name: 'Smile' },
    { code: ':(', glyph: '☹', name: 'Frown' },
    { code: ';)', glyph: '\u{1F609}', name: 'Wink' },
    { code: ':D', glyph: '\u{1F603}', name: 'Big grin' },
    { code: ':P', glyph: '\u{1F61B}', name: 'Tongue' }
  ];
  var GLYPH = {};
  SMILEYS.forEach(function (s) { GLYPH[s.code] = s.glyph; });

  var TEXT_MAX = 250, AWAY_MAX = 120, PROFILE_MAX = 60, BUDDY_MAX = 50, FRAME_MAX = 4096;
  var SN_RE = /^[A-Za-z0-9]{3,10}$/;
  var ROOM_RE = /^[A-Za-z0-9 '!.\-]{1,24}$/;
  var SN_RULE = 'Screen names are 3 to 10 letters or numbers.';
  var ROOM_RULE = 'Room names are 1 to 24 letters, numbers, spaces, apostrophes, periods, exclamation marks or hyphens.';
  var GREEN = '#008000', NAVY = '#000080', MAROON = '#800000';

  var ERRORS = {
    bad_frame: ['Bad Frame', 'That message could not be read.'],
    unknown_type: ['Unknown Request', 'The server does not know that request.'],
    not_signed_on: ['Not Signed On', 'Sign on first.'],
    already_signed_on: ['Already Signed On', 'You are already signed on.'],
    invalid_field: ['Invalid Entry', 'That entry is not valid.'],
    name_taken: ['Name Taken', 'That screen name is already signed on. Try another.'],
    text_too_long: ['Message Too Long', 'Messages can be at most 250 characters.'],
    room_name_reserved: ['Name Reserved', 'Names like Lobby 1 are reserved for public lobbies.'],
    room_name_taken: ['Room Name Taken', 'A room with that name is already open.'],
    no_such_room: ['No Such Room', 'That room is no longer open.'],
    room_full: ['Room Full', 'That room is full. Try another room.'],
    recipient_offline: ['Not Signed On', 'That screen name is not signed on.'],
    invalid_target: ['Invalid Target', 'You cannot do that to yourself.'],
    buddy_limit: ['Buddy List Full', 'Your buddy list is full.'],
    ignore_limit: ['Ignore List Full', 'Your ignore list is full.'],
    not_host: ['Not Host', 'Only the host can do that.'],
    not_supported: ['Not Supported', 'This server does not support that.'],
    rate_limited: ['Slow Down', 'You are sending messages too fast. Wait a moment.'],
    art_busy: ['Scroller Busy', 'A scroll is already printing. Use /art stop first.'],
    internal_error: ['Server Error', 'Something went wrong on the server.']
  };

  // ---------- Small helpers ----------
  function norm(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    return s.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim();
  }
  function cpLen(s) { return Array.from(s).length; }
  function lower(s) { return String(s || '').toLowerCase(); }
  function sameName(a, b) { return lower(a) === lower(b); }
  function sortNames(list) {
    return list.slice().sort(function (a, b) {
      var x = lower(a), y = lower(b);
      return x < y ? -1 : (x > y ? 1 : 0);
    });
  }
  function utf8Len(s) { return new TextEncoder().encode(s).length; }
  function validColor(c) {
    if (typeof c !== 'string') return null;
    var u = c.toUpperCase();
    return PALETTE.indexOf(u) >= 0 ? u : null;
  }

  // h(tag, props, ...children). Children may be nodes, strings, numbers or arrays.
  function h(tag, props) {
    var kids = Array.prototype.slice.call(arguments, 2);
    if (props !== null && props !== undefined &&
        (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
      kids.unshift(props);
      props = null;
    }
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = String(v);
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'style') Object.keys(v).forEach(function (s) { el.style[s] = v[s]; });
        else if (k === 'value') el.value = String(v);
        else if (k === 'readonly') el.readOnly = true;
        else if (k === 'disabled') el.disabled = true;
        else if (k === 'hidden') el.hidden = true;
        else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    appendKids(el, kids);
    return el;
  }
  function appendKids(el, kids) {
    kids.forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) appendKids(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    });
  }
  function btn(label, fn, extra, type) {
    var props = { class: 'btn' + (extra ? ' ' + extra : ''), type: type || 'button' };
    if (typeof fn === 'function') props.onclick = fn;
    return h('button', props, label);
  }
  function fieldRow(label) {
    var kids = Array.prototype.slice.call(arguments, 1);
    return h('div', { class: 'field' }, h('label', { text: label }), kids);
  }

  // ---------- Desktop and window manager ----------
  var desktop = document.getElementById('desktop');
  var tasksEl = document.getElementById('tasks');
  var connEl = document.getElementById('conn');

  var WM = { z: 10, wins: [], cascade: 0, dialogs: 0 };

  function isNarrow() { return window.matchMedia('(max-width: 640px)').matches; }

  function topWin() {
    var top = null;
    WM.wins.forEach(function (w) {
      if (!w.minimized && (!top || w.z > top.z)) top = w;
    });
    return top;
  }

  function refreshActive() {
    var top = topWin();
    WM.wins.forEach(function (w) {
      w.el.classList.toggle('inactive', w !== top);
      if (w.taskBtn) w.taskBtn.classList.toggle('on', w === top);
    });
  }

  function raise(win) {
    if (win.closed) return;
    if (win.minimized) {
      win.minimized = false;
      win.el.classList.remove('min');
    }
    WM.z += 1;
    win.z = WM.z;
    win.el.style.zIndex = String(WM.z);
    refreshActive();
  }

  function minimizeWin(win) {
    if (win.closed || win.minimized) return;
    win.minimized = true;
    win.el.classList.add('min');
    refreshActive();
  }

  function taskClick(win) {
    if (win.minimized) raise(win);
    else if (topWin() === win) minimizeWin(win);
    else raise(win);
  }

  function closeWin(win) {
    if (!win || win.closed) return;
    win.closed = true;
    WM.wins = WM.wins.filter(function (w) { return w !== win; });
    if (win.el.parentNode) win.el.parentNode.removeChild(win.el);
    if (win.taskBtn && win.taskBtn.parentNode) win.taskBtn.parentNode.removeChild(win.taskBtn);
    refreshActive();
    if (win.onClose) win.onClose(win);
  }

  function setTitle(win, text) {
    win.titleEl.textContent = text;
    if (win.taskBtn) { win.taskBtn.textContent = text; win.taskBtn.title = text; }
  }

  function startDrag(ev, win) {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    var sx = ev.clientX, sy = ev.clientY, ox = win.el.offsetLeft, oy = win.el.offsetTop;
    function move(e) {
      var maxX = desktop.clientWidth - 40, maxY = desktop.clientHeight - 20;
      var nx = Math.min(maxX, Math.max(40 - win.el.offsetWidth, ox + e.clientX - sx));
      var ny = Math.min(maxY, Math.max(0, oy + e.clientY - sy));
      win.el.style.left = nx + 'px';
      win.el.style.top = ny + 'px';
    }
    function up() {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  function startResize(ev, win) {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    var sx = ev.clientX, sy = ev.clientY, ow = win.el.offsetWidth, oh = win.el.offsetHeight;
    function move(e) {
      win.el.style.width = Math.max(300, ow + e.clientX - sx) + 'px';
      win.el.style.height = Math.max(200, oh + e.clientY - sy) + 'px';
    }
    function up() {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  // o: {title, kind: 'app'|'dialog', cls, w, h, x, y, center, resizable, closable, minable, noTask, body, onClose}
  function makeWin(o) {
    var win = {
      kind: o.kind || 'app', z: 0, minimized: false, closed: false,
      closable: o.closable !== false, onClose: o.onClose || null
    };
    var titleEl = h('span', { class: 'titletext', text: o.title || '' });
    var bar = h('div', { class: 'titlebar' }, titleEl);
    if (o.minable) {
      bar.appendChild(h('button', {
        class: 'capbtn', type: 'button', title: 'Minimize', 'aria-label': 'Minimize',
        onclick: function (ev) { ev.stopPropagation(); minimizeWin(win); }
      }, '_'));
    }
    if (win.closable) {
      bar.appendChild(h('button', {
        class: 'capbtn', type: 'button', title: 'Close', 'aria-label': 'Close',
        onclick: function (ev) { ev.stopPropagation(); closeWin(win); }
      }, 'x'));
    }
    var body = h('div', { class: 'winbody' }, o.body || []);
    var kids = [bar, body];
    if (o.resizable) {
      kids.push(h('div', { class: 'grip', title: 'Drag to resize', onpointerdown: function (ev) { startResize(ev, win); } }));
    }
    var el = h('div', { class: 'win ' + win.kind + (o.cls ? ' ' + o.cls : '') }, kids);
    if (o.w) el.style.width = o.w + 'px';
    if (o.h) el.style.height = o.h + 'px';
    win.el = el;
    win.titleEl = titleEl;
    win.body = body;
    desktop.appendChild(el);

    var dw = desktop.clientWidth, dh = desktop.clientHeight;
    var ww = el.offsetWidth, hh = el.offsetHeight;
    var x, y;
    if (typeof o.x === 'number') {
      x = o.x; y = o.y || 0;
    } else if (win.kind === 'dialog' || o.center) {
      var off = (WM.dialogs % 5) * 18;
      WM.dialogs += 1;
      x = (dw - ww) / 2 + off;
      y = (dh - hh) / 2 + off - 20;
    } else {
      var n = WM.cascade % 8;
      WM.cascade += 1;
      x = 20 + n * 24;
      y = 14 + n * 20;
    }
    el.style.left = Math.max(0, Math.round(x)) + 'px';
    el.style.top = Math.max(0, Math.round(y)) + 'px';

    bar.addEventListener('pointerdown', function (ev) {
      if (ev.target.closest && ev.target.closest('.capbtn')) return;
      if (!isNarrow()) startDrag(ev, win);
    });
    el.addEventListener('pointerdown', function () { raise(win); }, true);

    if (win.kind === 'app' && !o.noTask) {
      win.taskBtn = h('button', {
        class: 'taskbtn', type: 'button', title: o.title || '',
        onclick: function () { taskClick(win); }
      }, o.title || '');
      tasksEl.appendChild(win.taskBtn);
    }
    WM.wins.push(win);
    raise(win);
    return win;
  }

  // Message box. opts: {icon: 'error'|'info'|'warn'|'question', buttons: [{label, primary, onClick}], onClose, closable, w}
  function dialog(title, message, opts) {
    opts = opts || {};
    var icon = opts.icon || 'info';
    var glyph = icon === 'question' ? '?' : (icon === 'info' ? 'i' : '!');
    var specs = opts.buttons || [{ label: 'OK', primary: true }];
    var win = null;
    var els = specs.map(function (b) {
      return h('button', {
        class: 'btn' + (b.primary ? ' default' : ''), type: 'button',
        onclick: function () { closeWin(win); if (b.onClick) b.onClick(); }
      }, b.label);
    });
    win = makeWin({
      title: title, kind: 'dialog', cls: 'dlgwin', w: opts.w || 300,
      closable: opts.closable !== false, onClose: opts.onClose || null,
      body: [
        h('div', { class: 'dlg' },
          h('div', { class: 'dlgicon ' + icon, text: glyph }),
          h('div', { class: 'dlgmsg', text: message })),
        h('div', { class: 'btnrow' }, els)
      ]
    });
    var primary = els.filter(function (b) { return b.classList.contains('default'); })[0] || els[0];
    if (primary) primary.focus();
    return win;
  }

  // ---------- Sound (WebAudio, synthesized, no audio files) ----------
  var audioCtx = null;
  var CHIME = {
    arrive: [[987.77, 0, 0.32, 0.16, 'sine'], [659.25, 0.24, 0.55, 0.16, 'sine']],
    leave: [[659.25, 0, 0.32, 0.16, 'sine'], [493.88, 0.24, 0.55, 0.16, 'sine']],
    ding: [[1760, 0, 0.45, 0.2, 'triangle'], [2637, 0.07, 0.6, 0.14, 'triangle']],
    buddy: [[1046.5, 0, 0.16, 0.16, 'sine'], [1318.5, 0.17, 0.4, 0.16, 'sine']]
  };

  // Called only from user gestures, so browsers allow audio.
  function unlockAudio() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
      return;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { audioCtx = new AC(); } catch (e) { audioCtx = null; }
  }

  function tone(freq, start, dur, vol, type) {
    var ctx = audioCtx;
    var t0 = ctx.currentTime + start;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // Checks the mute flag before any oscillator is created.
  function play(name) {
    if (!S.sound || !audioCtx || audioCtx.state !== 'running') return;
    var notes = CHIME[name];
    if (!notes) return;
    notes.forEach(function (n) { tone(n[0], n[1], n[2], n[3], n[4]); });
  }

  // ---------- State ----------
  var S = {
    connState: 'connecting', // 'connecting' | 'open' | 'down'
    signedOn: false, signingOn: false, me: '', lastName: '',
    room: null, rooms: [], selRoom: null,
    buddies: [], selBuddy: null,
    ignored: {}, away: '', selPerson: null,
    // Requests that carry typed text, oldest first. Each entry is removed when the server answers it (see refused()).
    pendingSay: [], pendingIM: [], pendingBuddy: [], pendingProfile: [], pendingCreate: null,
    sound: true
  };
  var UI = { signon: null, chat: null, rooms: null, buddies: null, away: null, edit: null, idle: null, ims: {}, infos: {} };

  function loadPrefs() {
    try {
      if (window.localStorage.getItem('cr96.sound') === 'off') S.sound = false;
    } catch (e) { /* storage blocked: the setting lasts for this page only */ }
  }
  function saveSound() {
    try { window.localStorage.setItem('cr96.sound', S.sound ? 'on' : 'off'); } catch (e) { /* blocked */ }
  }

  // ---------- Connection ----------
  var ws = null, retryTimer = null, tickTimer = null, retryAt = 0, attempt = 0;

  // ---------- Pacing (PROTOCOL.md addendum A1) ----------
  // The server lets each connection send a burst of 20 frames, then 5 per second, and drops frames over that.
  // This copy of the same bucket stops the browser from sending a frame the server would drop. It reads the
  // browser's monotonic clock, so a change to the time of day cannot stall it.
  var PACE_BURST = 20, PACE_PER_SECOND = 5;
  var pace = { tokens: PACE_BURST, last: 0 };
  var slowNoticeAt = -Infinity;

  function nowMs() { return window.performance.now(); }

  function resetPace() {
    pace.tokens = PACE_BURST;
    pace.last = nowMs();
  }

  function takePaceToken() {
    var t = nowMs();
    pace.tokens = Math.min(PACE_BURST, pace.tokens + Math.max(0, t - pace.last) * PACE_PER_SECOND / 1000);
    pace.last = t;
    if (pace.tokens < 1) return false;
    pace.tokens -= 1;
    return true;
  }

  // Shows the "too fast" notice once a second at most, however many frames were refused.
  function slowDown() {
    var t = nowMs();
    if (t - slowNoticeAt < 1000) return;
    slowNoticeAt = t;
    dialog(ERRORS.rate_limited[0], ERRORS.rate_limited[1], { icon: 'error' });
  }

  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }

  function setConn() {
    var text;
    if (S.connState === 'open') {
      text = S.signedOn ? 'Signed on as ' + S.me : 'Connected';
    } else if (S.connState === 'connecting') {
      text = 'Connecting...';
    } else {
      var left = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      text = 'Disconnected' + (retryAt ? ' - retrying in ' + left + 's' : '');
    }
    connEl.textContent = text;
    connEl.className = 'sunken ' + S.connState;
  }

  function stopTick() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function scheduleRetry() {
    var secs = Math.min(30, Math.pow(2, attempt));
    attempt += 1;
    S.connState = 'down';
    retryAt = Date.now() + secs * 1000;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, secs * 1000);
    if (!tickTimer) tickTimer = setInterval(setConn, 1000);
    setConn();
  }

  function connect() {
    retryAt = 0;
    S.connState = 'connecting';
    resetPace(); // A new connection starts with a full burst on the server, so the mirror starts full too.
    setConn();
    var sock;
    try {
      sock = new WebSocket(wsUrl());
    } catch (e) {
      scheduleRetry();
      return;
    }
    ws = sock;
    sock.onopen = function () {
      if (ws !== sock) return;
      attempt = 0;
      retryAt = 0;
      S.connState = 'open';
      stopTick();
      setConn();
    };
    sock.onmessage = function (ev) {
      if (ws === sock) onFrame(ev.data);
    };
    sock.onclose = function (ev) {
      if (ws !== sock) return;
      ws = null;
      S.connState = 'down';
      var wasSignedOn = S.signedOn;
      resetSession();
      openSignOn();
      if (ev.code === 1009) {
        dialog('Message Too Long', 'Your message was too long.', { icon: 'error' });
      } else if (wasSignedOn) {
        dialog('Connection Lost', 'Connection lost. Sign on again when the server is back.', { icon: 'error' });
      }
      scheduleRetry();
    };
    sock.onerror = function () { /* onclose follows */ };
  }

  function send(obj) {
    var text = JSON.stringify(obj);
    if (utf8Len(text) > FRAME_MAX) {
      dialog('Message Too Long', 'Your message was too long.', { icon: 'error' });
      return false;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      dialog('Not Connected', 'You are not connected to the server. Trying again.', { icon: 'error' });
      return false;
    }
    // Refused here, nothing is sent and the caller keeps what the user typed.
    if (!takePaceToken()) {
      slowDown();
      return false;
    }
    ws.send(text);
    return true;
  }

  function onFrame(data) {
    if (typeof data !== 'string') return;
    var f;
    try { f = JSON.parse(data); } catch (e) { return; }
    if (!f || typeof f !== 'object' || typeof f.type !== 'string') return;
    if (Object.prototype.hasOwnProperty.call(HANDLERS, f.type)) HANDLERS[f.type](f);
  }

  // ---------- Session reset and sign on / off ----------
  function resetSession() {
    S.signingOn = false;
    S.signedOn = false;
    S.me = '';
    S.room = null;
    S.rooms = [];
    S.selRoom = null;
    S.buddies = [];
    S.selBuddy = null;
    S.ignored = {};
    S.away = '';
    S.pendingSay = [];
    S.pendingIM = [];
    S.pendingBuddy = [];
    S.pendingProfile = [];
    S.pendingCreate = null;
    S.selPerson = null;
    WM.wins.slice().forEach(function (w) {
      if (UI.signon && w === UI.signon.win) return;
      closeWin(w);
    });
    UI.chat = null;
    UI.art = null;
    UI.rooms = null;
    UI.buddies = null;
    UI.away = null;
    UI.edit = null;
    UI.idle = null;
    UI.ims = {};
    UI.infos = {};
    setConn();
  }

  function openSignOn() {
    if (UI.signon) {
      raise(UI.signon.win);
      UI.signon.input.focus();
      return;
    }
    var input = h('input', { type: 'text', id: 'screenname', class: 'inp', autocomplete: 'off',
      value: S.lastName, 'aria-label': 'Screen name' });
    var ui = { input: input };
    var form = h('form', {
      class: 'signform',
      onsubmit: function (ev) { ev.preventDefault(); signOn(ui); }
    },
      h('img', { class: 'signon-logo', src: 'almost-online.png', alt: 'A0L — Almost Online' }),
      h('p', { class: 'hdr', text: 'Welcome to Almost Online!' }),
      h('p', { class: 'signon-tagline', text: "You've got nostalgia." }),
      h('p', { class: 'hint', text: 'Type your screen name, then press Sign On. ' + SN_RULE }),
      fieldRow('Screen Name:', input),
      h('div', { class: 'btnrow' }, btn('Sign On', null, 'default', 'submit'))
    );
    ui.win = makeWin({
      title: 'Almost Online — Sign On', kind: 'app', cls: 'signon', w: 400, center: true,
      closable: false, minable: false, noTask: true,
      body: [form],
      onClose: function () { UI.signon = null; }
    });
    UI.signon = ui;
    input.focus();
  }

  function signOn(ui) {
    unlockAudio();
    var name = norm(ui.input.value);
    if (!SN_RE.test(name)) {
      dialog('Invalid Entry', SN_RULE, {
        icon: 'error',
        onClose: function () { if (UI.signon) UI.signon.input.focus(); }
      });
      ui.input.focus();
      return;
    }
    if (S.connState !== 'open') {
      dialog('Not Connected', 'The server is not reachable yet. Trying again.', { icon: 'error' });
      return;
    }
    if (S.signingOn) return;
    S.lastName = name;
    S.signingOn = true;
    if (!send({ type: 'sign_on', screen_name: name })) S.signingOn = false;
  }

  function signOff() {
    if (S.signedOn) send({ type: 'sign_off' });
  }

  // ---------- Chat window ----------
  function openChat() {
    if (UI.chat) {
      raise(UI.chat.win);
      return UI.chat;
    }
    var ui = {};
    ui.log = h('div', { class: 'log sunken', role: 'log', 'aria-live': 'polite' });
    ui.peopleHead = h('div', { class: 'peoplehead', text: 'People (0)' });
    ui.people = h('div', { class: 'people sunken', role: 'listbox', tabindex: '0', 'aria-label': 'People in this room' });
    ui.btnIM = btn('IM', function () { personAction('im'); });
    ui.btnInfo = btn('Get Info', function () { personAction('info'); });
    ui.btnIgnore = btn('Ignore', function () { personAction('ignore'); });
    ui.btnReport = btn('Report', function () { personAction('report'); });
    ui.btnKick = btn('Kick', function () { personAction('kick'); });
    ui.btnKick.hidden = true;
    ui.btnMine = btn('My Profile', openEdit);
    ui.soundBtn = btn(S.sound ? 'Sounds: On' : 'Sounds: Off', toggleSound, 'tb');
    ui.composer = makeComposer(function () { sendSay(ui.composer); });

    var toolbar = h('div', { class: 'toolbar' },
      btn('Rooms', openRooms, 'tb'),
      btn('People', focusPeople, 'tb'),
      btn('Buddies', openBuddies, 'tb'),
      btn('Away', openAway, 'tb'),
      btn('Art', openArt, 'tb'),
      ui.soundBtn,
      btn('Leave', leaveRoom, 'tb'),
      btn('Sign Off', signOff, 'tb'));
    var actions = h('div', { class: 'peopleacts' },
      ui.btnIM, ui.btnInfo, ui.btnIgnore, ui.btnReport, ui.btnKick, ui.btnMine);
    var peopleCol = h('div', { class: 'peoplecol' }, ui.peopleHead, ui.people, actions);
    var main = h('div', { class: 'chatmain' }, ui.log, peopleCol);
    ui.banner = h('div', { class: 'connection-banner' },
      h('span', { class: 'connection-emblem', 'aria-hidden': 'true' }, 'Pc'),
      h('strong', { text: 'People Connection' }),
      h('span', { text: "Chat Room '96" }));

    ui.win = makeWin({
      title: S.room ? S.room.room : "Chat Room '96",
      kind: 'app', cls: 'chat', w: 660, h: 430, x: 24, y: 22, resizable: true, closable: false, minable: true,
      body: [ui.banner, toolbar, main, ui.composer.el],
      onClose: function () { UI.chat = null; }
    });
    UI.chat = ui;
    renderPeople();
    return ui;
  }

  function ensureChat() {
    return UI.chat || openChat();
  }

  function appendLog(el) {
    if (!UI.chat) return;
    var log = UI.chat.log;
    log.appendChild(el);
    trimLog(log);
  }

  function trimLog(log) {
    while (log.childElementCount > 400) log.removeChild(log.firstElementChild);
    log.scrollTop = log.scrollHeight;
  }

  function clearLog() {
    if (UI.chat) UI.chat.log.replaceChildren();
  }

  function systemLine(text, color) {
    return h('div', { class: 'line notice', style: { color: color || GREEN } }, text);
  }

  // Room text: bold "Name:" then the message. Smileys are shown as symbols; wire text is unchanged.
  function appendSmileys(parent, text) {
    var re = /:\)|:\(|;\)|:D|:P/g;
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      parent.appendChild(document.createTextNode(GLYPH[m[0]]));
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function fmtSpan(text, fmt) {
    var f = fmt || {};
    var span = h('span', {
      style: {
        fontWeight: f.b ? 'bold' : '',
        fontStyle: f.i ? 'italic' : '',
        textDecoration: f.u ? 'underline' : '',
        color: validColor(f.color) || ''
      }
    });
    appendSmileys(span, String(text === undefined || text === null ? '' : text));
    return span;
  }

  function messageLine(who, text, fmt) {
    return h('div', { class: 'line', 'data-from': lower(who) },
      h('b', { text: who + ':' }), ' ', fmtSpan(text, fmt));
  }

  function imLine(who, text, fmt, auto) {
    return h('div', { class: 'line' },
      h('b', { text: auto ? who + ' (away message):' : who + ':' }), ' ', fmtSpan(text, fmt));
  }

  // Composer: B / I / U toggles, colour popup, smiley popup, counter, single-line box, Send.
  function makeComposer(onSend) {
    var c = { fmt: { b: false, i: false, u: false, color: null } };
    c.input = h('input', {
      type: 'text', class: 'inp', autocomplete: 'off', 'aria-label': 'Message',
      onkeydown: function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); onSend(); } },
      oninput: function () { c.refresh(); }
    });
    c.counter = h('span', { class: 'counter', text: '0/' + TEXT_MAX });
    c.bBtn = h('button', {
      class: 'btn fmtbtn', type: 'button', title: 'Bold', style: { fontWeight: 'bold' },
      onclick: function () { c.fmt.b = !c.fmt.b; c.refresh(); c.input.focus(); }
    }, 'B');
    c.iBtn = h('button', {
      class: 'btn fmtbtn', type: 'button', title: 'Italic', style: { fontStyle: 'italic' },
      onclick: function () { c.fmt.i = !c.fmt.i; c.refresh(); c.input.focus(); }
    }, 'I');
    c.uBtn = h('button', {
      class: 'btn fmtbtn', type: 'button', title: 'Underline', style: { textDecoration: 'underline' },
      onclick: function () { c.fmt.u = !c.fmt.u; c.refresh(); c.input.focus(); }
    }, 'U');
    c.chip = h('span', { class: 'chip' });
    c.colorBtn = h('button', {
      class: 'btn', type: 'button', title: 'Text colour',
      onclick: function () { togglePop(c.colorPop, c.smilePop); }
    }, 'Colour ', c.chip);
    c.smileyBtn = h('button', {
      class: 'btn', type: 'button', title: 'Insert a smiley',
      onclick: function () { togglePop(c.smilePop, c.colorPop); }
    }, 'Smiley');
    c.colorPop = h('div', { class: 'popup', role: 'menu', hidden: true },
      h('div', { class: 'swatches' }, PALETTE.map(function (col, i) {
        return h('button', {
          class: 'sw', type: 'button', title: PALETTE_NAMES[i], 'aria-label': PALETTE_NAMES[i],
          style: { background: col },
          onclick: function () { c.fmt.color = col; c.colorPop.hidden = true; c.refresh(); c.input.focus(); }
        });
      })),
      h('button', {
        class: 'btn popbtn', type: 'button',
        onclick: function () { c.fmt.color = null; c.colorPop.hidden = true; c.refresh(); c.input.focus(); }
      }, 'Default colour'));
    c.smilePop = h('div', { class: 'popup smilepop', hidden: true },
      SMILEYS.map(function (s) {
        return h('button', {
          class: 'btn smbtn', type: 'button', title: s.name + ' ' + s.code,
          onclick: function () { insertText(c, s.code); c.smilePop.hidden = true; }
        }, s.glyph);
      }));
    c.sendBtn = btn('Send', function () { onSend(); });
    c.refresh = function () {
      c.bBtn.classList.toggle('pressed', c.fmt.b);
      c.iBtn.classList.toggle('pressed', c.fmt.i);
      c.uBtn.classList.toggle('pressed', c.fmt.u);
      c.chip.style.background = c.fmt.color || 'transparent';
      c.input.style.fontWeight = c.fmt.b ? 'bold' : '';
      c.input.style.fontStyle = c.fmt.i ? 'italic' : '';
      c.input.style.color = c.fmt.color || '';
      c.counter.textContent = cpLen(c.input.value) + '/' + TEXT_MAX;
    };
    c.el = h('div', { class: 'composer' },
      c.colorPop, c.smilePop,
      h('div', { class: 'fmtbar' }, c.bBtn, c.iBtn, c.uBtn, c.colorBtn, c.smileyBtn, c.counter),
      h('div', { class: 'sendrow' }, c.input, c.sendBtn));
    c.refresh();
    return c;
  }

  function togglePop(pop, other) {
    other.hidden = true;
    pop.hidden = !pop.hidden;
  }

  function insertText(c, text) {
    var input = c.input;
    var v = input.value;
    var start = input.selectionStart, end = input.selectionEnd;
    if (start === null || start === undefined || end === null || end === undefined) {
      start = v.length;
      end = v.length;
    }
    input.value = v.slice(0, start) + text + v.slice(end);
    var pos = start + text.length;
    try { input.setSelectionRange(pos, pos); } catch (e) { /* not supported: ignore */ }
    input.focus();
    c.refresh();
  }

  function fmtOf(c) {
    var f = c.fmt;
    if (!f.b && !f.i && !f.u && !f.color) return null;
    return { b: !!f.b, i: !!f.i, u: !!f.u, color: f.color || null };
  }

  function sendSay(c) {
    var text = norm(c.input.value);
    if (!text) {
      c.input.value = '';
      c.refresh();
      return;
    }
    if (cpLen(text) > TEXT_MAX) {
      dialog('Message Too Long', 'Messages can be at most 250 characters.', { icon: 'error' });
      return;
    }
    if (!S.room) return;
    if (/^\/art(?:\s|$)/i.test(text)) {
      var name = text.slice(4).trim().toLowerCase();
      if (!name || name === 'list' || name === 'help') openArt();
      else if (!send({ type: 'art', name: name })) return;
      c.input.value = '';
      c.refresh();
      return;
    }
    if (send({ type: 'say', text: text, fmt: fmtOf(c) })) {
      S.pendingSay.push({ text: text, c: c });
      c.input.value = '';
      c.refresh();
    }
  }

  function leaveRoom() {
    if (S.room) send({ type: 'leave_room' });
  }

  function openArt() {
    if (UI.art) {
      raise(UI.art.win);
      return;
    }
    var ui = {};
    ui.pieces = [];
    ui.select = h('select', { class: 'inp art-select', 'aria-label': 'ASCII art', onchange: preview });
    ui.preview = h('pre', { class: 'art-preview sunken', 'aria-label': 'Art preview', text: 'Loading the classics...' });
    function preview() {
      var piece = ui.pieces.filter(function (p) { return p.name === ui.select.value; })[0];
      ui.preview.textContent = piece ? piece.lines.join('\n') : '';
    }
    ui.previewSelection = preview;
    function print(name) { send({ type: 'art', name: name || ui.select.value }); }
    function upchat() {
      var chat = ensureChat();
      raise(chat.win);
      chat.composer.input.focus();
    }
    function options() {
      dialog('Fate X Options', 'Chat sounds are ' + (S.sound ? 'on.' : 'off.'), {
        buttons: [{ label: 'Toggle Sounds', onClick: toggleSound }, { label: 'OK', primary: true }]
      });
    }
    function status() {
      dialog('Fate Online', S.me + ' is online in ' + (S.room ? S.room.room : 'no room') + '.', { icon: 'info' });
    }
    function rollUp() { ui.win.el.classList.toggle('rolled'); }
    var menu = h('nav', { class: 'fate-menu', 'aria-label': 'Fate X menu' },
      btn('Fate', aboutFate), btn('IM', newIM), btn('Bots', openAway), btn('Chat', upchat),
      btn('Other', options), btn('Roll Up', rollUp), btn('Help', artHelp));
    var deck = h('div', { class: 'fate-deck' },
      btn('Modal', status), btn('Upchat', upchat), btn('Sign-Off', signOff),
      btn('Hide A0L', function () { minimizeWin(ensureChat().win); }), btn('Fate', aboutFate),
      btn('LOL', function () {
        if (send({ type: 'say', text: 'LOL!', fmt: null })) S.pendingSay.push({ text: 'LOL!', c: ensureChat().composer });
      }),
      btn('IM', newIM), btn('Kill Welc.', function () { ensureChat().banner.hidden = true; }),
      btn('Exit', function () { closeWin(ui.win); }), btn('Minimize', function () { minimizeWin(ui.win); }),
      btn('Fate Online', status, 'fate-wide'),
      btn('ASCII', function () { ui.select.focus(); }), btn('Stop Scroll', function () { print('stop'); }),
      btn('Options', options), btn('Fate Test', function () { print('skull'); }),
      btn('Hide Tool', function () { minimizeWin(ui.win); }, 'fate-wide'));
    var panel = h('fieldset', { class: 'art-panel' },
      h('legend', { text: 'ASCII Scroller' }), ui.select, ui.preview,
      h('div', { class: 'art-controls' },
        h('span', { text: 'Delay: 650 ms' }),
        btn('Scroll It!', function () { if (ui.select.value) print(); }, 'default'),
        btn('Stop', function () { print('stop'); })));
    ui.win = makeWin({
      title: 'Fate X 3.0 — Tribute', kind: 'app', cls: 'fatex', w: 620, h: 420,
      x: Math.max(12, desktop.clientWidth - 648), y: 62, minable: true,
      body: [
        menu, deck, panel,
        h('div', { class: 'fate-status' }, h('span', { text: 'Fate X 3.0 • local remake' }),
          h('span', { text: 'Inspired by MaGuS & FuNGii' }))
      ],
      onClose: function () { UI.art = null; }
    });
    UI.art = ui;
    send({ type: 'art', name: 'list' });
  }

  function aboutFate() {
    dialog('About Fate X 3.0', 'Original Fate X 3.0 by MaGuS & FuNGii. This local remake brings back the ASCII scroller and the old control panel.', { icon: 'info' });
  }

  function artHelp() {
    dialog('ASCII Scroller Help', 'Choose a macro, then press Scroll It! Or type /art skull, /art finger, /art banner or /art divider in chat. /art stop cancels your scroll.', { icon: 'info', w: 380 });
  }

  function newIM() {
    var input = h('input', { class: 'inp', type: 'text', 'aria-label': 'IM screen name', autocomplete: 'off' });
    var win;
    function go() {
      var name = norm(input.value);
      if (!SN_RE.test(name) || sameName(name, S.me)) {
        dialog('Choose a Screen Name', SN_RULE + ' Choose someone other than yourself.', { icon: 'info' });
        return;
      }
      closeWin(win);
      openIM(name);
    }
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go(); });
    win = makeWin({ title: 'Send an Instant Message', kind: 'dialog', w: 320,
      body: [fieldRow('Screen Name:', input), h('div', { class: 'btnrow' },
        btn('Write IM', go, 'default'), btn('Cancel', function () { closeWin(win); }))] });
    input.focus();
  }

  function bindShell() {
    var actions = {
      file: function () {
        dialog('Almost Online', 'Ready when you are.', {
          buttons: [{ label: S.signedOn ? 'Sign Off' : 'Sign On', onClick: S.signedOn ? signOff : openSignOn }, { label: 'Close', primary: true }]
        });
      },
      people: openRooms, im: newIM, buddies: openBuddies, profile: openEdit, art: openArt, away: openAway, signoff: signOff,
      window: function () { WM.wins.forEach(raise); },
      help: function () { dialog('About Almost Online', "A0L — Almost Online 3.0. Your own little corner of 1996. Chat Room '96 is an affectionate local parody.", { icon: 'info', w: 360 }); }
    };
    document.querySelectorAll('[data-action]').forEach(function (button) {
      button.addEventListener('click', function () {
        var name = button.getAttribute('data-action');
        if (!S.signedOn && !['file', 'help', 'window'].includes(name)) { openSignOn(); return; }
        actions[name]();
      });
    });
    document.getElementById('keyword-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!S.signedOn) { openSignOn(); return; }
      var keyword = norm(document.getElementById('service-keyword').value);
      if (!keyword || /^(people|chat|people connection)$/i.test(keyword)) openRooms();
      else if (/^(fate|fate x|art)$/i.test(keyword)) openArt();
      else if (/^(buddies|buddy list)$/i.test(keyword)) openBuddies();
      else joinRoom(keyword);
    });
  }

  function onArtStatus(f) {
    if (f.state === 'catalog') {
      if (!UI.art) return;
      UI.art.pieces = f.pieces;
      UI.art.select.replaceChildren();
      f.pieces.forEach(function (piece) {
        UI.art.select.appendChild(h('option', { value: piece.name, text: piece.title }));
      });
      UI.art.previewSelection();
    } else {
      var text = f.state === 'started' ? 'Scrolling ' + f.name + '... (/art stop to cancel)' :
        f.state === 'finished' ? 'Scroll complete.' : 'Scroller stopped.';
      appendLog(systemLine(text, NAVY));
    }
  }

  function focusPeople() {
    var ui = UI.chat;
    if (!ui) return;
    if (!S.selPerson && S.room && S.room.members.length) {
      S.selPerson = S.room.members.filter(function (m) { return !sameName(m, S.me); })[0] || S.room.members[0];
    }
    renderPeople();
    raise(ui.win);
    ui.people.focus();
    ui.people.scrollIntoView({ block: 'nearest' });
  }

  function toggleSound() {
    S.sound = !S.sound;
    saveSound();
    if (S.sound) unlockAudio();
    if (UI.chat) UI.chat.soundBtn.textContent = S.sound ? 'Sounds: On' : 'Sounds: Off';
  }

  function isHost(name) {
    return !!(S.room && S.room.host && sameName(S.room.host, name));
  }
  function isIgnored(name) {
    return !!S.ignored[lower(name)];
  }

  function selectPerson(name) {
    S.selPerson = name;
    renderPeople();
  }

  function renderPeople() {
    var ui = UI.chat;
    if (!ui) return;
    var members = S.room ? S.room.members : [];
    if (S.selPerson && !members.some(function (m) { return sameName(m, S.selPerson); })) {
      S.selPerson = null;
    }
    var sel = S.selPerson;
    ui.peopleHead.textContent = 'People (' + members.length + ')';
    var rows = members.map(function (name) {
      var isSel = !!sel && sameName(sel, name);
      return h('div', {
        class: 'person' + (isSel ? ' sel' : ''), role: 'option',
        'aria-selected': isSel ? 'true' : 'false',
        onclick: function () { selectPerson(name); },
        ondblclick: function () { if (!sameName(name, S.me)) openIM(name); }
      }, name + (isHost(name) ? ' (Host)' : ''));
    });
    ui.people.replaceChildren.apply(ui.people, rows);
    var other = !!sel && !sameName(sel, S.me);
    ui.btnIM.disabled = !other;
    ui.btnInfo.disabled = !sel;
    ui.btnIgnore.disabled = !other;
    ui.btnReport.disabled = !other;
    ui.btnKick.disabled = !other;
    ui.btnKick.hidden = !(other && S.room && S.room.kind === 'member' && S.room.host && sameName(S.room.host, S.me));
    ui.btnIgnore.textContent = sel && isIgnored(sel) ? 'Unignore' : 'Ignore';
  }

  function personAction(kind) {
    var sel = S.selPerson;
    if (!sel) return;
    if (kind === 'im') openIM(sel);
    else if (kind === 'info') openInfo(sel);
    else if (kind === 'ignore') send({ type: 'ignore', screen_name: sel, on: !isIgnored(sel) });
    else if (kind === 'report') openReport(sel);
    else if (kind === 'kick') confirmKick(sel);
  }

  function confirmKick(name) {
    dialog('Remove From Room', 'Remove ' + name + ' from this room?', {
      icon: 'question',
      buttons: [
        { label: 'Remove', primary: true, onClick: function () { send({ type: 'kick', screen_name: name }); } },
        { label: 'Cancel' }
      ]
    });
  }

  function openReport(name) {
    dialog('Report a Screen Name',
      'Report ' + name + ' to the service? Only the screen name and the time are kept. No message text is kept.', {
        icon: 'question',
        buttons: [
          { label: 'Report', primary: true, onClick: function () { send({ type: 'report', screen_name: name }); } },
          { label: 'Cancel' }
        ]
      });
  }

  // ---------- Rooms window ----------
  function openRooms() {
    if (UI.rooms) {
      raise(UI.rooms.win);
      send({ type: 'list_rooms' });
      return;
    }
    var ui = {};
    ui.count = h('div', { class: 'hint' });
    ui.list = h('div', { class: 'roomlist', role: 'listbox', 'aria-label': 'Rooms' });
    ui.kw = h('input', {
      type: 'text', class: 'inp', 'aria-label': 'Keyword or room name',
      onkeydown: function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); goKeyword(ui); } }
    });
    ui.win = makeWin({
      title: 'Rooms', kind: 'app', w: 330, h: 340, resizable: true, minable: true,
      body: [
        h('div', { class: 'roomhead' }, h('span', { text: 'Room name' }), h('span', { text: 'Kind' }), h('span', { text: 'Occupancy' })),
        ui.list,
        ui.count,
        fieldRow('Keyword:', ui.kw, btn('Go', function () { goKeyword(ui); })),
        h('div', { class: 'btnrow' },
          btn('Join', joinSelected),
          btn('Create', openCreateRoom),
          btn('Refresh', function () { send({ type: 'list_rooms' }); }))
      ],
      onClose: function () { UI.rooms = null; }
    });
    UI.rooms = ui;
    renderRooms();
    send({ type: 'list_rooms' });
  }

  function renderRooms() {
    var ui = UI.rooms;
    if (!ui) return;
    var rows = S.rooms.map(function (r) {
      var name = String(r.name);
      var isSel = S.selRoom === name;
      return h('div', {
        class: 'roomrow' + (isSel ? ' sel' : ''), role: 'option',
        onclick: function () { S.selRoom = name; renderRooms(); },
        ondblclick: function () { joinRoom(name); }
      },
        h('span', { text: name }),
        h('span', { text: r.kind === 'lobby' ? 'Lobby' : 'Member room' }),
        h('span', { text: String(r.count) + ' of ' + String(r.capacity) }));
    });
    ui.list.replaceChildren.apply(ui.list, rows);
    if (!rows.length) ui.list.appendChild(h('div', { class: 'hint', text: 'No rooms are open.' }));
    ui.count.textContent = S.rooms.length + (S.rooms.length === 1 ? ' room is open.' : ' rooms are open.');
  }

  function joinRoom(name) {
    send({ type: 'join_room', name: name });
  }

  function joinSelected() {
    if (!S.selRoom) {
      dialog('No Room Selected', 'Pick a room in the list, or type a name in the Keyword box.', { icon: 'info' });
      return;
    }
    joinRoom(S.selRoom);
  }

  function goKeyword(ui) {
    var name = norm(ui.kw.value);
    if (!ROOM_RE.test(name)) {
      dialog('Invalid Entry', ROOM_RULE, { icon: 'error' });
      return;
    }
    joinRoom(name);
  }

  function openCreateRoom() {
    var win = null;
    var input = h('input', {
      type: 'text', class: 'inp', 'aria-label': 'Room name',
      onkeydown: function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); create(); } }
    });
    function create() {
      var name = norm(input.value);
      if (!ROOM_RE.test(name)) {
        dialog('Invalid Entry', ROOM_RULE, { icon: 'error' });
        return;
      }
      // One create at a time. The window closes when the server confirms the room (see onRoomState).
      if (S.pendingCreate) return;
      if (send({ type: 'create_room', name: name })) S.pendingCreate = { name: name, win: win };
    }
    win = makeWin({
      title: 'Create a Room', kind: 'dialog', w: 330,
      body: [
        h('div', { class: 'dlg' },
          h('div', { class: 'dlgicon question', text: '?' }),
          h('div', { class: 'dlgmsg', text: 'What would you like to call your room? Names can be up to 24 characters.' })),
        fieldRow('Room name:', input),
        h('div', { class: 'btnrow' },
          btn('OK', create, 'default'),
          btn('Cancel', function () { closeWin(win); }))
      ]
    });
    input.focus();
  }

  // ---------- Buddy list window ----------
  function openBuddies() {
    if (UI.buddies) {
      raise(UI.buddies.win);
      return;
    }
    var ui = {};
    ui.count = h('div', { class: 'hint' });
    ui.list = h('div', { class: 'buddylist', role: 'listbox', 'aria-label': 'Buddies' });
    ui.add = h('input', {
      type: 'text', class: 'inp', 'aria-label': 'Screen name to add',
      onkeydown: function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); addBuddy(ui); } }
    });
    ui.win = makeWin({
      title: 'Buddy List', kind: 'app', w: 270, h: 330, resizable: true, minable: true,
      body: [
        ui.count,
        ui.list,
        fieldRow('Add:', ui.add, btn('Add', function () { addBuddy(ui); })),
        h('div', { class: 'btnrow' },
          btn('IM', function () { if (S.selBuddy) openIM(S.selBuddy); }),
          btn('Remove', removeBuddy))
      ],
      onClose: function () { UI.buddies = null; }
    });
    UI.buddies = ui;
    renderBuddies();
  }

  function renderBuddies() {
    var ui = UI.buddies;
    if (!ui) return;
    var rows = S.buddies.map(function (b) {
      var isSel = !!S.selBuddy && sameName(S.selBuddy, b.screen_name);
      return h('div', {
        class: 'buddyrow' + (isSel ? ' sel' : ''), role: 'option',
        onclick: function () { S.selBuddy = b.screen_name; renderBuddies(); },
        ondblclick: function () { openIM(b.screen_name); }
      }, b.screen_name + ' - ' + (b.online ? 'Online' : 'Offline'));
    });
    if (!rows.length) rows.push(h('div', { class: 'hint', text: 'Your buddy list is empty.' }));
    ui.list.replaceChildren.apply(ui.list, rows);
    ui.count.textContent = S.buddies.length + ' of ' + BUDDY_MAX + ' buddies';
  }

  function addBuddy(ui) {
    var name = norm(ui.add.value);
    if (!SN_RE.test(name)) {
      dialog('Invalid Entry', SN_RULE, { icon: 'error' });
      return;
    }
    if (send({ type: 'buddy_add', screen_name: name })) {
      S.pendingBuddy.push({ kind: 'add', name: name, input: ui.add });
      ui.add.value = '';
    }
  }

  function removeBuddy() {
    if (!S.selBuddy) {
      dialog('No Buddy Selected', 'Pick a name in your buddy list first.', { icon: 'info' });
      return;
    }
    if (send({ type: 'buddy_remove', screen_name: S.selBuddy })) S.pendingBuddy.push({ kind: 'remove' });
    S.selBuddy = null;
  }

  // ---------- Away window ----------
  function openAway() {
    if (UI.away) {
      raise(UI.away.win);
      return;
    }
    var ui = {};
    ui.status = h('div', { class: 'hint' });
    ui.input = h('input', {
      type: 'text', class: 'inp', 'aria-label': 'Away message', value: S.away,
      onkeydown: function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); saveAway(ui); } }
    });
    ui.win = makeWin({
      title: 'Away Message', kind: 'app', w: 330, minable: false,
      body: [
        h('div', { class: 'hint', text: 'Anyone who sends you an IM while you are away gets this message back. Up to 120 characters.' }),
        fieldRow('Away message:', ui.input),
        ui.status,
        h('div', { class: 'btnrow' },
          btn('OK', function () { saveAway(ui); }, 'default'),
          btn('I am back', function () { clearAway(ui); }),
          btn('Cancel', function () { closeWin(ui.win); }))
      ],
      onClose: function () { UI.away = null; }
    });
    UI.away = ui;
    renderAway();
    ui.input.focus();
  }

  function renderAway() {
    if (!UI.away) return;
    UI.away.status.textContent = S.away ? 'You are away: ' + S.away : 'You are not away.';
  }

  function saveAway(ui) {
    var text = norm(ui.input.value);
    if (cpLen(text) > AWAY_MAX) {
      dialog('Message Too Long', 'Away messages can be at most 120 characters.', { icon: 'error' });
      return;
    }
    // The window closes when away_status confirms the change (see onAwayStatus). A refusal leaves it open.
    send({ type: 'set_away', message: text });
  }

  function clearAway() {
    send({ type: 'set_away', message: '' });
  }

  // ---------- Instant messages ----------
  function openIM(name) {
    var key = lower(name);
    var ui = UI.ims[key];
    if (ui) {
      raise(ui.win);
      ui.composer.input.focus();
      return ui;
    }
    ui = { name: String(name) };
    ui.log = h('div', { class: 'log sunken', role: 'log', 'aria-live': 'polite' });
    ui.composer = makeComposer(function () { sendIM(ui); });
    ui.win = makeWin({
      title: 'Instant Message from ' + ui.name, kind: 'app', cls: 'im', w: 350, h: 290,
      resizable: true, closable: true, minable: true,
      body: [ui.log, ui.composer.el],
      onClose: function () { if (UI.ims[key] === ui) delete UI.ims[key]; }
    });
    UI.ims[key] = ui;
    ui.composer.input.focus();
    return ui;
  }

  function sendIM(ui) {
    var c = ui.composer;
    var text = norm(c.input.value);
    if (!text) {
      c.input.value = '';
      c.refresh();
      return;
    }
    if (cpLen(text) > TEXT_MAX) {
      dialog('Message Too Long', 'Messages can be at most 250 characters.', { icon: 'error' });
      return;
    }
    if (send({ type: 'im', to: ui.name, text: text, fmt: fmtOf(c) })) {
      S.pendingIM.push({ to: ui.name, text: text, ui: ui });
      c.input.value = '';
      c.refresh();
    }
  }

  // Puts text back into a box the user can still see. If that box has closed, the text goes into a dialog,
  // so the text is never lost.
  function restoreText(input, text, after) {
    if (input && input.isConnected) {
      input.value = input.value ? text + ' ' + input.value : text;
      if (after) after();
      input.focus();
      return;
    }
    dialog('Not Sent', 'That entry was not sent, so here it is again: ' + text, { icon: 'error' });
  }

  // The answer to an IM is im_sent or an error, in the order the IMs were sent, so the oldest entry is the one answered.
  function failIM(code) {
    var p = S.pendingIM.shift();
    if (!p) return;
    if (code === 'recipient_offline') {
      p.ui.log.appendChild(systemLine(p.to + ' is not signed on. Your message was not sent.', MAROON));
      trimLog(p.ui.log);
    }
    restoreText(p.ui.composer.input, p.text, p.ui.composer.refresh);
  }

  // ---------- Get Info and Edit My Profile ----------
  function roField() {
    return h('input', { type: 'text', class: 'inp', readonly: true });
  }

  function openInfo(name) {
    var key = lower(name);
    var ui = UI.infos[key];
    if (ui) {
      raise(ui.win);
    } else {
      ui = {};
      ui.note = h('div', { class: 'hint', text: 'Looking up ' + name + '...' });
      ui.loc = roField();
      ui.hob = roField();
      ui.quo = roField();
      ui.win = makeWin({
        title: 'Get Info - ' + name, kind: 'app', w: 320, minable: false,
        body: [
          ui.note,
          fieldRow('Location:', ui.loc),
          fieldRow('Hobbies:', ui.hob),
          fieldRow('Quote:', ui.quo),
          h('div', { class: 'btnrow' }, btn('OK', function () { closeWin(ui.win); }, 'default'))
        ],
        onClose: function () { if (UI.infos[key] === ui) delete UI.infos[key]; }
      });
      UI.infos[key] = ui;
    }
    if (send({ type: 'get_profile', screen_name: name })) S.pendingProfile.push({ kind: 'info', ui: ui });
    else ui.note.textContent = 'Could not look that name up just now. Try again.';
  }

  function fillInfo(ui, f) {
    if (!f.signed_on) {
      ui.note.textContent = 'No one by that name is signed on.';
      ui.loc.value = '';
      ui.hob.value = '';
      ui.quo.value = '';
      return;
    }
    ui.note.textContent = '';
    ui.loc.value = String(f.location || '');
    ui.hob.value = String(f.hobbies || '');
    ui.quo.value = String(f.quote || '');
  }

  function editField() {
    return h('input', { type: 'text', class: 'inp' });
  }

  function openEdit() {
    if (!S.signedOn) return;
    if (UI.edit) {
      raise(UI.edit.win);
    } else {
      var ui = { pendingPrefill: true, waitingSave: false };
      ui.note = h('div', { class: 'hint', text: 'Loading your profile...' });
      ui.loc = editField();
      ui.hob = editField();
      ui.quo = editField();
      ui.win = makeWin({
        title: 'Edit Your Profile', kind: 'app', w: 340, minable: false,
        body: [
          h('div', { class: 'hint', text: 'Signed on as ' + S.me + '.' }),
          fieldRow('Location:', ui.loc),
          fieldRow('Hobbies:', ui.hob),
          fieldRow('Quote:', ui.quo),
          ui.note,
          h('div', { class: 'btnrow' },
            btn('Save', function () { saveProfile(ui); }, 'default'),
            btn('Cancel', function () { closeWin(ui.win); }))
        ],
        onClose: function () { UI.edit = null; }
      });
      UI.edit = ui;
    }
    if (send({ type: 'get_profile', screen_name: S.me })) S.pendingProfile.push({ kind: 'edit', ui: UI.edit });
    else UI.edit.note.textContent = 'Could not load your profile just now. Close this window and try again.';
  }

  function fillEdit(ui, f) {
    if (ui.pendingPrefill) {
      ui.pendingPrefill = false;
      ui.loc.value = String(f.location || '');
      ui.hob.value = String(f.hobbies || '');
      ui.quo.value = String(f.quote || '');
      ui.note.textContent = 'Your profile is kept only while you are signed on.';
      return;
    }
    if (ui.waitingSave) {
      ui.waitingSave = false;
      ui.note.textContent = 'Your profile has been saved.';
    }
  }

  function saveProfile(ui) {
    var vals = [norm(ui.loc.value), norm(ui.hob.value), norm(ui.quo.value)];
    var tooLong = vals.some(function (v) { return cpLen(v) > PROFILE_MAX; });
    if (tooLong) {
      dialog('Invalid Entry', 'Profile fields can be at most 60 characters each.', { icon: 'error' });
      return;
    }
    ui.loc.value = vals[0];
    ui.hob.value = vals[1];
    ui.quo.value = vals[2];
    if (send({ type: 'set_profile', location: vals[0], hobbies: vals[1], quote: vals[2] })) {
      S.pendingProfile.push({ kind: 'save', ui: ui });
      ui.waitingSave = true;
      ui.note.textContent = 'Saving...';
    }
  }

  // ---------- Idle warning ----------
  function onIdleWarning(f) {
    var secs = Math.max(1, Math.round(Number(f.grace_seconds) || 1));
    var end = Date.now() + secs * 1000;
    if (UI.idle) closeWin(UI.idle.win);
    var count = h('span', { text: String(secs) });
    var timer = null;
    var ui = {};
    var yes = btn('Yes', function () {
      // The warning closes only once the answer has gone out. Closing it on a refused send would leave the user signed off.
      if (send({ type: 'still_here' })) closeWin(ui.win);
    }, 'default');
    ui.win = makeWin({
      title: 'Are you still there?', kind: 'dialog', cls: 'dlgwin', w: 320, closable: false,
      onClose: function () {
        if (timer) clearInterval(timer);
        if (UI.idle === ui) UI.idle = null;
      },
      body: [
        h('div', { class: 'dlg' },
          h('div', { class: 'dlgicon question', text: '?' }),
          h('div', { class: 'dlgmsg' }, 'You will be signed off in ', count, ' seconds if you do not answer.')),
        h('div', { class: 'btnrow' }, yes)
      ]
    });
    timer = setInterval(function () {
      var left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      count.textContent = String(left);
      if (left <= 0) clearInterval(timer);
    }, 250);
    UI.idle = ui;
    yes.focus();
  }

  // ---------- Server frame handlers ----------
  function onSignedOn(f) {
    S.signingOn = false;
    S.signedOn = true;
    S.me = String(f.screen_name || '');
    S.lastName = S.me;
    if (UI.signon) closeWin(UI.signon.win);
    setConn();
  }

  function onSignedOff(f) {
    var reason = f.reason;
    resetSession();
    openSignOn();
    if (reason === 'idle') {
      dialog('Signed Off', 'You were signed off because you did not answer "Are you still there?"', { icon: 'info' });
    } else if (reason === 'server_shutdown') {
      dialog('Server Shutting Down', 'The server is shutting down. Sign on again when it comes back.', { icon: 'info' });
    }
  }

  function onError(f) {
    var code = String(f.code || '');
    var entry = Object.prototype.hasOwnProperty.call(ERRORS, code) ? ERRORS[code] : null;
    var title = entry ? entry[0] : 'Notice';
    var own = f.message ? String(f.message) : '';
    var text;
    if (own && (code === 'invalid_field' || code === 'text_too_long' || code === 'invalid_target')) text = own;
    else if (entry) text = entry[1];
    else text = own || 'Something went wrong on the server.';
    refused(f.ref, code);
    if (code === 'rate_limited') slowDown();
    else dialog(title, text, { icon: 'error' });
  }

  // Each request that the server refuses is answered with an error (or rate_limited) whose ref is that request's type
  // (PROTOCOL.md 7.1 and addendum A1). This clears what the page was waiting for, and gives back the typed text.
  // For text-carrying requests the oldest entry of that kind is the one refused, because answers arrive in order.
  function refused(ref, code) {
    if (ref === 'sign_on') S.signingOn = false;
    else if (ref === 'say') failSay();
    else if (ref === 'im') failIM(code);
    else if (ref === 'buddy_add' || ref === 'buddy_remove') failBuddy();
    else if (ref === 'get_profile' || ref === 'set_profile') failProfile();
    else if (ref === 'create_room') S.pendingCreate = null;
    // A refused set_away leaves the away window open with its text, so nothing needs undoing.
  }

  function failSay() {
    var p = S.pendingSay.shift();
    if (p) restoreText(p.c.input, p.text, p.c.refresh);
  }

  function failBuddy() {
    var p = S.pendingBuddy.shift();
    if (p && p.kind === 'add') restoreText(p.input, p.name);
  }

  function failProfile() {
    var p = S.pendingProfile.shift();
    if (!p) return;
    if (p.kind === 'save') {
      p.ui.waitingSave = false;
      p.ui.note.textContent = 'Your profile was not saved. Try again.';
    } else if (p.kind === 'edit') {
      p.ui.pendingPrefill = false;
      p.ui.note.textContent = 'Your profile could not be loaded. Close this window and try again.';
    } else {
      p.ui.note.textContent = 'Could not look that name up. Try again.';
    }
  }

  function onRoomList(f) {
    S.rooms = Array.isArray(f.rooms) ? f.rooms : [];
    renderRooms();
  }

  function onRoomState(f) {
    var same = !!S.room && sameName(S.room.room, f.room);
    S.room = {
      room: String(f.room || ''),
      kind: f.kind === 'member' ? 'member' : 'lobby',
      capacity: Number(f.capacity) || 0,
      members: sortNames(Array.isArray(f.members) ? f.members.map(String) : []),
      host: f.host ? String(f.host) : null,
      redirected_from: f.redirected_from ? String(f.redirected_from) : null
    };
    if (!same) {
      S.selPerson = null;
      ensureChat();
      setTitle(UI.chat.win, S.room.room);
      clearLog();
      if (S.room.redirected_from) {
        appendLog(systemLine(S.room.redirected_from + ' is full, so you were placed in ' + S.room.room + '.', NAVY));
      } else {
        appendLog(systemLine('You are in ' + S.room.room + '.', NAVY));
      }
    } else {
      ensureChat();
    }
    // A successful create_room ends with room_state for the new room, with this user as its host.
    var pc = S.pendingCreate;
    if (pc && f.host && sameName(pc.name, f.room) && sameName(f.host, S.me)) {
      S.pendingCreate = null;
      closeWin(pc.win);
    }
    renderPeople();
  }

  function onRoomLeft(f) {
    if (f.reason === 'kicked') {
      dialog('Removed From Room', 'The host removed you from ' + String(f.room || 'the room') + '.', { icon: 'warn' });
    }
    S.room = null;
    S.selPerson = null;
    renderPeople();
  }

  function onMemberJoined(f) {
    if (!S.room || !sameName(S.room.room, f.room)) return;
    var name = String(f.screen_name || '');
    if (!S.room.members.some(function (m) { return sameName(m, name); })) {
      S.room.members = sortNames(S.room.members.concat([name]));
    }
    appendLog(systemLine(name + ' has entered the room.', GREEN));
    play('arrive');
    renderPeople();
  }

  function onMemberLeft(f) {
    if (!S.room || !sameName(S.room.room, f.room)) return;
    var name = String(f.screen_name || '');
    S.room.members = S.room.members.filter(function (m) { return !sameName(m, name); });
    if (S.room.host && sameName(S.room.host, name)) S.room.host = null;
    if (S.selPerson && sameName(S.selPerson, name)) S.selPerson = null;
    var text = f.reason === 'kicked'
      ? name + ' has been removed from the room by the host.'
      : name + ' has left the room.';
    appendLog(systemLine(text, GREEN));
    play('leave');
    renderPeople();
  }

  function onRoomMessage(f) {
    // The server sends a say back to its sender, so the sender's own line confirms the oldest pending say.
    if (!f.art && sameName(f.from, S.me)) S.pendingSay.shift();
    if (!S.room || !sameName(S.room.room, f.room)) return;
    if (f.art) {
      appendLog(h('div', { class: 'line art-line', 'data-from': lower(f.from) },
        h('b', { text: String(f.from || '') + ': ' }), h('span', { text: String(f.text || '') })));
    } else {
      appendLog(messageLine(String(f.from || ''), String(f.text || ''), f.fmt));
    }
  }

  function onIM(f) {
    var from = String(f.from || '');
    if (f.auto_reply) {
      var a = openIM(from);
      a.log.appendChild(imLine(from, String(f.text || ''), f.fmt, true));
      trimLog(a.log);
      return;
    }
    var ui = openIM(from);
    ui.log.appendChild(imLine(from, String(f.text || ''), f.fmt, false));
    trimLog(ui.log);
    play('ding');
  }

  function onIMSent(f) {
    S.pendingIM.shift();
    var ui = openIM(String(f.to || ''));
    ui.log.appendChild(imLine(S.me, String(f.text || ''), f.fmt, false));
    trimLog(ui.log);
  }

  function onAwayStatus(f) {
    S.away = String(f.message || '');
    renderAway();
    // The server has taken the change, so the away window's job is done.
    if (UI.away) closeWin(UI.away.win);
  }

  function onProfile(f) {
    S.pendingProfile.shift(); // Every profile frame answers the oldest get_profile or set_profile.
    var name = String(f.screen_name || '');
    var info = UI.infos[lower(name)];
    if (info) fillInfo(info, f);
    if (UI.edit && sameName(name, S.me)) fillEdit(UI.edit, f);
  }

  function onBuddyList(f) {
    S.pendingBuddy.shift(); // buddy_list answers the oldest buddy_add or buddy_remove.
    S.buddies = (Array.isArray(f.buddies) ? f.buddies : []).map(function (b) {
      return { screen_name: String(b.screen_name || ''), online: !!b.online };
    });
    if (S.selBuddy && !S.buddies.some(function (b) { return sameName(b.screen_name, S.selBuddy); })) {
      S.selBuddy = null;
    }
    renderBuddies();
  }

  function onBuddyStatus(f) {
    var name = String(f.screen_name || '');
    var b = S.buddies.filter(function (x) { return sameName(x.screen_name, name); })[0];
    if (!b) return;
    b.online = !!f.online;
    renderBuddies();
    play('buddy');
    appendLog(systemLine(b.screen_name + (b.online ? ' has signed on.' : ' has signed off.'), GREEN));
  }

  function onIgnoreStatus(f) {
    var key = lower(f.screen_name);
    if (f.ignored) {
      S.ignored[key] = true;
      if (UI.chat) {
        Array.prototype.slice.call(UI.chat.log.children).forEach(function (el) {
          if (el.getAttribute('data-from') === key) el.parentNode.removeChild(el);
        });
      }
    } else {
      delete S.ignored[key];
    }
    renderPeople();
  }

  function onReportAck(f) {
    dialog('Report Received', 'Thank you. ' + String(f.screen_name || '') + ' has been reported.', { icon: 'info' });
  }

  var HANDLERS = {
    signed_on: onSignedOn,
    signed_off: onSignedOff,
    error: onError,
    room_list: onRoomList,
    room_state: onRoomState,
    room_left: onRoomLeft,
    member_joined: onMemberJoined,
    member_left: onMemberLeft,
    room_message: onRoomMessage,
    art_status: onArtStatus,
    im: onIM,
    im_sent: onIMSent,
    away_status: onAwayStatus,
    profile: onProfile,
    buddy_list: onBuddyList,
    buddy_status: onBuddyStatus,
    ignore_status: onIgnoreStatus,
    report_ack: onReportAck,
    idle_warning: onIdleWarning
  };

  // ---------- Global input ----------
  document.addEventListener('pointerdown', unlockAudio, true);
  document.addEventListener('keydown', function (ev) {
    unlockAudio();
    if (ev.key === 'Escape') {
      var top = topWin();
      if (top && top.kind === 'dialog' && top.closable) closeWin(top);
    }
  }, true);

  // ---------- Boot ----------
  loadPrefs();
  bindShell();
  openSignOn();
  connect();
})();
