# AOL proggies and the Fate X tribute

The small third-party programs remembered as progz or proggies were an entry into programming for many people who grew up with AOL. A scroller took a multiline ASCII drawing and sent its lines into a chat room with a delay. A surprisingly expressive little program could be built around window discovery, control messages, timers and string handling.

Charles Leifer's [A Stroll Down Memory Lane: Scripting AOL](https://charlesleifer.com/blog/a-stroll-down-memory-lane-scripting-aol/) reconstructs a Visual Basic script and the Windows messages it used to interact with the AOL client. It is a useful firsthand technical reference for how this style of automation worked. GitHub's [AOL programming culture retrospective](https://github.com/readme/featured/aol-programming-culture) collects the broader community history.

The archived [Fate X 3.0 entry](https://justinakapaste.com/fate-x-3-0/) and [preserved control-panel screenshot](https://plozee.com/wp-content/uploads/2024/12/Fate-X-3.0.webp) identify the original as **Fate X 3.0 by MaGuS & FuNGii**. They guide the visual tribute in this project. They do not establish exact behavior, release chronology or compatibility with this remake. No original executable was run to verify parity.

[AOL Underground's archive](https://github.com/ssstonebraker/aolunderground-proggies) is another preservation reference. Old software archives are historical sources; this project does not require downloading or running their binaries.

## Our implementation

Almost Online sends server-owned ASCII lines over its own WebSocket protocol. Each sender gets one active job, paced at 650 ms. Ignore is checked for every line; room and session departure cancel pending work. The preview preserves whitespace. This is newly written code and newly supplied art, not recovered Fate X source or an original art pack.

The recognizable control panel is part of the tribute. Its buttons use this app's own room, IM, away and scroller workflows. [Credits](../CREDITS.md) · [Visual notes](VISUALS.md) · [Protocol](PROTOCOL.md)
