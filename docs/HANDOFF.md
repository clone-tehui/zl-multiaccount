# HANDOFF — zlsever / Zalo Multi-Account Workspace

> **Mục đích:** File bàn giao kỹ thuật cho agent/nhân sự tiếp quản `zlsever`. Đọc file này trước khi sửa, deploy hoặc kiểm tra hệ thống.
>
> **Tính đến:** 2026-09-09. Nội dung được tổng hợp từ source hiện tại, `README.md`, `docs/`, Docker/Nginx config và project state. Runtime/live phải luôn được kiểm tra lại trước khi kết luận.

---

## 1. Định danh hệ thống

| Mục | Giá trị |
|---|---|
| Tên nội bộ | `zlsever` / Zalo User Server / Zalo Multi-Account |
| Mục đích | Web inbox quản lý nhiều tài khoản Zalo cá nhân, hỗ trợ nhiều nhân sự, routing, portal/RBAC và AI CSKH cho ChiHome |
| Repo local | `/Users/ctm/Documents/zalo-user-server` |
| GitHub | `https://github.com/clone-tehui/zl-multiaccount` (**private**) |
| Branch chính | `main` |
| Commit khởi tạo repo | `55d7b1d` — 2026-09-09 |
| URL workspace | `https://zl.tehui.io.vn` |
| URL portal | `https://portal.tehui.io.vn` |
| Local app port | `4310` |
| Runtime | Node.js >=20, ES modules, HTTP server native (không Express) |
| Provider Zalo mặc định | `zalo-web` qua `zca-js` (unofficial) |

### Scope nghiệp vụ

1. **Zalo inbox:** xem/gửi tin, thread/contact/group, ảnh/album, sticker, reaction, pin/archive/hide/mute/auto-delete, profile/social actions.
2. **Multi-account:** mỗi tài khoản Zalo có session, state, API client, realtime và dữ liệu riêng.
3. **Realtime:** Server-Sent Events (SSE) đẩy event/state về browser.
4. **Portal/Omnichannel:** user, role, department, channel, account visibility, assignment/routing, ops dashboard, activity/audit.
5. **AI automation CSKH:** orchestrator + specialist agents, OpenRouter, knowledge, live ChiHome Hotel availability, escalation và Telegram alert.
6. **ChiHome bridge:** tra cứu dữ liệu phòng/booking cho automation và endpoint bridge tương thích.

---

## 2. Quy tắc an toàn không được vi phạm

### 2.1 Không chạm ngoài scope

- Không sửa Cloudflare tunnel/Nginx/Docker Compose của hệ khác khi làm zlsever.
- Không đụng dữ liệu, workflow, container, config, backup hoặc restart **n8n** nếu Tehui/Xieu chưa phê duyệt rõ.
- Không đổi domain/tunnel khách sạn hoặc tunnel shared chỉ để sửa zlsever.
- Không restart service live nếu chưa có evidence cần thiết + rollback rõ.

### 2.2 Secrets và dữ liệu runtime không được commit

`.gitignore` hiện đã chặn các dữ liệu này; **không force-add**:

- `.env`, `.env.*` (chỉ giữ `.env.example`)
- `credentials.json`, `accounts/` — Zalo sessions/credentials
- `data/state.json`, `data/state.*`, `data/state.before-*.json` — hội thoại, contacts, state thật
- `data/portal.json`, `data/portal-event-journal.jsonl`
- `data/*.db`, `*.db-shm`, `*.db-wal` — SQLite AI agent DB
- `backups/`, `tmp-uploads/`, `.tmp-*.mjs`, `node_modules/`, `ai-knowledge/`

**Không gửi hoặc đưa các file trên vào chat/log/PR.**

### 2.3 Bảo vệ Zalo account và automation

