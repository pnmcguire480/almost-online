# Chat Room '96: WebSocket Protocol

Version 1. Companion files: `PARITY.md` (behaviour and acceptance checks), `BACKLOG.md`.

## ASCII scroller extension

Signed-on clients may send `{ "type": "art", "name": "skull" }`. The browser maps `/art <name>` in the room composer to this request. Names are case-insensitive; `middlefinger` aliases `finger`.

Absent/empty names and `list`/`help` return a private `art_status` with `state: "catalog"`, `interval_ms: 650`, and `pieces: [{name, title, lines: [string]}]`. The catalog contains `skull`, `finger`, `banner` and `divider`.

A print returns private `art_status` with `state: "started"`, `name`, and `interval_ms: 650`. It broadcasts ordinary `room_message` frames with `fmt: null` and additional `art: {name, line, total}` (line numbers start at 1). The first line is immediate; subsequent lines are 650 ms apart. The final line is followed by private `art_status` with `state: "finished"` and `name`. Art lines preserve their original whitespace and are rendered as literal monospace text without smiley replacement. An art frame never acknowledges a pending `say` request.

`name: "stop"` cancels the sender's scroll and returns private `art_status` with `state: "stopped"`, including when already stopped. A second print while one is running returns `error` with `code: "art_busy"`, `ref: "art"`. Invalid names/types return `invalid_field`, `ref: "art"`, `field: "name"`. Art requests use the existing inbound token bucket. The server chooses all output text and pacing; clients cannot supply lines or intervals.

Only current occupants of the sender's original room receive lines; ignore is checked at each line. Departure, kick, sign-off, idle expiry, disconnect and shutdown cancel outstanding timers. Scrolls from different senders are independent. No art is retained as room history.

This document is the wire contract. A server and a client written independently from this document must interoperate without further questions. Where this document is silent, the server decides and the client must accept the result.

Conventions: "MUST" and "MUST NOT" mark rules that a conforming implementation must follow. "Design choice" marks a default that PARITY.md lists as an open question.

---

## 1. Transport

- Endpoint: `ws://HOST:PORT/ws`. Use `wss://` only when a reverse proxy adds TLS. The path MUST be exactly `/ws`. The server refuses any other WebSocket upgrade path with HTTP 404 and destroys the socket.
- Static files for the browser client are served from `public/` by the same HTTP server on the same port.
- One WebSocket message is one frame. A frame is one JSON object encoded as UTF-8, sent as a text message.
- A binary message is a bad frame (section 7.2).
- Every object has a `type` string. Field names are case-sensitive, lowercase, with underscores.
- Unknown extra fields MUST be ignored by both sides. Unknown `type` values from the server MUST be ignored by clients.
- The inbound size limit is 4096 bytes of UTF-8 payload (section 7.3).
- Times are integers: milliseconds since the Unix epoch on the server's clock, named `ts`.
- Protocol-level ping and pong frames are handled by the WebSocket library and are not part of this protocol.

## 2. Values, normalisation and formatting

### 2.1 Normalisation

Every string value in a client frame, including `color` inside `fmt`, MUST be normalised before validation:

1. Replace each character in U+0000 to U+001F and U+007F to U+009F with a space.
2. Trim leading and trailing whitespace (JavaScript `String.prototype.trim` rules).

Lengths count Unicode code points (`[...s].length`), not UTF-16 units.

Normalisation does not change the internal spacing of text. Multiple spaces inside a message are kept.

### 2.2 Value rules

| Value | Rule after normalisation |
|---|---|
| Screen name | 3 to 10 characters, each A-Z, a-z or 0-9. Matches `^[A-Za-z0-9]{3,10}$`. |
| Room name | 1 to 24 code points. Each one A-Z, a-z, 0-9, space, `'`, `!`, `.` or `-`. Matches `^[A-Za-z0-9 '!.\-]{1,24}$`. |
| Reserved room name | Any name matching `^lobby [1-9][0-9]*$`, ignoring case. Member rooms MUST NOT use it. |
| Message text (`say`, `im`) | 1 to 250 code points. Empty after normalisation means the frame is ignored (section 7.6). |
| Away message (`set_away`) | 0 to 120 code points. Empty clears the away message. |
| Profile field (`location`, `hobbies`, `quote`) | 0 to 60 code points each. Absent means empty. |

Name comparisons are ASCII case-insensitive for screen names, room names, buddy names, ignore names and profile lookups.

