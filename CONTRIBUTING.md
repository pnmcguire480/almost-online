# Contributing

Start with [Discussions](https://github.com/pnmcguire480/almost-online/discussions) or an [issue](https://github.com/pnmcguire480/almost-online/issues). Small, focused contributions are welcome: period references, keyboard access, UI fixes, browser tests and the design of a future connected service.

Use Node.js 24 or newer. Run `npm ci`, `npm start`, then open two browser tabs with different names. The code is plain CommonJS on the server and plain browser JavaScript; there is no build step.

Before a pull request:

```sh
npm run test:coverage
npm run test:controls
```

Add behavioral tests for changed trust boundaries, session isolation, cancellation and data lifetimes. Keep server line coverage at or above 90%; do not add tests just to raise a number. For a security boundary, include a deliberately broken control that proves the test detects the failure. Show UI changes with a screenshot and describe the workflow you exercised.

Keep loopback binding and origin/path checks intact. A connected edition needs an agreed access and moderation design first; see [ROADMAP.md](ROADMAP.md). Report security issues through [SECURITY.md](SECURITY.md).

Use text nodes for user content. Avoid new dependencies when the platform already provides what is needed. Include source links and asset provenance when bringing historical material; contribute code and assets you can license under MIT. Original executables, copied art packs and unverified downloads are not needed to develop this project.

Treat contributors and participants with respect. Critique the work, honor boundaries, and do not harass people. Contributions are accepted under the repository's MIT license.
