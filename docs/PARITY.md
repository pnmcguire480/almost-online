# Chat Room '96: Parity Checklist

Version 0.1. Companion files: `PROTOCOL.md` (wire contract), `BACKLOG.md` (tier 3).

Historical implementation checklist for the original **Chat Room '96** scope. The current product is **Almost Online**, an unofficial AOL-era parody with a Fate X tribute. The visual branding below was superseded; see [VISUALS.md](VISUALS.md). This document is a design contract with source-confidence labels, not a claim of exact historical binary parity. Current security and resource limits are in [SECURITY.md](../SECURITY.md).

## How to read this file

- IDs follow the seed scope: **M** = Must, **S** = Should, **C** = Could.
- Each item has three parts:
  - **Behaviour**: one sentence.
  - **Acceptance**: checks a test can run. `[proto]` is checked over the WebSocket using the frames in `PROTOCOL.md`. `[browser]` is a manual check in a browser at `http://localhost:PORT`.
  - **Source**: a research key from the Source key at the end, or `design choice` with the reason.
- Research tags: **verified** = the page was fetched and read. **memory** = a search snippet or recall, not read in full. **recalled** = a reconstruction in the look research that needs checking. **standard** = a Windows 95 default. **none** = no source was found.
- Mark an item done only when every acceptance check for it passes.

---

## Config

All values are defaults. Values set by environment variables are read once at start-up. A value that is not a positive number stops start-up with a message that names the variable.

| Name | Default | Environment variable | Source |
|---|---|---|---|
| Lobby capacity (people per public lobby) | 23 | `LOBBY_CAPACITY` (added so tests can fill lobbies with few sockets) | seed; R-A1 memory. Env var: design choice |
| Member room capacity | 23 | none | design choice: no source, same as lobbies |
| Port | 1996 | `PORT` | seed. `PORT` is the usual Node convention |
| Message maximum (room messages and IMs) | 250 characters | none | seed. R-A17 memory suggests about 92; see open questions |
| Away message maximum | 120 characters | none | design choice |
| Profile field maximum (location, hobbies, quote) | 60 characters each | none | design choice |
| Room name maximum | 24 characters | none | design choice |
| Buddy list maximum | 50 names | none | design choice |
| Inbound frame maximum | 4096 bytes (UTF-8) | none | design choice; see PROTOCOL.md section 7 |
| Idle warning after | 15 minutes with no frames | `IDLE_MINUTES` (decimals allowed) | seed |
| Grace period after the idle warning | 5 minutes | `GRACE_MINUTES` (decimals allowed) | seed |

Test values: `IDLE_MINUTES=0.01` and `GRACE_MINUTES=0.01` give a 0.6 second idle warning and a 0.6 second grace period.

---

## Non-goals

**2026-10-16 visual-scope update:** Almost Online parody branding and Fate X tribute styling supersede the generic-brand restriction below. See [VISUALS.md](VISUALS.md).

- **No accounts and no passwords.** A user signs on with a screen name only. The sign-on window has no password field, no Setup button and no Remember Password checkbox, which the look research recalled. Nothing is stored that would need a password.
- **No server-side chat history.** Messages exist only in the windows that receive them. A user who joins a room sees no earlier messages.
- **No persistence across server restarts.** All state (rooms, members, buddy lists, ignore lists, away messages, profiles, incidents) is held in memory.
- **No real AOL or other company names, logos, icons, audio or artwork.** The product is named "Chat Room '96". Period spoken clips (the recalled "Welcome" and "Goodbye") are not reproduced.
- **No native mobile app.** The browser client is the only client.
- **No file transfer, voice, video, or end-to-end encryption.** The transport is plain WebSocket (`ws://`), with `wss://` only if a reverse proxy adds TLS.
- **No federation.** One server process serves one set of rooms.

---

## Must (M)

### M1. Sign on with a screen name