- `zalo-web` / `zca-js` là **unofficial**; có rủi ro logout, session bị chặn hoặc khoá tài khoản.
- Không tạo cơ chế né phát hiện, spam, gửi hàng loạt hay bypass bảo vệ nền tảng.
- Giới hạn automation, ưu tiên human review cho tác vụ nhạy cảm.
- Không dùng outbound/self-message làm bằng chứng AI inbound hoạt động: runtime bỏ qua `outgoing-self-message`.

---

## 3. Kiến trúc tổng quan

```text
Browser nhân viên
  │ REST + cookie auth + SSE
  ▼
zl.tehui.io.vn — Node HTTP server :4310
  ├─ Static UI: public/index.html + public/app.js + public/styles.css
  ├─ Auth/RBAC/department scope
  ├─ JSON state + Portal JSON state
  ├─ Optional PostgreSQL (dual-write / read-switch)
  ├─ AI Agent SQLite DB
  ├─ Routing / assignment / presence / audit
  ├─ AI automation runtime
  │    ├─ OpenRouter
  │    ├─ Knowledge/retrieval
  │    └─ ChiHomeHotel live API
  └─ Provider adapter
       └─ zca-js / Zalo Web sessions per account
              │
              ▼
             Zalo

Public route
  Cloudflare Tunnel `zl-tehui-io-vn` / `zl`
  └─ (Nginx proxy, nếu dùng) localhost:4310
```

### Public/proxy config đã có trong repo

`deploy/nginx.zl.tehui.io.vn.conf` proxy toàn bộ `zl.tehui.io.vn` về `127.0.0.1:4310`, hỗ trợ upgrade header và tắt buffering để SSE không bị kẹt.

### Tunnel/service — cần verify live trước khi chỉnh

Từ knowledge hiện có:

- Cloudflare tunnel riêng: `zl-tehui-io-vn` / `zl`.
- Config từng dùng: `~/.cloudflared/config-zl.yml` hoặc `~/.cloudflared/config.yml` (không suy đoán, kiểm file/service thật).
- LaunchAgent từng dùng: `~/Library/LaunchAgents/com.tehui.cloudflared.zl.plist` hoặc `com.tehui.cloudflared-zl.plist`.

**Known failure:** chạy `cloudflared` bằng process `exec` tạm có thể chết SIGKILL; app local vẫn sống nhưng public domain lỗi Cloudflare 530/1033. Service bền phải là LaunchAgent/service manager, rồi verify bằng HTTP public 200.

---

## 4. Code map

```text
zalo-user-server/
├─ public/                         # UI static workspace + portal modules
│  ├─ index.html                   # Chat workspace
│  ├─ app.js                       # UI client chính
│  ├─ styles.css
│  ├─ execution-view.*             # Xem execution trace AI
│  └─ portal/                      # Portal frontend modular
├─ src/
│  ├─ server.js                    # HTTP router/API/SSE/bootstrap (≈3200 dòng)
│  ├─ providers/
│  │  ├─ zalo-web-provider.js      # zca-js adapter, QR/reconnect/sync/realtime
│  │  └─ mock-provider.js          # Provider local/demo
│  ├─ lib/
│  │  ├─ store.js                  # JSON app state, account isolation, views
│  │  └─ portal-store.js           # JSON portal state
│  ├─ auth/                        # Cookies, JWT, portal session/SSO
│  ├─ middleware/                  # RBAC permissions + department scope
│  ├─ config/portal.js             # Portal environment normalization
│  ├─ db/
│  │  ├─ client.js                 # optional PostgreSQL client
│  │  ├─ migrate.js                # SQL migration runner
│  │  └─ migrations/               # 0001..0003 portal schema
│  ├─ repositories/                # DB users/conversations queries
│  └─ services/
│     ├─ routing-service.js         # least-connections/round-robin plan
│     ├─ presence-service.js        # online/offline/busy logic
│     ├─ access-service.js          # scoped views & visibility
│     ├─ portal-*.js                # journal, sync, read switch/fallback
│     ├─ ai-automation-*.js         # AI config, runtime, OpenRouter, adapter
│     ├─ agent-system-db.js         # SQLite agents/tools/memory/execution logs
│     ├─ chihomehotel-client.js     # API client dữ liệu khách sạn live
│     └─ telegram-alert-service.js  # alert escalation
├─ scripts/                         # audit, smoke, backup/restore
├─ docs/                            # architecture & plans
├─ deploy/                          # Nginx sample config
├─ data/                            # runtime state ONLY — ignored by git
├─ .env.example
├─ docker-compose.yml
├─ Dockerfile
└─ package.json
```

