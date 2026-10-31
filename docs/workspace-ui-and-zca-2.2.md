# Zalo workspace UI and zca-js 2.2 features

Release UI key: `20261030-workspace`. Official SDK remains pinned at 2.2.0, latest checked on 2026-10-30; voice companion remains 2.3.12.

The interface uses the familiar Zalo PC/Web structure: navigation rail, resizable conversation list, continuous chat and information drawer. At 760px and below the list and conversation are separate screens with a back button and bottom navigation. Light and dark themes share the same layout. Chats, contacts, provider tools and administration are separate destinations.

Conversation filters include all, unread and groups. The list uses the complete searchable conversation pool rather than only the recent-window subset. Message history is fetched from the existing account-scoped saved-history endpoint, displayed in batches of 120 and merged with current realtime updates by message ID. Search explicitly covers the displayed messages; load earlier messages to search further back. Renders preserve reading position, and account/thread generation checks discard obsolete responses. Background ingestion and webhook contracts are unchanged, including the final `AIchat` field. Internal AI remains unused.

Bootstrap group sync now merges its returned page with saved history instead of replacing saved messages with a potentially shorter page. Matching IDs prefer the current upstream version. The existing ten-day sync window and maximum250 messages per thread remain in effect; this UI does not reconstruct history that was never retained. A regression test preserves49 saved messages when upstream returns only23.

## Provider tools

`GET /api/zalo/features` exposes actual SDK method availability and current principal permission. `POST /api/zalo/features/run` accepts `{operation,payload}` with a strict nine-operation allowlist. Both use the existing request account projection; explicit foreign account IDs are rejected before dispatch.

- `getListBank`, `getListBankAccount`, `createBankAccount`, `updateBankAccount`, `deleteBankAccount`: saved receiving-bank information, requiring `channels.manage`. Not payments or transfers. Bank BIN, positive account ID, pagination and input lengths are validated. The UI confirms account and requested change before writes.
- `getListDevice`: `channels.manage`; returns only safe display metadata. Encrypted identity/signature and primary identifiers never reach the browser.
- `registerCatalog`: `channels.manage`; explicit boolean enable/disable registration. Does not implement product CRUD.
- `scanURL`: `conversations.reply`; HTTP(S) links only, no embedded credentials. Sends the supplied link to Zalo and displays its safety result without promising all links are safe.
- `lostFocus`: `conversations.reply`; explicit user action to report leaving the UI. It does not stop account listeners.

Profile images additionally accept `avatarSize=Small|Medium|Large|ExtraLarge`. Medium/ExtraLarge are labeled experimental per upstream. Selection is opt-in and a failed request falls back to Large with feedback. Standard Large remains the default.

No operation reports successful completion before its SDK promise resolves. Disconnected/unsupported accounts have disabled controls. Changed selection clears bank/device results immediately; in-flight responses cannot populate another account's view. No changes to n8n.

## Repeatable verification

Run `npm run check`, `npm run test:account-isolation`, and `node --test test/zalo-latest-features.test.mjs test/qr-login-session.test.mjs test/voice-calls.test.mjs test/chatbot-bridge.test.mjs test/compat-multipart.test.mjs`.

For browser QA run `node test/workspace-browser-server.mjs`, then open `http://127.0.0.1:4390`. This local-only proxy signs into a synthetic admin backed by temporary data and a separate mock server on4391. A test-only preloader supplies fake SDK methods; it is never deployed. The fixture has clearly marked A/B conversations. Stop with SIGTERM to remove its generated directory. Do not run a second instance on the same ports.

Synthetic UI tests cover bank CRUD, link scan, device display, catalog toggle, focus reporting and account switching. They verify wiring and contracts; production bank writes/catalog registration and actual handset calls still require owner acceptance with intended real data. Do not use private customer messages in screenshot evidence.

References: [Zalo PC](https://zalo.me/pc), [official SDK release](https://github.com/RFS-ADRENO/zca-js/releases/tag/v2.2.0).
