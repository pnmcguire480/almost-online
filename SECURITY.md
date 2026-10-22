# Security

## Supported scope

The latest release is a **local-only nostalgia app**. It listens on `127.0.0.1` and accepts `localhost`, `127.0.0.1` and IPv6 loopback Host names only at the actual listening port. A browser WebSocket request must have the same HTTP origin as its Host. Protocol clients without an Origin header are allowed; this is not authentication against programs running on your computer.

Do not expose this version through port forwarding, a tunnel or a reverse proxy. Public hosting is tracked in [ROADMAP.md](ROADMAP.md), including identity, TLS, moderation and a separate access model.

## Boundaries

| Boundary | Behavior |
| --- | --- |
| WebSocket endpoint | `/ws`, at most 128 concurrent clients |
| Frame | 4,096 bytes, including fragmented messages; binary application messages rejected |
| Inbound messages | Token bucket: burst 20, refill 5/second |
| Outbound queue | Client closed with 1013 when queued output exceeds 64 KiB |
| HTTP | 160 total sockets; 10-second header and 15-second request timeouts |
| Static files | GET/HEAD only; canonical target must stay under `public`; hidden paths, traversal and alternate-stream syntax rejected |
| Browser | Same-origin scripts, restricted connections, framing blocked; user text uses text nodes |
| Retained state | 50 buddies and 100 ignores per session; newest 500 incident records per process |
| Scrolling | Server-owned catalog; one job per sender; 650 ms pacing; session/room departure cancels work |

Serve only a trusted `public` tree. Canonical path checks stop accidental external symlinks/junctions; they are not a sandbox against a local process that can rewrite the application files during a request.

Screen names are unverified session labels. Rooms, profiles, buddy/ignore lists and away messages are in memory. The server stores no message history. Reports retain only the reported name and time in memory and print those two fields to the process log. The browser retains a sound preference. There is no telemetry or external runtime asset fetch.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/pnmcguire480/almost-online/security/advisories/new). Include the affected version, a minimal local reproduction, impact and expected behavior. Keep sensitive details out of public issues while a fix is being prepared.

## Verification

Run `npm run test:coverage`, `npm run test:controls`, `npm run test:browser` and `npm run test:browser:controls` after installing Chromium with `npx playwright install chromium`. The controls mutate isolated copies, never the live source. Browser checks exercise literal HTML rendering, ignore and cancellation through the real UI. Failed runs keep traces and videos for debugging; the suite uses only synthetic test names and messages. The release evidence and limitations are recorded in [v0.1.0](docs/releases/v0.1.0.md) and [v0.1.1](docs/releases/v0.1.1.md). Security checks were informed by the [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html) and [Node.js HTTP documentation](https://nodejs.org/docs/latest-v24.x/api/http.html).