---

## 5. Runtime, Docker, start/stop

### Local

```bash
cd /Users/ctm/Documents/zalo-user-server
cp .env.example .env   # lần đầu; điền secret thật, không commit
npm install
npm run dev            # node --watch src/server.js
# hoặc npm start
```

### Docker Compose

`docker-compose.yml` hiện chỉ định service riêng:

- Container: `zalo-user-server`
- Port host: `4310:4310`
- `env_file: .env`
- Bind volume: `./data:/data`
- Env container: `DATA_DIR=/data`
- Restart policy: `unless-stopped`

```bash
docker compose up -d --build
docker compose logs -f zalo-user-server
docker compose exec zalo-user-server npm run check
```

**Không hiểu lầm Docker Compose này là compose shared của n8n/hệ khác.** Repo hiện có compose riêng cho zlsever.

### Health

```bash
curl -fsS http://127.0.0.1:4310/api/health
curl -fsSI https://zl.tehui.io.vn
```

### Check source

```bash
npm run check
npm run audit:accounts
npm run audit:portal
npm run smoke:portal-rbac
npm run smoke:ai-automation
npm run smoke:ai-automation:pricing-rules
```

Các smoke `:live` / `:e2e` có thể thực hiện I/O/runtime thật; đọc script và kiểm config trước khi chạy.

---

## 6. Environment variables

`.env.example` chỉ là khung. Không đưa giá trị thật vào handoff/repo.

| Biến | Vai trò |
|---|---|
| `PORT` | App port, mặc định 4310 |
| `DATA_DIR` | State/runtime dir; Docker là `/data`, local thường `./data` |
| `APP_ORIGIN` | Origin app local/public |
| `SESSION_SECRET` | Secret legacy/local app session |
| `APP_USERNAME`, `APP_PASSWORD` | Login app local/basic fallback |
| `PROVIDER` | `zalo-web` hoặc `mock` |
| `PORTAL_URL`, `WORKSPACE_URL` | URLs cho portal/workspace |
| `PORTAL_COOKIE_DOMAIN` | mặc định `.tehui.io.vn` |
| `PORTAL_COOKIE_SECURE` | mặc định secure trừ khi string `false` |
| `PORTAL_COOKIE_SAMESITE` | cookie policy (mặc định Lax) |
| `PORTAL_JWT_SECRET` | JWT SSO portal; fallback `SESSION_SECRET` |
| `PORTAL_READ_SOURCE` | `auto`, `json` hoặc `db` |
| `DATABASE_URL` | optional PostgreSQL; không có vẫn chạy JSON fallback |
| `CHIHOME_HOTEL_API_BASE_URL` | base API ChiHomeHotel, default `https://api.tehui.io.vn/api` |
| `CHIHOME_HOTEL_API_KEY` | bắt buộc nếu gọi dữ liệu live ChiHome |
| `CHIHOME_HOTEL_API_TIMEOUT_MS` | timeout client, default 15s |
| `CHIHOME_BOOKING_BRIDGE_URL`, `CHIHOME_BOOKING_BRIDGE_SECRET` | booking bridge compatibility |
| `OPENROUTER_API_KEY` | bắt buộc để AI runtime gọi OpenRouter |
| `TELEGRAM_ALERT_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID` | alert escalation; thiếu thì alert trả `missing_telegram_alert_config` |
| `ZALO_GROUP_HISTORY_SYNC_COUNT` | 30–200, default 100 |
| `ZALO_GROUP_HISTORY_SYNC_CONCURRENCY` | 1–8, default 4 |
| `ZALO_GROUP_MEMBER_SYNC_BATCH_SIZE` | 20–200, default 100 |
| `ZALO_GROUP_MEMBER_SYNC_CONCURRENCY` | 1–6, default 3 |
| `ZALO_KEEPALIVE_FAIL_THRESHOLD` | 1–10, default 3 |