- **Behaviour:** The sign-on window takes one screen name and signs the user on when the name is valid and not already signed on.
- **Rules:** 3 to 10 characters, each one of A-Z, a-z or 0-9, after trimming spaces. Uniqueness ignores upper and lower case.
- **Acceptance:**
  - `[proto]` `sign_on` with `"abc"` returns `signed_on`. `"ab"`, `"abcdefghijk"` and `"a b"` each return `error` with code `invalid_field` and field `"screen_name"`.
  - `[proto]` With `"abc"` signed on, a second connection sending `sign_on` with `"ABC"` gets `name_taken`. The first connection is unaffected.
  - `[browser]` A bad name shows an error box with an OK button. Pressing Enter in the name field submits the form.
- **Source:** R-B5 (sign-on window, recalled) for the window. The length and character rules come from the seed. No research source covers screen-name rules (see open questions). Password fields omitted: design choice, because accounts and passwords are a non-goal.

### M2. Room list with names and occupancy

- **Behaviour:** A Rooms window lists every open room with its name, its kind (lobby or member room) and its occupancy, written as "count of capacity".
- **Acceptance:**
  - `[proto]` `list_rooms` returns `room_list`. For each room, `count` equals the length of that room's `members` in `room_state`.
  - `[browser]` The Rooms window has one row per room. A lobby row reads "N of 23" when N people are in it.
- **Source:** Existence of a room catalogue: R-A3 (verified count of 5,122 public rooms; the list interface is not described). The occupancy display is a design choice: no source describes the list layout, so counts are shown to let users pick a room that is not full.

### M3. Public lobbies with overflow

- **Behaviour:** Public lobbies are named "Lobby 1", "Lobby 2" and so on, each holds up to the lobby capacity, and a join to a full lobby is placed in the next lobby, which is created when needed.
- **Acceptance:** Run with `LOBBY_CAPACITY=2`.
  - `[proto]` Five users sign on one after another. The rooms are Lobby 1 with 2 people, Lobby 2 with 2 people, and Lobby 3 with 1 person.
  - `[proto]` With Lobby 1 and Lobby 2 full, a user who sends `join_room` with `"Lobby 1"` receives `room_state` for `"Lobby 3"` with `redirected_from` set to `"Lobby 1"`.
  - `[proto]` When Lobby 2 becomes empty it disappears from `room_list`. Lobby 1 never disappears.
- **Source:** Capacity of about 23 and the overflow to a second lobby: R-A1 (memory, search snippet) and R-A2 (memory, search snippet). The seed sets 23. Placement rules are design choices in PROTOCOL.md section 11.

### M4. Create a member room and join rooms by name

- **Behaviour:** A user creates a named member room, which they then occupy, and joins any open room by typing its name.
- **Acceptance:**
  - `[proto]` `create_room` with `"Cats"` returns `room_state` with kind `"member"`. `room_list` then shows Cats.
  - `[proto]` `create_room` with `"cats"` while Cats is open returns `room_name_taken`. `create_room` with `"Lobby 9"` returns `room_name_reserved`.
  - `[proto]` `join_room` with `"CATS"` returns `room_state` for `"Cats"`. `join_room` with `"Nowhere"` returns `no_such_room`.
  - `[proto]` After the last occupant leaves, Cats is removed from `room_list`.
  - `[browser]` The Create button in the Rooms window opens a dialog that asks for a room name.
- **Source:** R-A4 (verified: a member-created "Buddy Chat Room" in a 1999 edition, not 1996). That the feature existed in 1996 is memory-level. The rules for names, reserved names and removal are design choices.

### M5. Room messages to everyone, sender included

- **Behaviour:** Text typed in the send box appears to every occupant of the room as "SN: text", the sender included, and empty or over-long text is not sent.
- **Acceptance:**
  - `[proto]` With A and B in the same room, `say` from A with `"hi"` produces `room_message` with `from` `"A"` and `text` `"hi"` for both A and B.
  - `[proto]` `say` with only spaces produces no frame to anyone. `say` with 251 characters produces `text_too_long` to the sender only.
  - `[browser]` Typing "hi" and pressing Enter puts "A: hi" in both windows' logs, with "A:" in bold. The send box is a single line.
- **Source:** Line format and bold name: R-B4 (recalled). The 250-character limit is from the seed. R-A17 (memory) suggests about 92 characters, which is unverified. The Enter-to-send rule is a design choice.

### M6. People-in-room list with count, live