A screen name is stored and displayed with the casing used at sign-on. A buddy entry keeps the casing typed when it was added, and the `online` mark is matched case-insensitively.

### 2.3 Rich text (`fmt`)

`fmt` is optional on `say` and `im`. Its value is either `null` or an object:

```
fmt = { "b": boolean, "i": boolean, "u": boolean, "color": string | null }
```

- Absent keys default to `false` for `b`, `i` and `u`, and to `null` for `color`.
- `color` MUST be one of the 16 values below, compared case-insensitively. The server stores the uppercase form.
- If all of `b`, `i` and `u` are false and `color` is null, the server treats the value as plain text.
- Outbound frames (`room_message`, `im`, `im_sent`) carry `fmt` as `null` for plain text. Otherwise they carry all four keys, with `color` in uppercase or `null`.

The 16 colours (Windows VGA palette, design choice):
`#000000 #800000 #008000 #808000 #000080 #800080 #008080 #C0C0C0 #808080 #FF0000 #00FF00 #FFFF00 #0000FF #FF00FF #00FFFF #FFFFFF`

Clients render `fmt` with DOM elements and styles only. They MUST NOT insert formatting as HTML.

### 2.4 Smileys

Smiley display is client-side only. The text on the wire is always as typed. Clients replace `:)`, `:(`, `;)`, `:D` and `:P` with the symbols listed in PARITY.md M10 after escaping, in the displayed line only.

## 3. Connection states

| State | Entered when | Frames accepted |
|---|---|---|
| UNSIGNED | The socket opens, or `signed_off` is sent. | `sign_on` only. Any other frame gets `not_signed_on`. |
| SIGNED-ON | `signed_on` is sent. | Every client frame except `sign_on`. `sign_on` gets `already_signed_on`. |

- A `sign_off` returns the same socket to UNSIGNED. The socket stays open.
- A socket that closes, for any reason, is treated as `sign_off` with no frame to the closing client. Section 8 rule O7 applies.
- All session state (room, buddy list, ignore list, away message, profile, idle timers) is discarded at sign-off.

## 4. Constants

| Name | Value | Notes |
|---|---|---|
| `FRAME_MAX_BYTES` | 4096 | Inbound payload limit. |
| `LOBBY_CAPACITY` | 23 | Default. Set by the `LOBBY_CAPACITY` environment variable. |
| `MEMBER_ROOM_CAPACITY` | 23 | Design choice. |
| `TEXT_MAX` | 250 | Room messages and IMs. |
| `AWAY_MAX` | 120 | |
| `PROFILE_FIELD_MAX` | 60 | Each of location, hobbies, quote. |
| `ROOM_NAME_MAX` | 24 | |
| `BUDDY_MAX` | 50 | |
| `IDLE_MINUTES` | 15 | Environment variable `IDLE_MINUTES`; decimals allowed. |
| `GRACE_MINUTES` | 5 | Environment variable `GRACE_MINUTES`; decimals allowed. |
| `PORT` | 1996 | Environment variable `PORT`. |

## 5. Client to server frames

Each frame lists its fields, the states it is accepted in, the frames it produces, and an example. Field errors are reported in the order the fields are listed here (section 7.5).

### 5.1 `sign_on` (UNSIGNED only)

Fields: `screen_name` (string, required; screen name rule).

Produces on success: `signed_on`, then `room_state` (automatic placement, section 11), then `room_list` (broadcast). On failure: `error` with `ref` `"sign_on"`, code `invalid_field` (field `"screen_name"`), `name_taken`, or `already_signed_on`.

Example: `{"type":"sign_on","screen_name":"Kaylee96"}`

### 5.2 `sign_off` (SIGNED-ON)

Fields: none.

Produces: section 8 rule O7. The final frame to the sender is `signed_off` with reason `"user"`.

Example: `{"type":"sign_off"}`

### 5.3 `list_rooms` (SIGNED-ON)

Fields: none.

Produces: `room_list`, to the sender only.

Example: `{"type":"list_rooms"}`

### 5.4 `create_room` (SIGNED-ON, C1 host behaviour optional)

Fields: `name` (string, required; room name rule).

Produces on success: `room_left` to the sender (reason `"switched"`) if the sender was in another room, `room_state` for the new room, then `room_list`. Member rooms are created with the sender as the only occupant and as host (C1).

Errors: `invalid_field` (field `"name"`), `room_name_reserved`, `room_name_taken`.

Example: `{"type":"create_room","name":"Cat Lovers"}`