**Runtime warning:** Source code sẵn sàng không đồng nghĩa AI đã hoạt động. Nếu `.env` container thiếu `OPENROUTER_API_KEY`, status/runtime sẽ báo `missing_api_key`.

---

## 7. State and persistence

### JSON state (bắt buộc có fallback)

`src/lib/store.js` quản lý `data/state.json`:

- `activeAccountId`
- `accounts`
- `accountStateById` — snapshot state theo account
- contacts, threads/messages metadata và views
- integration webhook state
- `aiAutomationByDepartment`, AI config/usage/logs

`src/lib/portal-store.js` quản lý `data/portal.json`:

- users, roles, departments, channels
- routing/assignment/presence state
- portal settings/activity fallback

Hệ thống vẫn phải chạy khi không có `DATABASE_URL`; không được phá JSON fallback vì chỉ muốn “chuyển hẳn DB”.

### PostgreSQL (optional)

- `src/db/client.js`: chỉ enabled khi có `DATABASE_URL`.
- `src/db/migrate.js`: chạy migrations theo file name trong `schema_migrations`.
- Migrations hiện có:
  - `0001_portal_omnichannel.sql`
  - `0002_portal_event_journal.sql`
  - `0003_thread_binding_routing_diagnostics.sql`
- Khi DB enabled, app auto `runMigrations()` lúc start.
- `portal-sync-service.js`: dual-write JSON + DB.
- `portal-read-service.js`: `auto` ưu tiên DB khi có data meaningful, fallback JSON khi DB rỗng/lỗi; `json`/`db` ép source.
- `portal-journal-service.js`: luôn ghi JSONL rồi best-effort ghi DB nếu enabled.

**Known risk:** Khi thêm field UI/routing, update cả JSON state, DB schema, DB read-model, sync và fallback; từng có lỗi nhánh DB không trả đủ routing diagnostics dù JSON có.

### AI agent SQLite

`data/agent_system.db` qua `better-sqlite3`:

- `agents`, `tools`, `agent_tools`
- `agent_memory`
- `openrouter_models`
- `execution_logs`

WAL mode được bật. Đây là data runtime, không commit.

---

## 8. Authentication, SSO, RBAC và scope

### Auth

- Local app auth dùng `APP_USERNAME` / `APP_PASSWORD` + session/cookie.
- Portal SSO cookie: `th_portal_session`; JWT từ `PORTAL_JWT_SECRET`.
- Cookie mặc định domain `.tehui.io.vn`, `httpOnly`, `Secure`, `SameSite=Lax`, expiry 7 ngày.
- `src/auth/session.js` resolve principal từ portal JWT hoặc legacy app session.

### Roles mặc định

`src/middleware/authorize.js`:

- `admin`: `*`.
- `manager`: quản lý portal users/departments/channels, xem hội thoại theo department, assign/transfer/reply, presence.
- `staff`: app launcher, xem account/hội thoại được giao, reply, transfer trong bộ phận, tự update presence.

Quyền configurable (portal UI) gồm portal user/department, channel, conversation, assignment/transfer/reply, presence. **Backend permission guard là chính; UI hide/disable không đủ.**

### Visibility/account isolation

`src/services/access-service.js`:

- Admin toàn quyền.
- Manager được scope department.
- Staff chỉ xem account/thread được cấp/assigned.
- `buildScopedView()` lọc accounts, threads, contacts và stats trước khi trả về UI.