- **Behaviour:** The people list in the chat window shows every occupant's screen name in alphabetical order under a header with the count, and it updates as people arrive and leave.
- **Acceptance:**
  - `[proto]` `room_state.members` is sorted case-insensitively and includes the receiver.
  - `[proto]` After B joins, A receives `member_joined` for `"B"`. After B leaves, A receives `member_left` for `"B"`.
  - `[browser]` The header reads "People (N)". The list matches the most recent `room_state` plus the arrival and departure frames.
- **Source:** None for the behaviour (R-A6: no source found). The right-hand column comes from the chat window layout (R-B4, recalled). The sort order and the header text are design choices.

### M7. Arrival and departure notices

- **Behaviour:** When someone enters or leaves a room the user is in, a system line appears in that room's log, and the door chime plays when sound is on.
- **Acceptance:**
  - `[proto]` B joining a room that A is in makes the server send `member_joined` to A. B leaving with the "left" reason makes the server send `member_left` with reason `"left"` to A. Switching rooms sends reason `"switched"`.
  - `[browser]` The log shows "B has entered the room." in green (#008000) or "B has left the room." in green. The line appears once per event.
- **Source:** None for behaviour or wording (R-A7: no source found). The client builds these lines from `member_joined` and `member_left`, so the server sends facts only. The wording and colour are design choices. Colour follows the notice colours in R-B2 (design, not period-verified).

### M8. Instant messages with a pop-up window, reply and offline notice

- **Behaviour:** A user sends a private message to a signed-on screen name from the people list, the recipient's IM window pops up with it, the recipient replies in that same window, and a "not signed on" notice appears for offline names.
- **Acceptance:**
  - `[proto]` `im` from A to `"B"` makes the server send `im` to B (with `auto_reply` false) and `im_sent` to A.
  - `[proto]` `im` to a name that is not signed on returns `recipient_offline` with field `"to"`. Nothing else is sent.
  - `[proto]` B sending `im` back to `"A"` delivers to A with `from` `"B"`. A's window for B is the same window used before.
  - `[browser]` An incoming IM opens a window titled "Instant Message from A", or brings the open one to the front. Its reply box sends, and the reply appears in the same window.
- **Source:** Offline behaviour: R-A8 (memory, Aug 1994 Mac FAQ snippet: a message to someone not signed on is reported as not received and discarded). The visible notice follows that report and the seed. The pop-up window and title are design choices, with R-B5 (dialogs, recalled) for the look.

### M9. Leave, switch rooms, sign off

- **Behaviour:** A user can leave the current room, which places them in an open lobby, switch to another room, or sign off, which returns to the sign-on window while the connection stays open.
- **Acceptance:**
  - `[proto]` `leave_room` returns `room_left` with reason `"left"`, then `room_state` for a lobby. The others in the old room receive `member_left` with reason `"left"`.
  - `[proto]` `sign_off` returns `signed_off` with reason `"user"`. A later `sign_on` on the same connection succeeds without reconnecting.
  - `[browser]` The Sign Off button returns to the sign-on window. Entering a new name there signs on again.
- **Source:** Sign-off window: R-B5 (recalled). The Goodbye clip is not reproduced (non-goal). Leave-to-lobby is a design choice: no source describes leaving, and this rule means the chat window is never without a room.

### M10. Typed smileys shown as symbols

- **Behaviour:** The typed faces `:)`, `:(`, `;)`, `:D` and `:P` appear as symbols in room messages and IMs, and the text sent over the wire stays as typed.
- **Mapping (display only):** `:)` shows U+263A, `:(` shows U+2639, `;)` shows U+1F609, `:D` shows U+1F603, `:P` shows U+1F61B.
- **Acceptance:**
  - `[proto]` `say` with `":)"` delivers `text` `":)"` unchanged.
  - `[browser]` A message containing `:)` shows U+263A in the log. The other four faces show their symbols as listed. The text is replaced only in the displayed line.
- **Source:** Typed emoticon origin: R-A15 (verified: a September 1982 bulletin-board post, per the Wikipedia article). Typed faces converted to icons by default: R-A15 (memory, SAGE snippet, about instant messaging). Its use in chat rooms is unconfirmed. The glyphs are a design choice, since period artwork is a non-goal.

### M11. All user text is escaped

- **Behaviour:** Every piece of user text (screen names, room names, messages, IMs, away and profile text) is shown as plain text and is never parsed as HTML or run as script.
- **Acceptance:**
  - `[proto]` A message containing `<script>alert(1)</script>` is delivered unchanged as text. The server does no HTML handling.
  - `[browser]` Sending `<img src=x onerror=alert(1)>` shows the literal characters in the log. No dialog appears and no `img` element is added to the log (DOM check).
  - `[browser]` Code review: client code puts user data into the page only with `textContent` or `document.createTextNode`. `innerHTML` is not used with any user-supplied value.
- **Source:** Design choice: any text from another person is untrusted input. The rule is in the seed (M11). No research source covers it.

---

## Should (S)

### S1. Buddy list with online and offline status and alerts

- **Behaviour:** A Buddies window lists the screen names the user has added, marked Online or Offline, and a buddy's sign-on or sign-off updates that mark, plays a chime and writes a notice line in the open chat window.
- **Acceptance:**
  - `[proto]` A sends `buddy_add` for `"B"`. The reply is `buddy_list` with B `online` false. When B signs on, A receives `buddy_status` with `online` true. When B signs off, A receives `online` false.
  - `[proto]` `buddy_add` with an invalid name returns `invalid_field`. The 51st buddy returns `buddy_limit`.
  - `[proto]` After A signs off and signs on again, A's buddy list is empty.
  - `[browser]` The Buddies window shows "B - Online" or "B - Offline". A status change plays the chime when sound is on.
- **Source:** Origin of the buddy list: R-A9 (verified: built after users wrote scripts that looked up friends by screen name and overloaded the service). The source gives no launch year and no sign-on alerts. Alerts, status text and the reset on sign-off are design choices. Lists are session-only because there are no accounts (open question).

### S2. Away message with an automatic reply

- **Behaviour:** A user can set an away message, and an IM to that user is delivered and also returns the away message to the sender as an automatic reply.
- **Acceptance:**
  - `[proto]` B sets an away message with `set_away` `"brb"`, and the reply is `away_status` with `message` `"brb"`. When A sends B an `im`, B receives it with `auto_reply` false. A receives `im_sent`, then an `im` from B with `auto_reply` true and text `"brb"`.
  - `[proto]` `set_away` with `""` clears the message. The next IM gets no automatic reply.
  - `[proto]` Signing off clears the away message.
- **Source:** Function: R-A10 (verified: a Smithsonian article says away messages began as a corporate necessity; a second article describes them as more informative than an answering machine). The 1996 launch date on the service is not found (memory-level at best). The automatic reply follows the seed. Its order of frames is a design choice.

### S3. Member profiles: view, and edit your own

- **Behaviour:** Get Info shows a signed-on user's location, hobbies and quote, and a user can edit their own profile, which is kept only while they are signed on.
- **Acceptance:**
  - `[proto]` `set_profile` with location `"Ohio"`, hobbies `"chess"` and quote `"hi"` returns `profile` for the sender with `signed_on` true and the same values.
  - `[proto]` `get_profile` for `"A"` from B returns the same values with `signed_on` true. `get_profile` for a name that is not signed on returns `signed_on` false and empty strings.
  - `[proto]` A field of 61 characters returns `invalid_field` with the field's name.
  - `[proto]` After A signs off, `get_profile` for A returns `signed_on` false.
  - `[browser]` Get Info opens a window with three fields. When `signed_on` is false it reads "No one by that name is signed on."
- **Source:** Profiles existed: R-A11 (verified: a 1999 guide lists "Creating a Profile" and "Reading Someone's Profile"; a 1995 non-member FAQ says the member directory was voluntary). The three fields follow the seed. The longer field list in R-A11 is memory (a 2003 forum snippet) and is not used. Profile lifetime is a design choice: with no accounts, a stored profile would let anyone who signs on under that name inherit it.

### S4. Ignore a screen name

- **Behaviour:** Ignoring a screen name hides that person's room lines and IMs for the user, enforced on the server, and the ignored person is not told.
- **Acceptance:**
  - `[proto]` After A sends `ignore` for `"B"` with `on` true, A does not receive `room_message` from B. Other occupants still receive it.
  - `[proto]` B's `im` to A is not delivered to A. B still receives `im_sent`.
  - `[proto]` `ignore` with `on` false restores delivery.
  - `[browser]` B's lines are absent from A's log. B still appears in A's people list, and B's arrival and departure lines still appear.
- **Source:** R-A12 (memory: an IM-based off switch in a 1994 FAQ; no source describes ignoring in a room). Server enforcement follows the seed. Keeping arrival and departure lines and the people list visible is a design choice (open question).

### S5. Report a screen name

- **Behaviour:** Reporting a screen name records an incident on the server with only the reported name and the time, and the reporter sees a confirmation.
- **Acceptance:**
  - `[proto]` `report` for `"B"` returns `report_ack` with `screen_name` `"B"`.
  - `[proto]` The incident store holds entries with exactly two fields, `screen_name` and `time` (ISO 8601, UTC). It holds no reporter name and no message text. A unit test on the incident module checks this.
  - `[browser]` Report, in the people list, shows a confirmation box after the report is acknowledged.
- **Source:** Concept: R-A13 (verified: a Notify button for chat rooms appears in a 1999 guide; the 1996 existence is unconfirmed). The retained fields and the confirmation text are design choices. Retention is flagged once in open questions and does not block the build.

### S6. Idle warning and automatic sign-off

- **Behaviour:** After IDLE_MINUTES with no frames from the user, a dialog asks "Are you still there?" with a Yes button, and if there is no answer within GRACE_MINUTES the user is signed off.
- **Acceptance:** Run with `IDLE_MINUTES=0.01` and `GRACE_MINUTES=0.01`.
  - `[proto]` A signed-on connection that sends nothing receives `idle_warning` with `grace_seconds` 1 at about 0.6 seconds, then `signed_off` with reason `"idle"` about 0.6 seconds later. Each time is accurate to within 250 milliseconds.
  - `[proto]` A `still_here` frame sent during the grace period cancels the countdown. No sign-off follows.
  - `[browser]` The dialog appears with a Yes button. Clicking Yes sends `still_here`.
- **Source:** R-A14 (no source found; the idle prompt is an unverified recollection). The timing and 15 and 5 minute defaults come from the seed. The rule that any inbound frame counts as activity is a design choice.

### S7. Rich text in your own messages

- **Behaviour:** A user can make a message bold, italic or underlined, or give it one of 16 colours, and everyone sees the formatting without any HTML.
- **Acceptance:**
  - `[proto]` `say` with `fmt` `{"b":true,"i":false,"u":false,"color":"#ff0000"}` is delivered with `fmt` `{"b":true,"i":false,"u":false,"color":"#FF0000"}`.
  - `[proto]` A colour outside the 16-value palette, or a non-boolean `b`, returns `invalid_field` with field `"fmt"` or `"fmt.color"`.
  - `[browser]` A bold message renders its text inside a `span` with bold weight. The DOM check shows no `innerHTML` use for message text.
- **Source:** R-A16 (memory: no AOL source found; RealChat 2.0 had bold and italic buttons, but RealChat is not a service in the research). The allowlist and palette are design choices, chosen so that formatting stays safe under M11. The 16 colours are the Windows VGA palette, listed in PROTOCOL.md section 2.

### S8. Synthesized sounds with a mute toggle

- **Behaviour:** A door chime plays for arrivals and departures, an IM ding plays for incoming IMs, both are made with WebAudio, and a Sounds toolbar button mutes all of them.
- **Acceptance:**
  - `[browser]` No audio file is requested. The network panel shows no `.wav`, `.mp3` or `.ogg` requests.
  - `[browser]` With Sounds off, an arrival creates no oscillator (checked with a stub of the audio context in the console). The button reads "Sounds: Off".
  - `[browser]` The mute setting survives a page reload when localStorage is available. When localStorage is blocked, the page still works and the setting lasts for the page only.
  - `[browser]` The first sound plays only after a click, because browsers block audio before a user gesture. The sound starts on the click that signs on.
- **Source:** Design choice. Sounds are synthesized so that no period audio is copied (non-goal). The research records the spoken Welcome and Goodbye clips (R-B5) and they are not used. The chime's pitch and length are design choices.

### S9. 1996 look

- **Behaviour:** The interface uses Windows 95-era bevelled grey windows and buttons on a teal desktop, with blue title bars and a chat window that has a message log, a people list, a send box and a toolbar.
- **Acceptance:**
  - `[browser]` The page background computes to `rgb(0, 128, 128)`. An active title bar computes to `rgb(0, 0, 128)` with white text. Raised and sunken regions use inset box shadows, per the build notes in R-B6.
  - `[browser]` No element has a border radius, a gradient, or a shadow outside its bevel.
  - `[browser]` The chat window opens at about 480 by 360 pixels and resizes. Its toolbar has the buttons Rooms, People, Buddies, Away, Sounds, Leave and Sign Off.
  - `[browser]` UI text uses `"MS Sans Serif"` at 11px. Chat log text uses Arial at 12px. Both fall back to Arial and sans-serif.
- **Source:** R-B1 (standard, Windows 95 window metrics), R-B2 (standard colours), R-B3 (standard fonts, with the chat log size recalled), R-B4 (chat window layout, recalled; the toolbar set is a design choice based on it), R-B6 (build notes, design). The look research was not checked against a period screenshot, so every AOL-specific layout detail is recalled.

---

## Could (C)

### C1. Host marks and kick

- **Behaviour:** The creator of a member room is its host, is marked in the people list, and can remove one occupant with a kick, and the host role ends when the host leaves.
- **Acceptance:**
  - `[proto]` After `create_room`, `room_state.host` is the creator's name. For lobbies `host` is null.
  - `[proto]` A non-host's `kick` returns `not_host`. The host's `kick` of another occupant sends that person `room_left` with reason `"kicked"`, then `room_state` for a lobby. The others receive `member_left` with reason `"kicked"`.
  - `[proto]` When the host leaves, the remaining occupants see `host` null. Host rights do not pass to anyone.
  - `[browser]` The host's name in the people list carries the text "(Host)".
- **Source:** R-A5 (verified: Volunteer Community Leaders hosted chat rooms). The research gives no visible host badge and no "OH" prefix, so the "(Host)" mark, the kick control and the no-transfer rule are design choices.

### C2. Period-worded notices

- **Behaviour:** Errors such as a full room appear in Windows 95-style message boxes with period-style wording taken from the table in PROTOCOL.md section 7.
- **Acceptance:**
  - `[browser]` `room_full` shows a dialog titled "Room Full" with the table's text and an OK button.
  - `[browser]` Every error code in the table produces a dialog with a non-empty message.
- **Source:** R-B5 (dialog wording, recalled and paraphrased, not period text). The wording is a design choice.

### C3. Keyword shortcut

- **Behaviour:** A Keyword box in the Rooms window takes a room name and joins that room directly, as a shortcut for `join_room`.
- **Acceptance:**
  - `[browser]` Typing "Lobby 2" and pressing Go sends `join_room` with `name` `"Lobby 2"`.
  - `[browser]` Typing "Nowhere" shows the `no_such_room` notice.
- **Source:** R-A3 (verified: a catalogue of 5,122 public chat rooms exists; the keyword interface is not described). The Keyword box is a design choice.

---

## Source key

| Key | Research item | Tag | Location |
|---|---|---|---|
| R-A1 | Early lobbies filled at about 23 people; wiki mirror gives 27 (private) and 48 (conference), undated | memory | https://techland.time.com/?p=138271 (snippet); https://exhibits.lib.asu.edu/ (404); https://wiki.mbalib.com/wiki/AOL (not fetched) |
| R-A2 | A second lobby opened when the first filled | memory | Same Time snippet as R-A1 |
| R-A3 | Keyword catalogue of 5,122 public chat rooms | verified (count only) | https://reagle.org/joseph/pelican/2024/aol-keywords.html |
| R-A4 | "Creating a Buddy Chat Room", 1999 edition, p. 49 | verified (1999) | https://campusstore.miamioh.edu/america-online-dummies-quick-reference/bk/9780764505034 |
| R-A5 | Volunteer Community Leaders hosted rooms | verified | https://en.wikipedia.org/wiki/AOL_Community_Leader_Program |
| R-A6 | People-in-room list | none | none found |
| R-A7 | Arrival and departure notices | none | none found |
| R-A8 | IM to an offline member reported as not received and discarded; "Available?" check | memory | Aug 1994 Mac FAQ, discmaster.textfiles.com (PDF unreadable; snippet only) |
| R-A9 | Buddy List built after name-lookup scripts overloaded the service; origin verified, no launch year, no alerts | verified (origin) | https://www.smithsonianmag.com/innovation/in-25-years-since-its-launch-aol-instant-messenger-has-never-been-away-180980086/ |
| R-A10 | Away messages: function verified; no year | verified (function) | Smithsonian link above; https://wap.org/journal/awaymessages/ (general, not online service) |
| R-A11 | Profiles exist (1999 guide, pp. 53 and 59); member directory voluntary (1995 FAQ); field list from a 2003 snippet | verified (existence); memory (fields) | https://campusstore.miamioh.edu/ (above); https://sunsite.icm.edu.pl/packages/umich/misc/documentation/aolnonmemberfaq.txt |
| R-A12 | Ignore: "$im_off" IM setting in a 1994 FAQ; no room ignore source | memory | Aug 1994 Mac FAQ (as R-A8) |
| R-A13 | Notify button in chat rooms, 1999 guide, pp. 47 and 158 | verified (1999) | Dummies link above (R-A4) |
| R-A14 | Idle warning and sign-off | none | none found |
| R-A15 | Typed emoticon origin, 1982 Carnegie Mellon post; AOL icon conversion for IM | verified (origin); memory (conversion) | https://en.wikipedia.org/wiki/Emoticon; https://sk.sagepub.com/ency/edvol/embed/newmedia/chpt/emoticons |
| R-A16 | Rich text in chat; RealChat 2.0 bold and italic buttons (not an online service) | memory | none for the online service |
| R-A17 | Message length about 92 characters | memory | none found; unverified |
| R-A18 | Prodigy real-time chat, 1995 to 1996 | verified | https://en.wikipedia.org/wiki/Prodigy_(online_service) (context only; not used) |
| R-A19 | CompuServe CB Simulator, 1980; 40 channels; tune, squelch, monitor | verified | https://en.wikipedia.org/wiki/CB_Simulator (context only; not used) |
| R-A20 | Microsoft Chat (Comic Chat), 1996 | verified | https://en.wikipedia.org/wiki/Microsoft_Comic_Chat (context only; not used) |
| R-B1 | Window frame, title bar, caption buttons, bevels, scrollbars | standard | Windows 95 defaults, not fetched |
| R-B2 | Colours: teal desktop, face grey, white wells, navy selection; notice colours are design | standard (palette); design (notices) | Windows 95 defaults, not fetched |
| R-B3 | Fonts: UI 8pt MS Sans Serif (11px); chat log 12px Arial | standard (UI); recalled (chat log) | Windows 95 defaults, not fetched |
| R-B4 | Chat room window layout: title, toolbar, log, people column, send box | recalled | none fetched |
| R-B5 | Dialogs and notices: sign-on window, wrong password, busy lines, room full, entry and exit, Goodbye | recalled; paraphrased | none fetched |
| R-B6 | Build notes: CSS custom properties, `.raised` and `.sunken` classes | design | Derived from R-B1 and R-B2 |

Conflicts in the research that do not change the spec: the AOL flat-rate change date (December 1996 or October 1996), and volunteer counts (about 14,000 peak versus 33,000 community leaders in 1996). Neither is used.

---

## Verification

- `npm test` runs `node --test test/`. `[proto]` checks are written as tests in `test/` with a WebSocket client (the `ws` package, the only dependency).
- `[browser]` checks are manual. Run `npm start`, open `http://localhost:1996` in a current desktop browser, and walk through each item. Record pass or fail next to the item.
- Look checks (S9) should be compared with a period screenshot once one is found. Until then, treat the look as "recalled".