### 5.5 `join_room` (SIGNED-ON)

Fields: `name` (string, required; room name rule). Matched case-insensitively against open rooms.

Produces: section 11.2. The joiner receives `room_left` (reason `"switched"`, when moving from another room), then `room_state`, then `room_list`.

Errors: `invalid_field` (field `"name"`), `no_such_room`, `room_full`.

Joining the room the sender is already in produces `room_state` only. It produces no notices and no `room_left`.

Example: `{"type":"join_room","name":"Lobby 2"}`

### 5.6 `leave_room` (SIGNED-ON)

Fields: none.

Produces: `room_left` to the sender (reason `"left"`), `member_left` to the other occupants (reason `"left"`), then automatic placement (section 11.1): `room_state` and `room_list`.

Example: `{"type":"leave_room"}`

### 5.7 `say` (SIGNED-ON)

Fields:
- `text` (string, required; message text rule).
- `fmt` (optional; section 2.3).

Produces: `room_message` to every occupant of the sender's room, including the sender, subject to section 12.1. Empty text produces nothing.

Errors: `invalid_field` (field `"text"` or `"fmt"` or `"fmt.color"`), `text_too_long` (field `"text"`).

Example: `{"type":"say","text":"hi all","fmt":{"b":true,"i":false,"u":false,"color":"#FF0000"}}`

### 5.8 `im` (SIGNED-ON)

Fields:
- `to` (string, required; screen name rule).
- `text` (string, required; message text rule). Empty text produces nothing.
- `fmt` (optional; section 2.3).

Produces: section 12.2 rules and order rule O8.