**Không được bỏ lọc chỉ để “test nhanh”.** Account/thread Zalo là dữ liệu riêng tư.

---

## 9. Multi-account Zalo: invariants bắt buộc

### Mô hình đúng

`src/providers/zalo-web-provider.js` dùng:

- `accountClients: Map<accountId, { api, ... }>`
- `getAccountApi(accountId)` — lấy đúng Zalo API client theo account.
- `accountStateById` — snapshot state/account.
- `updateAccountScopedState()` — mutation scope theo account.
- SSE event mang `accountId`; frontend phải bỏ event account không đang xem.

### Tuyệt đối tránh

- Không dùng global `this.api` hoặc active account fallback cho thao tác của một account chỉ định.
- Không load/send/react/delete/thread/profile/social bằng client không đúng `accountId`.
- Không merge event khác account vào UI hiện tại.
- Không assume multi-account chỉ là UI switch; provider state và realtime cũng phải isolated.

### QR/login/reconnect

Các APIs chính:

- `POST /api/sessions/qr/start`
- `POST /api/sessions/qr/confirm` — **chỉ cho mock provider**
- `POST /api/accounts/logout`
- `POST /api/accounts/select`
- `GET /api/accounts`
- `POST /api/sync/bootstrap`

Credentials/runtime session nằm trong `data/credentials.json` và `data/accounts/`; không commit/copy ra ngoài.

### Provider settings hiện có

`ZALO_CLIENT_OPTIONS` dùng `selfListen: true`, `checkUpdate: true`, logging true.

**Known bug cũ:** `selfListen: false` làm message do chính account gửi trong group không đi vào listener/realtime. Đừng đổi setting này mà không test live account/thread được phép.

---

## 10. Chat UI, messages và realtime

### APIs core

- `GET /api/health`, `GET /api/version`
- `GET /api/state` — trả scoped view
- `GET /api/events` — SSE
- `POST /api/messages/send`
- `POST /api/messages/sticker`
- `POST /api/messages/undo`
- `POST /api/messages/delete`
- `POST /api/messages/react`
- `GET /api/threads/messages`
- `POST /api/threads/read`, `/unread`, `/pin`, `/archive`, `/hide`, `/mute`, `/delete`, `/auto-delete`, `/meta`, `/rename`
- `GET /api/threads/profile`
- `GET /api/friends`, `/friends/search`, `/friends/status`
- friend/group actions: request/accept/reject/undo/remove/block/unblock; group leave/link/invite
- sticker packs: `GET /api/stickers/packs`, `/api/stickers/pack`
- uploads: `GET /api/uploads/:filename`

### Send/pending/IME — bài học bắt buộc

Dấu hiệu từng gặp: text tiếng Việt gửi đôi hoặc bị cắt phần cuối; album ảnh kẹt “Đang gửi” dù Zalo đã gửi.

Nguyên nhân đã verify: server/provider append outgoing/pending rồi client/realtime lại append message thật — hai nguồn state. Enter trong lúc IME compose cũng có thể submit phần chữ cuối.

Quy tắc:

1. Chỉ một nguồn pending ở client; server gửi qua API, realtime là source of truth để merge/remove.
2. Composer phải guard `event.isComposing || event.keyCode === 229` trước Enter submit.
3. Optimistic text/image phải merge hoặc remove khi realtime message thật đến.
4. Album pending chỉ biến mất sau khi nhận đủ attachment count / `total_item_in_group` trong time window hợp lý.
5. API error phải kết thúc pending thành “Gửi lỗi”, không để treo “Đang gửi”.

Verify tối thiểu sau sửa phần này:

```bash
node --check public/app.js
node --check src/providers/zalo-web-provider.js
```

Sau đó browser live + một thread/account được phép: text có dấu, album nhiều ảnh, rồi confirm pending count = 0 và `data/state.json` đúng thread.

---

## 11. Portal/Omnichannel và routing

### Portal endpoints đáng chú ý

