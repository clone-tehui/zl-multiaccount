# Calls optimization — owner Drive report, 2026-10-31

Status: source fixes deployed to the workspace; handset acceptance and authenticated production UI remain unverified. This is not a claim that the destination-specific ringing failure or device audio complaints are resolved.

## Input and scope

Read with existing `gog` authorization: Drive ID `1ATRKc9gJchYFpILYw1CrhF0qiGy0s4K6`, **Bao-cao-qua-trinh-cuoc-goi-ZaloInbox-2026-10-30.md**, MIME `text/markdown`, 11,862 bytes. SHA-256: `62d2796777e5dbc3c36cd41bfc8e1649b3ff528d9ae6844b85a497d08800f041`.

Original owner URL, including its typo: `https://drive.usercontent.google.com/download?id=1ATRKc9gJchYFpILYw1CrhF0qiGy0s4K6&export=doơnload`. The file was downloaded by ID, not replaced with another document. No OAuth/account/config changes.

The report describes `zalo-inbox-local/server.js`, `dist/calls-v4.js/css` and `data/store.enc`, a different application. Its WebRTC, previous successful calls and user complaints are input evidence, not verified zlsever behavior. zlsever retains its authenticated WSS transport and pinned official `zca-js` 2.2.0 plus voice companion 2.3.12. Registry versions and installed companion signaling/media APIs were checked before custom application code. Sources: [official releases](https://github.com/RFS-ADRENO/zca-js/releases), [voice companion](https://www.npmjs.com/package/%40softtynet/zca-js).

No real calls/messages, QR/reset, session replacement, n8n, firewall, scheduler or tunnel configuration changes were performed. Existing multipart/QR/workspace changes and local Studio v2 were preserved.

## Issue checklist: evidence, fix and verification

1. **Destination does not ring / connecting indefinitely.** No corresponding live call log existed in the inspected six-hour log window, and no real call was authorized. Its root cause remains unknown. Added bounded persistent signaling diagnostics: allocation/invitation/answer API stage, result/error code and timing, received events, delivery counts and call trace. Added a 60-second setup timeout and accurate UI wording: sending an invitation does not prove the destination rang. Tested failed allocation, timeout, lease cleanup and secret exclusion. Owner must perform the same-sender A/B test and compare the official Zalo app/privacy settings before this issue can be closed.

2. **Audio lag/jitter/echo.** Verified code forwarded browser frames immediately, discarded RTP sequence and could overlap playback after clamping the scheduling cursor backward. The companion also independently sends silence after an 18 ms gap. Added one 20 ms outbound audio clock, maximum three queued frames, stale frame dropping, no overlapping sends, and suppression of only the companion audio-silence path; UDP/RTCP keepalive remains intact. Opt-in `mediaVersion=2` preserves RTP sequence/timestamp for a bounded receive jitter buffer; clients without it still receive raw Opus. Capture resamples the actual device clock to 16 kHz, including 48 kHz devices. Playback cannot schedule an unlimited backlog or overlap by moving backward. Microphone echo cancellation/noise suppression/AGC remain requested; an explicitly disabled echo-cancellation setting prompts a headset suggestion. Tests cover burst/staleness/serialization, RTP wrap/reorder, 48 kHz capture and legacy compatibility. Synthetic browser decoding passed; real latency/echo improvement is not measured or accepted yet.

3. **Incoming notification, ringtone and account scope.** Verified missing receipt acknowledgement, no pending-terminal event, no listener detachment and dependence on having a selected direct thread. Added companion `ringRingVoiceCall` receipt acknowledgement without auto-answer, 45-second pending expiry, call-ID matched cancellation, duplicate suppression, listener detachment, account-selected notification independent of the open conversation, and best-effort browser ringtone. SSE call notifications require current reply permission and thread/account access and expose only account/thread/internal trace. Existing gateway authorization continues on each media/control activity. Tests cover incoming dedupe/cancellation/timeout, reconnect listener count, account fencing, revocation and stale UI terminal events. Browser autoplay policy may silence ringtone; the visual banner remains.

4. **Answer/reject/hangup/mute and history.** Added terminal cleanup, timer/audio-source cleanup, connected-state duration and idempotent `call.log` messages in the correct account/thread. Outgoing history uses outgoing alignment and text such as `☎ Cuộc gọi đi / Thời lượng: 00:07`; missed/rejected/unanswered outcomes are distinct. History is local only, using existing retention and message sanitization, with no Zalo send, webhook or AI enqueue. An initial history test exposed a missing sender ID; it was corrected to the account's own ID or the incoming peer rather than weakening isolation. Tests cover history dedupe, A/B separation, accept/reject, pending allocation hangup and cleanup. Actual authenticated history rendering and handset controls remain owner acceptance steps.

5. **HTTPS/mobile microphone.** Workspace HTTP redirects 308 to HTTPS; a real isolated browser reports secure context and WebCodecs support on its test device. Capability checks remain explicit for unsupported clients, and late microphone grants are stopped after cancellation. No ScriptProcessor/WebRTC/TURN codec fallback was introduced; unsupported iPhone/browser combinations remain a limitation requiring device testing. Production microphone permission was not requested.

## Tests and browser evidence

- 30/30 local tests: voice, media, QR, multipart, bridge, latest SDK and avatar/history regressions; 11 HTTP/SSE account-isolation groups; repository syntax and whitespace checks passed.
- 16/16 focused tests passed inside the actual Linux release image using `--network none`, synthetic auth and no production data mount. Native SQLite and module imports passed. The old media test initially counted new silence frames as user audio; its assertion now excludes known silence while still asserting exact A/B user frames and absence of denied frames.
- Playwright isolated, temporary profile: observed 1,171 decoded legacy frames and 813 version-2 frames with RTP wrap; mute, duration, hangup, active leases returning to zero, foreign incoming rejection and stale terminal-event rejection passed. These are oscillator loopbacks, not real Zalo calls or a quality measurement.
- Production workspace browser loaded the correct version and modules. The isolated profile has no existing session (`/api/state` 401); unauthenticated WSS returned 403 without starting a call. Authenticated production UI/WSS and inbound messaging after restart are unverified.
- **Portal blocker:** isolated browser and curl returned HTTP 530 / Cloudflare Tunnel error 1033 for `https://portal.tehui.io.vn/`; Python user-agent returned 403/1010. Portal was not measured at task baseline, so onset/cause is unknown. Workspace and local 4310 work. No DNS/tunnel/service changes were made to pursue this out-of-scope edge issue.

## Deployment and rollback

SSH verified `103.97.126.245:2018`, hostname `srv-og51ul`, Docker context `default`, project `zlsever`, service `zalo-user-server`, bind `/opt/zlsever/data:/data`.

Baseline: `20261030-workspace`, image `sha256:9a641bfa86972ffe884823dfc191eecd759dffffcfd0f3488cbb37a43e0589db`.

Active: `20261031-calls`, image `sha256:0d4558a916745a51d0bfe40aa6a6812189468785eff21d9c4dcd770de093cec2`, container `e0dd768642d38cc21e8257efcf8d7d9441af145eb9dab549529609a1fef520ad`, running, restart count 0. Recreated only the named service with `--no-deps --no-build`. Initial health during hydration reset; verification passed after startup.

11 host/container hashes and five public asset hashes match the staged release. 32 other containers retain their image, start time and status. At the post-deploy check, both account buckets retain baseline status/counts: 2,628 threads / 5,939 messages / reconnect_failed; 12 threads / 1,541 messages / connected. This is an aggregate check, not a content-by-content guarantee.

Backup: `/opt/zlsever/backups/calls-drive-20261031` (14,327,675 bytes at final measurement): source/config archive, per-file data snapshot and separate SQLite online backup. Eight JSON files parsed successfully, SQLite `quick_check` passed and `.env`/Compose matched the backup. The first live-directory tar attempt failed and was superseded; a build attempt using an image ID as a repository reference also failed before deploy, then used the verified local rollback tag. No production changes were made by either failed attempt.

Rollback tag: `zlsever-rollback:20261031-calls`, verified to the baseline image. Run the guarded `/opt/zlsever/backups/calls-drive-20261031/rollback.sh` on the verified host if needed. It checks the active image and changed source hashes, restores only modified files that existed before this task, then recreates only zlsever with the baseline image. It never restores data. Three new host source files may remain unused as evidence; the baseline image does not reference them. Script syntax was checked; rollback was not executed against production.

## Files and review artifacts

The 11-file release overlay is in `.task-evidence/calls-drive-20261031/release/`:

- `src/server.js`, `src/providers/zalo-web-provider.js`;
- `src/services/zalo-voice-calls.js`, `voice-call-gateway.js`, new `voice-call-media.js` and `voice-call-diagnostics.js`;
- `public/voice-call-ui.js`, new `voice-call-audio.js`, `call-audio-worklet.js`, and scoped live-derived `app.js` / `index.html`.

Local Studio `app.js` received only the same call integration hooks. Local Studio `index.html` was not deployed or overwritten. The staged `app.js` was patched from the actual live file; staged `index.html` changes only the app version query. Dependencies and other public UI assets were inherited from the verified baseline image.

Tests: `test/voice-calls.test.mjs`, new `test/voice-call-media.test.mjs`, and the reusable `test/voice-call-browser-server.mjs` fixture. No commit/push was performed.

Evidence root: `.task-evidence/calls-drive-20261031/`. Review `calls-only.patch`, `live-app.patch`, `release-hashes.json`, `tests.txt`, `image-tests.txt`, `isolation.txt`, `browser-evidence.json`, `public-hashes.json`, `final-runtime-verification.txt`, `backup-verification.txt`, `cleanup-remote.txt`, `rollback.sh` and `manifest.json`.

## Cleanup and acceptance still needed

Deleted 8,889,045 bytes of task-owned VPS build context, two QA bind files and the superseded failed backup archive. Both task loopback processes and the isolated task pages were closed; port 4389 has no listener. Kept active/rollback images, verified backups, source/tests/docs, compact review evidence, pre-existing Studio preview and platform-managed MCP. Shared builder cache remains because no exclusive safe cache ID was established; no global prune or volume cleanup.

VPS available bytes changed from 39,895,920,640 before cleanup to 39,904,837,632 after, and 39,904,825,344 at final check. These are host measurements, not exclusive reclaim attribution. Local swap snapshots changed from 4,949.06 to 4,933.06 MiB; no claim of task-specific RAM recovery.

Owner acceptance: authenticate in the production workspace; use the same sender/account/network/browser for the two destinations named in the Drive report; check official-app call permissions and availability; test incoming/outgoing, reject/missed, mute, hangup from both ends, correct history and selected-account isolation; compare two-way audio on PC/Android/iPhone. Diagnose using the new sanitized `/data/voice-calls.ndjson` and `.1` logs. Account/peer/call references are HMAC hashes and change on process restart; no raw signaling params, tokens, cookies, media keys or voice recording are persisted. Portal tunnel verification remains separate and unmodified.
