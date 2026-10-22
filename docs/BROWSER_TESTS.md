# Browser tests and screen recording

Use Node.js 24 or newer:

```sh
npm ci
npx playwright install chromium
npm run test:browser
npm run test:browser:controls
```

On Linux, `npx playwright install --with-deps chromium` also installs the browser's OS dependencies. GitHub Actions does this automatically.

## What runs

Eight tests in `e2e/chat.spec.js` drive the rendered UI with Playwright, real Chromium and real WebSockets. Each test starts `server.js` on a fresh ephemeral loopback port. The second participant uses a separate browser context. No running localhost:1996 session is reused, and the backend is not mocked.

The suite covers room creation/joining, bidirectional chat, IM/away replies, literal HTML payloads, ignore/unignore, exact ASCII whitespace, full scrolling, Stop, cancellation on room departure, buddy presence, sign-off/session reset, keyboard sign-on and narrow layouts. Each test also fails on browser script/console errors or unexpected dialogs.

Assertions wait for visible state and server-confirmed UI results. Negative cancellation checks wait for the other participant to finish a complete scroll before asserting that the cancelled scroll stayed stopped. Ignore checks use a visible delivery barrier before asserting absence. There are no timing sleeps in the test suite.

`test:browser:controls` creates isolated copies and deliberately replaces safe text rendering with `innerHTML`, then disables the Stop button. The targeted tests must fail an assertion for each mutation. A browser launch/configuration failure does not count as detecting a broken implementation.

## Reports and CI

Pushes and pull requests run both browser and server jobs on Ubuntu and Windows. Tests have no automatic retries; failures remain visible. The server suite retains its 90% line-coverage floor, separate from browser workflow coverage.

Open the local report with `npx playwright show-report`. On GitHub, open the Actions run and download `browser-results-ubuntu-latest` or `browser-results-windows-latest`. Reports are kept for seven days and include failure screenshots, traces and videos. The peer video is attached separately. Use `npx playwright show-trace path/to/trace.zip` to inspect a trace.

The harness closes browser contexts and requests graceful server shutdown over IPC, including on assertion failures. Reports, browser results and generated media are ignored by Git.

## Record the demo

```sh
npm run demo:record
npm run demo:render
```

Recording uses Playwright's real viewport video capture with two isolated demo participants and a fresh local server. Rendering additionally requires FFmpeg with H.264, AAC and subtitle support on PATH (`FFMPEG` can select an executable). It does not record your desktop, personal tabs, microphone or system audio.

Outputs go to `artifacts/demo/` (`DEMO_OUTPUT_DIR` can select another directory): raw WebM screen capture, H.264/AAC MP4, a poster, chapter timings, SRT captions and an original synthesized tone track. The deliberate pauses in the recording script give viewers time to read; the tests use state assertions.

The MP4 burns in the scene captions and adds quiet original computer-style tones. Playwright's raw WebM is silent; those tones are added during rendering, not captured app audio. No historical sound recordings or original Fate X executable are used.

The video begins at sign-on, shows room chat, an away message, an incoming IM, buddy presence, the Fate X tribute picker, skull/banner scrolling, Stop and a collaboration invitation. This is a recording of working software, not a simulated interface.