- `GET /api/portal/me`, `/apps`, `/catalog`, `/settings`, `/db/status`
- `POST /api/portal/settings`
- `GET/POST /api/portal/roles`
- `GET /api/portal/ops/overview`, `/activity`
- `POST /api/portal/departments`, `/users`, `/channels`
- `DELETE /api/portal/users/:id`
- `POST /api/portal/threads/bind`
- `POST /api/portal/conversations/assign`
- `POST /api/portal/presence`
- `POST /api/portal/routing/plan`
- `POST /api/portal/sso/mock-login` — only testing/development, verify guards before enabling live use.

### Routing

`src/services/routing-service.js` hỗ trợ:

- `least_connections` (default): ít open conversations hơn ưu tiên.
- `round_robin`: người có `lastAssignedAt` cũ hơn ưu tiên.
- `routingWeight`, capacity/status và force-offline là tie/exclusion inputs.
- Priority weight: vip=400, complaint=300, hot_lead=200, normal=100.
- Nếu không có eligible agent: action `queue`, reason `no-online-agent`.

Routing action phải được lưu explanatory diagnostics: strategy, reason, candidate/exclusion, SLA/priority context. Manual bind/assign cũng phải ghi diagnostics (không chỉ auto route) để audit không mất dấu.

### Presence

`derivePresenceStatus()`:

- force offline còn hạn → offline
- declared busy → busy
- last activity quá 90 giây (default) → offline
- còn lại online

---

## 12. AI automation (ChiHome focus)

### Mục tiêu và guardrails

AI là CSKH advisory/automation theo department/thread, đặc biệt cho ChiHome:

- Không tự bịa availability, giá, tiện ích hoặc policy.
- Booking/tìm phòng cần lấy dữ liệu live từ ChiHomeHotel API khi đủ điều kiện.
- Complaint/refund/negative sentiment/yêu cầu người thật → pause/escalate thay vì cố trả lời.
- Không nói với khách về AI, model, prompt, agent hoặc tool nội bộ.

### Các module

| Module | Vai trò |
|---|---|
| `ai-automation-service.js` | normalize config, flow, agent plan, thread automation state, prompt library |
| `ai-automation-runtime.js` | ingest inbound, deterministic/LLM routing, execution, escalation, logs/trace |
| `ai-automation-openrouter.js` | OpenRouter call, model fallback chain, usage, ChiHome tool integration |
| `ai-automation-channel-adapter.js` | bridge typing/send message sang provider |
| `ai-automation-contract.js` | action/result/event contracts |
| `agent-system-db.js` | agent/tool registry, memory, execution logs, default model seeds |
| `telegram-alert-service.js` | alert Telegram redacting secret fields |

### Agent registry mặc định

- `orchestrator`: planner, model tier medium
- `retrieval`: grounding, small
- `hotel_live_data`: tool user, small
- `booking_agent`: booking specialist, small
- `room_detail_agent`: data processor, small
- `house_rules_agent`: policy specialist, small
- `guest_stay_agent`: stay support, small
- `company_ops_agent`: ops specialist, small
- `special_cases_agent`: risk/escalation, medium
- `policy_guard`: verifier/QA, medium
- `composer`: final writer, medium

### Booking flow ChiHome

AI chỉ thu **3 loại dữ kiện cần thiết**:

1. Ngày check-in
2. Ngày check-out
3. Số phòng ngủ hoặc số khách quy đổi

Ngày tự nhiên (hôm qua/hôm nay/ngày mai/mốt...) phải đổi về `YYYY-MM-DD` theo timezone Việt Nam trước khi gọi API. Khi đủ dữ kiện, gọi live search ngay; không hỏi view/toà/ngân sách trước.

Trả kết quả khi có phòng phải nêu:

- số căn phù hợp;
- ngày nhận/trả, số đêm và khách/số PN;
- từng căn: toà + mã căn, số PN, số WC, giá/đêm, tổng tiền, ảnh của đúng căn.

