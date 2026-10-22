# Bring the good parts back

## v0.1: the local foundation

Working rooms, IMs, buddy presence, away replies, profiles, host controls, ignore and reports; the Almost Online shell; a Fate X tribute scroller; bounded server resources and security regression tests. The initial release is local-only.

## Next: build it together

- Shipped in v0.1.1: eight automated browser workflows covering room chat, IMs, away, ignore, art/cancellation, literal HTML rendering, buddy/session reset and keyboard/narrow-screen controls. Windows and Linux CI includes browser mutation controls and failure artifacts.
- Collect sourced AOL 3.0 and Fate X references. Distinguish documented behavior from our own design choices.
- Improve keyboard navigation, focus, readable scaling and sound preferences while preserving the look.
- Expand the browser harness as the client grows; keep tests focused on behavior and access boundaries.

## A connected edition

Decide together who can join, who owns screen names, what is retained, and who can moderate. Then design authentication, TLS, explicit trusted origins, global and per-user abuse controls, reporting and blocking, operational limits, recovery and privacy expectations.

The first milestone is a reviewed design and threat model. A hosted service will be a separate, tested milestone. Changing the listen address or putting this release behind a tunnel does not complete that work.

## Help wanted

People who remember the rooms. People who never saw them. Designers, preservationists, JavaScript developers, testers and community builders. [Introduce yourself](https://github.com/pnmcguire480/almost-online/discussions) and tell us what you would like to bring back.
