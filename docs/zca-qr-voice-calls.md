# QR onboarding and personal Zalo voice calls

Release: `20261029-qr-calls`.

## Dependencies

- Official `zca-js` is pinned to **2.2.0**, the npm latest release checked on 2026-10-29.
- Voice signaling, listener decoding and UDP/SRTP media use the separately pinned `@softtynet/zca-js` **2.3.12** engine. The adapter reuses the official authenticated context/service map and replaces the listener before starting it. It creates no second Zalo login or second active listener for an account. Messaging APIs remain on the official package.
- The adapter uses an internal API entry point from the pinned voice package. Re-run adapter tests and review that entry point before upgrading it. If unavailable, messaging continues and call capability is false.
- Sources: [official release](https://github.com/RFS-ADRENO/zca-js/releases/tag/v2.2.0), [upstream voice discussion](https://github.com/RFS-ADRENO/zca-js/issues/366), [voice engine registry package](https://www.npmjs.com/package/@softtynet/zca-js). Salework's public materials do not establish that its implementation is the same.

## QR

The old QR image lived in the global session but account projection omitted it. An unobserved rejection in the old background login promise could also terminate Node when scan polling failed.

QR is now an ephemeral, initiator-owned flow independent of account state. `POST /api/sessions/qr/start` still requires `channels.manage` and a permitted `departmentId`. `GET /api/sessions/qr` returns only that principal's flow. `POST /api/sessions/qr/cancel` cancels it. A second principal cannot replace an active flow. Expiry, cancellation and retries settle in the background without disconnecting existing accounts. QR polling is separate from account SSE and stops at terminal status. An authenticated account is added without changing the global selected account; its portal department is assigned by the existing authorization callback.

## Voice

Choose a direct conversation, then **Gọi thoại**. Allow the browser microphone when prompted. The call panel supports mute/unmute, hangup and answering/rejecting incoming audio calls for known conversations in the selected account. Switching accounts or logging out closes the browser's audio resources and socket. Incoming video and group calls are not implemented. No automatic dialing or answering is performed.

Use a recent Chrome/Edge browser with HTTPS and AudioEncoder/AudioDecoder Opus support. The browser captures audio with echo cancellation, encodes 16 kHz mono Opus in 20 ms frames, and exchanges binary frames over same-origin authenticated WSS. The server engine handles Zalo signaling and UDP media; no Zalo PC installation is required. No camera permission or recording is used. The VPS must have working outbound UDP access to the Zalo media relays, and the reverse proxy must support WebSocket upgrades.

`GET /api/calls/capabilities?accountId=...&threadId=...` checks actual account/thread access. `/api/calls/media` revalidates login, account membership, conversation access and `conversations.reply` on the upgrade and on media/control activity. Origin must match the request host. The conversation is fixed for the socket. At most one call lease exists per account; different accounts can call independently even when their conversation IDs match. Messages/frames are bounded, slow clients are dropped instead of accumulating media, and socket closure, revocation, timeout or account disconnect tears down media resources. Crypto keys, relay parameters and credentials are never sent to the browser.

## Validation

Run `node --test test/qr-login-session.test.mjs test/voice-calls.test.mjs`, `npm run test:account-isolation`, and the existing webhook/bridge/multipart regressions. `node test/voice-call-browser-server.mjs` serves a synthetic audio loopback on **127.0.0.1:4389**: it substitutes an oscillator for microphone input and a fake Zalo session for external calls. Stop that process after checking the browser.

Synthetic Opus loopback validates browser encoding/transport/decoding, not a real Zalo handset connection. The owner requested to perform real call testing later. Creating and cancelling a real QR validates display/retry; successful phone scan/confirmation and live two-way voice remain owner acceptance steps.

The existing webhook data and final `AIchat` field are unchanged. Internal AI enqueue remains disabled. No n8n changes are part of this release.