Không chỉ trả lời số lượng căn hoặc hứa “để kiểm tra rồi báo lại”.

### Escalation rules

Default keywords/signal: khiếu nại, bực/tức, không hài lòng, hoàn tiền/refund, huỷ phòng, yêu cầu quản lý/người thật, khẩn cấp. Hành vi đúng: acknowledge ngắn, không tranh cãi/hứa vượt thẩm quyền, pause thread automation, handoff summary + Telegram alert nếu cấu hình.

### OpenRouter

- API base default: `https://openrouter.ai/api/v1`.
- Nếu không có `OPENROUTER_API_KEY`, provider status phải là `missing_api_key`; không gọi lại/hack workaround.
- Fallback model selection ưu tiên agent/model tier, plan tier, config fallback rồi catalog; tối đa 4 candidate.
- SQLite seed hiện có model basic/complex cũ (DeepSeek V4 Flash, GPT-4o, Claude 3.5 Sonnet); **không assume chúng đang available/billing được** — verify OpenRouter account/runtime.

### AI APIs

- `GET/POST /api/ai-automation/config`
- `GET /api/ai-automation/knowledge`
- `POST /api/ai-automation/knowledge/upload`
- `POST /api/ai-automation/knowledge/delete`
- `POST /api/ai-automation/plan-preview`
- `POST /api/ai-automation/simulate`
- `GET/POST /api/threads/automation`
- `GET /api/threads/memory`
- `POST /api/threads/memory/delete`
- `GET /api/agents`, `GET/PATCH /api/agents/:id`
- `GET /api/executions/:id/trace`

---

## 13. ChiHomeHotel integration

`src/services/chihomehotel-client.js` gọi API thật của ChiHome PMS:

- `GET /buildings`
- `GET /room-types`
- `GET /rooms`
- `GET /reservations/quick-room-search`
- `GET /reservations`

Defaults:

- Base: `https://api.tehui.io.vn/api`
- Auth header: `x-api-key`
- Timeout: 15 seconds

Nếu thiếu key, client deliberately throws `missing_api_key`. Do not replace bằng fake data hoặc đọc XLSX cũ để trả lời khách. `quick-room-search` là nguồn chuẩn cho availability live.

Liên kết khác:

- `GET /api/chihomehotel/booking-bridge`
- `GET /api/chihome/resolve-thread`
- Config booking bridge base default: `https://tehui.io.vn/bridge/zalo-booking`

Không tạo/sửa booking thật chỉ bằng AI nếu chưa có flow được phê duyệt rõ.

---

## 14. Backup/restore

`scripts/backup.sh` tạo archive `zalo-user-server-backup-YYYYMMDD-HHMMSS.tar.gz` (mặc định `~/ .openclaw/workspace/backups`; xem script) và xóa backup cũ, chỉ giữ newest.

**Cảnh báo:** script hiện tar gần toàn project, chỉ exclude node_modules, DS_Store, log, tmp. Điều này có thể bao gồm `.env`, credentials và data state trong archive. Backup phải lưu nội bộ an toàn; không commit/upload public. Trước khi đổi script hoặc restore, inspect `scripts/restore.sh`, confirm target và backup phù hợp.

---

## 15. Git workflow

- Local repo đã init/push private 2026-09-09.
- Remote: `origin https://github.com/clone-tehui/zl-multiaccount.git`.
- Không lưu GitHub token trong remote URL/config/repo.
- Commit author là metadata có thể đặt bằng `git config user.name/user.email`; **không phải access control**.
- Quyền push do GitHub account/collaborator/token/SSH key quyết định. Dùng fine-grained token per-repo, rotate/revoke khi không cần.
- Trước commit luôn kiểm:

```bash
git status --short
git diff --cached --name-only
git check-ignore -v .env data/state.json data/credentials.json
```

Không force push `main` nếu chưa hiểu history/được duyệt.

---

