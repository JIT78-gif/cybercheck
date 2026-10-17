# Security Edge Lab

This is a deliberately vulnerable, synthetic application for Cybercheck evaluation. **Never deploy it or expose it to a network.**

It extends the original gauntlet with security cases that exercise unfinished or less-tested areas:

- command and dynamic-code injection;
- weak password hashing and a synthetic committed token;
- cookie flags, CSRF, session fixation and replay after logout;
- login account enumeration;
- unsigned and replayable webhooks;
- active HTML/SVG upload handling;
- reflected credentialed CORS and missing response headers.

All users, tokens, files and records are synthetic. The application binds to loopback by default.

Run locally only for fixture verification:

```text
npm ci
npm test
npm start
```