Errors: `invalid_field` (field `"to"`, `"text"` or `"fmt"`), `text_too_long` (field `"text"`), `invalid_target` (sender's own name), `recipient_offline` (field `"to"`).

Example: `{"type":"im","to":"Dan77","text":"you there?","fmt":null}`

### 5.9 `set_away` (SIGNED-ON)

Fields: `message` (string, required; away message rule). Empty clears.

Produces: `away_status` to the sender.

Errors: `invalid_field` (field `"message"`), `text_too_long` (field `"message"`).

Example: `{"type":"set_away","message":"brb"}`

### 5.10 `get_profile` (SIGNED-ON)

Fields: `screen_name` (string, required; screen name rule).

Produces: `profile` to the sender. If the name is not signed on, `signed_on` is false and the strings are empty.

Errors: `invalid_field` (field `"screen_name"`).

Example: `{"type":"get_profile","screen_name":"Kaylee96"}`

### 5.11 `set_profile` (SIGNED-ON)

Fields (all optional strings; absent means empty; profile field rule):
- `location`
- `hobbies`
- `quote`

Produces: `profile` to the sender, with the sender's name and the new values. The profile is not broadcast.

Errors: `invalid_field` (field `"location"`, `"hobbies"` or `"quote"`) when a value is longer than 60 code points.

Example: `{"type":"set_profile","location":"Ohio","hobbies":"chess, tennis","quote":"Hello world"}`

### 5.12 `buddy_add` (SIGNED-ON)

Fields: `screen_name` (string, required; screen name rule).

Produces: `buddy_list` to the sender. Adding a name already in the list changes nothing but still produces `buddy_list`.

Errors: `invalid_field` (field `"screen_name"`), `invalid_target` (the sender's own name), `buddy_limit` (list already holds `BUDDY_MAX` names).

Example: `{"type":"buddy_add","screen_name":"Dan77"}`

### 5.13 `buddy_remove` (SIGNED-ON)

Fields: `screen_name` (string, required; screen name rule).

Produces: `buddy_list` to the sender. Removing a name not in the list changes nothing but still produces `buddy_list`.

Errors: `invalid_field` (field `"screen_name"`).

Example: `{"type":"buddy_remove","screen_name":"Dan77"}`

### 5.14 `ignore` (SIGNED-ON)

Fields:
- `screen_name` (string, required; screen name rule).
- `on` (boolean, required).

Produces: `ignore_status` to the sender. The ignore list is per session and does not persist.

Errors: `invalid_field` (field `"screen_name"` or `"on"`), `invalid_target` (the sender's own name).

Example: `{"type":"ignore","screen_name":"Pest123","on":true}`

### 5.15 `report` (SIGNED-ON)

Fields: `screen_name` (string, required; screen name rule).

Produces: the server appends an incident holding only `screen_name` and `time` (ISO 8601, UTC). It sends `report_ack` to the sender. The reporter is not recorded and no message text is recorded.

Errors: `invalid_field` (field `"screen_name"`), `invalid_target` (the sender's own name).

Example: `{"type":"report","screen_name":"Pest123"}`

### 5.16 `still_here` (SIGNED-ON)

Fields: none.

Produces: nothing. It counts as activity for the idle timer (section 9).

Example: `{"type":"still_here"}`

### 5.17 `kick` (SIGNED-ON, C1 optional)

Fields: `screen_name` (string, required; screen name rule).

Produces, when the sender is the host of the sender's room: the target receives `room_left` (reason `"kicked"`), then `room_state` for an automatically placed lobby. The other occupants of the old room receive `member_left` (reason `"kicked"`).

Errors: `not_host`, `invalid_target` (target is not in the sender's room, or is the sender), `invalid_field` (field `"screen_name"`), `not_supported` (a build that omits C1 answers every `kick` with this code).

Example: `{"type":"kick","screen_name":"Pest123"}`

## 6. Server to client frames

### 6.1 `signed_on`

Sent once, to the requester, after a successful `sign_on`.

Fields: `screen_name` (string, the canonical casing).

Example: `{"type":"signed_on","screen_name":"Kaylee96"}`

### 6.2 `signed_off`

Sent to a user after a `sign_off` (reason `"user"`), after an idle sign-off (reason `"idle"`), or during shutdown (reason `"server_shutdown"`). After it, the connection is UNSIGNED, except after shutdown, when the socket closes.

Fields: `reason` (string: `"user"`, `"idle"` or `"server_shutdown"`).

Example: `{"type":"signed_off","reason":"idle"}`

### 6.3 `error`

Sent to the connection whose frame caused it. Section 7 defines it.

Example: `{"type":"error","code":"invalid_field","message":"Screen names are 3 to 10 letters or numbers.","ref":"sign_on","field":"screen_name"}`

### 6.4 `room_list`

Sent to the requester after `list_rooms`, and broadcast to every SIGNED-ON connection after any change to rooms or occupancy (rule O11).

Fields: `rooms`, an array of objects:
- `name` (string)
- `kind` (`"lobby"` or `"member"`)
- `count` (integer, current occupants)
- `capacity` (integer)

Order: lobbies by ascending number, then member rooms by name, case-insensitively.

Example: `{"type":"room_list","rooms":[{"name":"Lobby 1","kind":"lobby","count":23,"capacity":23},{"name":"Lobby 2","kind":"lobby","count":4,"capacity":23},{"name":"Cat Lovers","kind":"member","count":2,"capacity":23}]}`

### 6.5 `room_state`

Sent to a connection that has just entered a room, after `sign_on` placement, `join_room`, `create_room`, `leave_room` or `kick`. It is the signal that the connection is in the room, and it is always the last frame of its join sequence, before `room_list` (rule O4).

Fields:
- `room` (string)
- `kind` (`"lobby"` or `"member"`)
- `capacity` (integer)
- `members` (array of screen names, including the receiver, sorted case-insensitively)
- `host` (string or null; C1; always null for lobbies; null after the host leaves)
- `redirected_from` (string or null; the requested lobby name when a full lobby sent the joiner elsewhere; otherwise null)

Example: `{"type":"room_state","room":"Lobby 2","kind":"lobby","capacity":23,"members":["Dan77","Kaylee96"],"host":null,"redirected_from":"Lobby 1"}`

### 6.6 `room_left`

Sent to a connection that leaves a room.

Fields:
- `room` (string)
- `reason` (`"left"`, `"switched"` or `"kicked"`)

Example: `{"type":"room_left","room":"Lobby 2","reason":"switched"}`

### 6.7 `member_joined`

Sent to each occupant of a room, except the joiner, when someone enters.

Fields:
- `room` (string)
- `screen_name` (string)

Example: `{"type":"member_joined","room":"Lobby 2","screen_name":"Dan77"}`

### 6.8 `member_left`

Sent to each remaining occupant when someone leaves a room.

Fields:
- `room` (string)
- `screen_name` (string)
- `reason` (`"left"`, `"switched"`, `"kicked"` or `"signed_off"`; `"signed_off"` also covers a closed socket)

Example: `{"type":"member_left","room":"Lobby 2","screen_name":"Dan77","reason":"left"}`

### 6.9 `room_message`

Sent to every occupant of a room, including the sender, subject to section 12.1.

Fields:
- `room` (string)
- `from` (string, canonical screen name)
- `text` (string, normalised)
- `fmt` (object or null; section 2.3)
- `ts` (integer, milliseconds)

Example: `{"type":"room_message","room":"Lobby 2","from":"Kaylee96","text":"hi all","fmt":{"b":true,"i":false,"u":false,"color":"#FF0000"},"ts":1790000000000}`

### 6.10 `im`

Sent to the recipient of an IM, and to the sender as an automatic reply.

Fields:
- `from` (string, canonical screen name)
- `text` (string)
- `fmt` (object or null)
- `ts` (integer)
- `auto_reply` (boolean; `true` only for the automatic away reply)

Example: `{"type":"im","from":"Kaylee96","text":"you there?","fmt":null,"ts":1790000000100,"auto_reply":false}`

Automatic reply example: `{"type":"im","from":"Dan77","text":"brb","fmt":null,"ts":1790000000200,"auto_reply":true}`

### 6.11 `im_sent`

Sent to the sender of an IM after it is processed, whether or not it was delivered (section 12.2).

Fields:
- `to` (string, canonical screen name of the target)
- `text` (string)
- `fmt` (object or null)
- `ts` (integer)

Example: `{"type":"im_sent","to":"Dan77","text":"you there?","fmt":null,"ts":1790000000100}`

### 6.12 `away_status`

Sent to the sender after `set_away`.

Fields: `message` (string; `""` means the away message is cleared).

Example: `{"type":"away_status","message":"brb"}`

### 6.13 `profile`

Sent to the requester after `get_profile` or `set_profile`.

Fields:
- `screen_name` (string)
- `signed_on` (boolean; true when the name is signed on)
- `location`, `hobbies`, `quote` (strings; empty when `signed_on` is false)

Example: `{"type":"profile","screen_name":"Kaylee96","signed_on":true,"location":"Ohio","hobbies":"chess, tennis","quote":"Hello world"}`

### 6.14 `buddy_list`

Sent to the requester after `buddy_add` or `buddy_remove`. The list is the full list, in the order added.

Fields: `buddies`, an array of objects with `screen_name` (string, casing as typed when added) and `online` (boolean).

Example: `{"type":"buddy_list","buddies":[{"screen_name":"Dan77","online":true},{"screen_name":"Zed","online":false}]}`

### 6.15 `buddy_status`

Sent to each SIGNED-ON connection that has the name in its buddy list, when that name signs on or off (rule O7 covers sign-off). Ignore lists do not apply.

Fields:
- `screen_name` (string, canonical casing)
- `online` (boolean)

Example: `{"type":"buddy_status","screen_name":"Dan77","online":false}`

### 6.16 `ignore_status`

Sent to the requester after `ignore`.

Fields:
- `screen_name` (string)
- `ignored` (boolean)

Example: `{"type":"ignore_status","screen_name":"Pest123","ignored":true}`

### 6.17 `report_ack`

Sent to the reporter after `report`.

Fields: `screen_name` (string).

Example: `{"type":"report_ack","screen_name":"Pest123"}`

### 6.18 `idle_warning`

Sent once per idle period (section 9).

Fields: `grace_seconds` (integer, at least 1; `ceil(GRACE_MINUTES * 60)`).

Example: `{"type":"idle_warning","grace_seconds":300}`

## 7. Errors

### 7.1 Error object

```
{ "type": "error", "code": string, "message": string, "ref": string | null, "field": string | null }
```

- `code` is one of the codes in section 7.4.
- `message` is plain text, at most 200 characters. Clients show it verbatim, or the standard text in the table when they prefer to.
- `ref` is the `type` of the client frame that caused the error, or `null` when the frame could not be read.
- `field` is the name of the offending field (dotted for sub-fields such as `fmt.color`), or `null`.

### 7.2 Bad frames

A frame is bad when any of these hold: it is a binary message; it is not valid JSON; it parses to something other than a JSON object; its `type` is missing or not a string.

For a bad frame the server MUST:
- send `error` with code `bad_frame`, `ref` `null`, `field` `null`;
- leave the connection open and its state unchanged;
- count the frame as activity for the idle timer (section 9).

Clients MUST NOT retry a bad frame automatically.

### 7.3 Frames over the size limit

A text frame whose payload exceeds `FRAME_MAX_BYTES` (4096 bytes of UTF-8) is not parsed. The server closes the socket with WebSocket close code **1009** and sends no `error` frame. The socket is then treated as closed (section 3).

Clients MUST NOT send frames over 4096 bytes. A client that receives close code 1009 shows "Your message was too long" and returns to the sign-on window.

### 7.4 Error codes

| Code | When | `field` | Standard message |
|---|---|---|---|
| `bad_frame` | Frame could not be read (section 7.2). | null | That message could not be read. |
| `unknown_type` | `type` is a string the server does not know. `ref` is that string, cut to 40 characters. | null | The server does not know that request. |
| `not_signed_on` | A frame other than `sign_on` arrives while UNSIGNED. | null | Sign on first. |
| `already_signed_on` | `sign_on` arrives while SIGNED-ON. | null | You are already signed on. |
| `invalid_field` | A field is missing, has the wrong JSON type, or fails its rule. | the field | Specific text, for example "Screen names are 3 to 10 letters or numbers." |
| `name_taken` | The screen name is signed on by someone else. | `screen_name` | That screen name is already signed on. Try another. |
| `text_too_long` | `text` or `message` is longer than its limit. | `text` or `message` | Messages can be at most 250 characters. |
| `room_name_reserved` | A member room name matches the reserved pattern. | `name` | Names like Lobby 1 are reserved for public lobbies. |
| `room_name_taken` | A member room with that name is open. | `name` | A room with that name is already open. |
| `no_such_room` | `join_room` names a room that is not open. | `name` | That room is no longer open. |
| `room_full` | A member room is at `MEMBER_ROOM_CAPACITY`. | `name` | That room is full. Try another room. |
| `recipient_offline` | The IM target is not signed on. | `to` | That screen name is not signed on. |
| `invalid_target` | The target is the sender, or the target is not in the sender's room for `kick`. | `screen_name` or `to` | You cannot do that to yourself. |
| `buddy_limit` | The buddy list already holds `BUDDY_MAX` names. | `screen_name` | Your buddy list is full. |
| `not_host` | `kick` from someone who is not the host. | `screen_name` | Only the host can do that. |
| `not_supported` | The server omits an optional feature (C1). | null | This server does not support that. |
| `internal_error` | An unexpected server fault. The connection stays open. | null | Something went wrong on the server. |

### 7.5 Field validation order

When a frame has more than one bad field, the server reports the first bad field in the order the frame's fields are listed in section 5. It reports one error per frame.

### 7.6 Ignored frames

A `say` or `im` whose text is empty after normalisation is accepted and produces nothing. No error is sent.

## 8. Ordering rules

- **O1.** The server handles each connection's frames in arrival order. All frames caused by one client frame are sent before any frame caused by the next.
- **O2.** Before a successful `sign_on`, the server sends only error frames, each a reply to that connection's own frame.
- **O3.** A successful `sign_on` sends exactly this sequence: `signed_on`, then `room_state` for the placed lobby, then `room_list`. No room frame reaches the connection before `signed_on`.
- **O4.** For a connection that changes rooms (join, create, leave, kick), its frames are, in order: `room_left` for the old room if it was in one, then `room_state` for the new room, then `room_list`. `room_state` is always the last room frame of the join sequence.
- **O5.** A connection receives `room_message`, `member_joined` and `member_left` for room R only while it is in R, and never before its `room_state` for R.
- **O6.** An `error` frame is sent only to the connection whose frame caused it, with `ref` set.
- **O7.** When a user signs off or their socket closes, the server sends: `member_left` (reason `"signed_off"`) to the other occupants of the room; `buddy_status` (`online` false) to watchers; `room_list` to the other SIGNED-ON connections; then, for `sign_off` only, `signed_off` as the user's final frame. A user who is signing off receives no `room_list` after `signed_off`.
- **O8.** For an IM, the server sends: `im` to the recipient (if delivered), then `im_sent` to the sender, then the automatic reply `im` to the sender (if one applies).
- **O9.** `idle_warning` precedes `signed_off` with reason `"idle"` for the same idle period.
- **O10.** On shutdown, each SIGNED-ON connection receives `signed_off` (reason `"server_shutdown"`) before its socket is closed.
- **O11.** `room_list` is broadcast after any change to the set of rooms or to occupancy, and only to SIGNED-ON connections.
- **O12.** Frames from one sender reach each recipient in the order the server processed them.

## 9. Idle handling

- The idle timer starts at `sign_on`. Any inbound WebSocket message from the client resets it, including bad frames and `still_here`. Protocol-level ping and pong do not count.
- After `IDLE_MINUTES` with no activity, the server sends `idle_warning` with `grace_seconds` set to `ceil(GRACE_MINUTES * 60)` and starts the grace timer.
- Activity during the grace period cancels the grace timer and restarts the idle timer. A new warning is sent only after a new idle period.
- If the grace timer expires with no activity, the server sends `signed_off` with reason `"idle"` and returns the connection to UNSIGNED (rule O9).
- Timers stop at sign-off and start again at the next `sign_on`.
- Timer accuracy: each deadline fires within 250 milliseconds of its time in tests (PARITY.md S6).

Design choice: the server sends a WebSocket ping every 30 seconds and terminates a connection that has not answered before the next ping. Termination follows section 3.

## 10. Shutdown

On SIGINT or SIGTERM, the server sends `signed_off` with reason `"server_shutdown"` to each SIGNED-ON connection, then closes each socket with close code **1001** and reason text "server shutting down", then exits.

## 11. Rooms and placement

### 11.1 Automatic placement

Used by `sign_on`, `leave_room`, and `kick`.

- Scan lobbies in ascending number. Join the first lobby with `count` less than `LOBBY_CAPACITY`.
- If none has room, create the lobby numbered one more than the highest existing lobby number, and join it.
- The result is a `room_state` with `redirected_from` null.

### 11.2 Joining by name

Used by `join_room`.

1. If the sender is already in the named room, send `room_state` again and stop.
2. If the name does not match an open room, send `no_such_room`.
3. For a member room: if `count` is at `MEMBER_ROOM_CAPACITY`, send `room_full`. Otherwise join.
4. For a lobby `Lobby N`: if `count` is below `LOBBY_CAPACITY`, join it with `redirected_from` null.
5. Otherwise try `Lobby k` for k = N+1, N+2, and so on. For the first k where the lobby exists and has room, join it. For the first k where the lobby does not exist, create it and join it. In both cases `redirected_from` is `"Lobby N"`.

### 11.3 Creating a member room

Used by `create_room`. The name is checked (section 2.2), then the sender leaves the current room (section 11.4) and creates the room with `count` 1 and `host` set to the sender. The sender then gets `room_state`.

### 11.4 Leaving and removal

- A departure reduces `count`. Before the `room_list` broadcast, empty member rooms are removed, and empty lobbies other than Lobby 1 are removed.
- Lobby 1 is created at start-up and is never removed.
- `host` becomes `null` in a member room when its host leaves or signs off. Host rights do not pass to anyone (PARITY.md C1).

## 12. Delivery rules

### 12.1 Room messages

A `room_message` from S to occupant R is delivered unless R has S in its ignore list. The sender always receives its own messages.

Arrival and departure notices (`member_joined`, `member_left`) are delivered regardless of the ignore list (design choice; PARITY.md S4).

### 12.2 Instant messages

For an `im` from S to T:

1. If T is S: send `invalid_target` to S. Stop.
2. If T is not SIGNED-ON: send `recipient_offline` to S. Stop.
3. If T has S in its ignore list: T receives nothing and no automatic reply is sent. Go to step 5.
4. Otherwise T receives `im` with `auto_reply` false. If T has a non-empty away message, S then receives `im` from T with `auto_reply` true and the away text.
5. S receives `im_sent` (section 6.11) in every case from step 3 onward.

Rule O8 gives the frame order.

### 12.3 Buddy watchers

When a name signs on or off, the server sends `buddy_status` to every SIGNED-ON connection whose buddy list contains that name, case-insensitively. The ignore list does not apply.

### 12.4 Away messages

An away message is set per session with `set_away` and is cleared at sign-off or when `set_away` is sent with an empty message.

## 13. Client behaviour (required for interoperability)

- The browser opens the socket when the page loads and sends `sign_on` from the sign-on window.
- Clients mirror the validation in section 2 before sending, to avoid round trips. The server's answer is authoritative.
- Clients never send frames over 4096 bytes.
- Clients show `error` frames in a dialog (PARITY.md C2). They do not retry automatically.
- Clients ignore unknown server `type` values and unknown fields.
- Clients keep `room_state` as the source of truth for the people list, and update it with `member_joined` and `member_left`.
- When the socket closes, the client shows "Connection lost" and returns to the sign-on window. Version 1 has no automatic reconnect (open question).

## 14. Conformance checklist

A server conforms when it:
- accepts only the frames allowed in each state (section 3);
- applies the normalisation and limits in section 2;
- sends frames in the orders in section 8;
- returns the error codes in section 7.4 for the conditions listed;
- applies sections 9 to 12 exactly.

A client conforms when it sends only frames defined here, handles every server frame in section 6 in any order that section 8 allows, and never sends a frame over 4096 bytes.

---

## 15. Server addenda

These items fill gaps that sections 1 to 14 leave open. The server build added them. A client that follows sections 1 to 14 and handles these items conforms.

- **A1. Rate limit (new error code `rate_limited`).** Each connection may send a burst of 20 frames, then 5 frames per second. The limit is measured on a monotonic clock, so a change to the time of day never affects it. A frame over the limit is dropped without being processed. The server sends one `error` for each dropped frame, with code `rate_limited`, `field` null, the message "You are sending messages too fast. Wait a moment." and `ref` set to the type of the dropped frame, cut to 40 characters as in section 7.1. When the dropped frame has no readable type (it is binary, or it is not a JSON object with a string `type`), `ref` is null. Every dropped frame gets its own error, so a client can match each one to the frame it sent, in the order sent. This replaces the earlier rule of at most one such error per second, which left a client unable to tell which frame had been dropped. The connection stays open. A dropped frame still counts as activity for the idle timer (section 9). Clients show the message, do not retry automatically, and keep the user's typed text so that nothing is lost. Clients should pace their frames to the same bucket, so that the server drops nothing.
- **A2. Idle sign-off order.** An idle sign-off (section 9) uses the order of rule O7 for `sign_off`. The server sends `member_left` (reason `"signed_off"`) to the other occupants, `buddy_status` (online false) to watchers, `room_list` to the other SIGNED-ON connections, and then `signed_off` with reason `"idle"` as the user's final frame.
- **A3. Host leaves.** When the host of a member room leaves that room, by `leave_room`, by joining or creating another room, or by signing off or closing the socket, the remaining occupants get `member_left` as usual. Then they get `room_state` for the same room with `host` null and the current `members`. A `room_state` for a room the connection is already in replaces its member list and host. It does not start a new entry. Rule 11.2 step 1 already sends `room_state` this way.
- **A4. Redirect onto the joiner's own lobby.** If the search in rule 11.2 step 5 reaches a lobby that the joiner is already in and that lobby has room, the server sends `room_state` for it with `redirected_from` set to the requested lobby. No notices are sent.
- **A5. Leave can return to the same lobby.** `leave_room` places the sender by rule 11.1, which can choose the lobby the sender just left. The others then get `member_left` (reason `"left"`), then `member_joined` for the sender.
- **A6. Field names for `fmt` errors.** A `fmt` that is not an object, or whose `b`, `i` or `u` is not a boolean, is `invalid_field` with field `"fmt"`. A `color` that is not one of the 16 values is `invalid_field` with field `"fmt.color"`. PARITY.md S7 names both fields.
- **A7. Check order.** Fields are checked in the order of section 5. Target rules come after field rules. For `kick`, `not_host` is checked before `invalid_target`. For `say` and `im`, an empty `text` produces nothing only after the fields before it are valid. For `im`, that means `to` is checked first.
- **A8. `ref` length.** The `ref` of every `error` frame is the request type cut to 40 characters, not only the `ref` of `unknown_type`.
- **A9. Names in replies.** `ignore_status.screen_name`, `report_ack.screen_name` and `profile.screen_name` use the canonical casing when the name is signed on. Otherwise they use the name as typed, after normalisation.
- **A10. Shutdown.** While the server is shutting down, a new WebSocket upgrade on `/ws` gets HTTP 503 and the socket is closed.
- **A11. Local transport boundary (v0.1.0).** HTTP and WebSocket Host names must be loopback names at the actual server port. Browser WebSocket Origin must match `http://HOST`; absent Origin is allowed for protocol clients. Rejected hosts/origins get HTTP 403. At 128 WebSocket clients the next upgrade gets HTTP 429. A client whose queued output exceeds 64 KiB is closed with code 1013. See [SECURITY.md](../SECURITY.md).
- **A12. Retention limits (v0.1.0).** Each session may ignore up to 100 distinct names. Adding a new name at the limit returns `error` with code `ignore_limit`, message "Your ignore list is full.", ref `ignore` and field `screen_name`. Re-adding an existing entry remains successful; removal frees a slot. The incident log retains the newest 500 reported-name/time pairs; older entries are discarded. Console report output is unchanged.