## 16. Quy trình sửa live chuẩn

1. Đọc handoff này, `README`, đúng module code và runtime/log/API liên quan.
2. Xác định project/path/domain/account/thread cụ thể; không suy đoán account đang active.
3. Lập impact map: app, provider, data state, Docker, Nginx/tunnel, ChiHome API, n8n (nếu liên quan).
4. Backup file trước UI/server batch lớn; chỉ giữ latest backup theo policy.
5. Sửa batch nhỏ nhất, không cleanup/refactor ngoài scope.
6. Chạy `npm run check` + targeted script/test.
7. Nếu thay đổi live: verify API/browser/log/source asset thật, không dùng cache/version làm bằng chứng duy nhất.
8. Multi-account change: test đúng account/thread được phép, SSE account isolation, state scoped.
9. Ghi lại: thay đổi, evidence verify, rollback, risks trong handoff/project state/daily note.

---

## 17. Known risks and troubleshooting

| Dấu hiệu | Khả năng / kiểm tra đầu tiên |
|---|---|
| Public zl.tehui.io.vn 530/1033 nhưng local health OK | Cloudflare tunnel/service chết; kiểm LaunchAgent, tunnel config/log, public HTTP. Đừng chạy tunnel tạm bằng exec làm “fix”. |
| AI không phản hồi | Check thread automation mode, selected account/department, inbound vs outgoing-self-message, `OPENROUTER_API_KEY`, `/api/ai-automation/config`, execution trace/log. |
| AI báo `missing_api_key` | Container/app `.env` thiếu `OPENROUTER_API_KEY` hoặc ChiHome API key. Source code không phải bằng chứng runtime đã có key. |
| Tin nhắn lẫn account | Kiểm payload SSE có `accountId`, frontend filter account, server mutation/api client account-scoped. |
| Tin nhắn gửi đôi / text IME bị cắt | Kiểm pending ownership và `isComposing/keyCode 229` guard; realtime merge logic. |
| Album ảnh kẹt Đang gửi | Kiểm realtime attachment/`total_item_in_group` merge + pending removal. |
| Portal DB thiếu field UI | So sánh JSON read với DB read model, sync service và migration; fallback JSON phải còn hoạt động. |
| Routing không có audit | Check manual bind/assign có append journal diagnostics; không chỉ inspect auto route. |
| Zalo account reconnect/sync lỗi | Inspect account credential/state đúng account, zca-js logs, concurrency/rate config; không xoá credentials vội. |

---

## 18. Do-not-touch summary

- n8n data/workflows/container/config (chưa có approval).
- Cloudflare/Nginx/tunnel hệ khác, đặc biệt hotel/crypto.
- Zalo credentials, account sessions, production data state khi chưa backup/được duyệt.
- Multi-account scope/realtime filter.
- JSON fallback khi PostgreSQL chưa được chứng minh đầy đủ.
- ChiHome availability truth: không thay bằng data giả/static.
- AI escalation guardrails và no-self-message proof rule.

---

## 19. Handoff checklist cho agent mới

Trước khi nhận bất kỳ task zlsever nào, agent phải trả lời/verify được:

- [ ] Đúng repo/path và branch hiện tại?
- [ ] Runtime nào đang chạy: local Node hay Docker container?
- [ ] Public URL/local health/tunnel trạng thái gì?
- [ ] `DATA_DIR` nào và data nào là runtime-sensitive?
- [ ] Account Zalo nào / thread nào / department nào thuộc scope task?
- [ ] Có DB `DATABASE_URL` không? read source hiện `json`, `db`, hay `auto`?
- [ ] Task có đụng ChiHome API, OpenRouter, Telegram alert hoặc n8n không?
- [ ] Có test/rollback phù hợp chưa?
- [ ] Đã kiểm `.gitignore` trước commit chưa?

Nếu chưa có evidence cho một điểm, phải kiểm tra trước — không được trả lời hay sửa theo memory/suy đoán.
