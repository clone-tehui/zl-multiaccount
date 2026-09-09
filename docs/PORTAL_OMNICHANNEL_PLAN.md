# Portal Omnichannel CRM Plan

## Mục tiêu
Nâng cấp `zl.tehui.io.vn` từ Zalo inbox đơn lẻ thành nền tảng App Portal + Omnichannel CRM theo mô hình gần Lark Suite / CareSoft, nhưng phải giữ an toàn hạ tầng hiện tại:

- Không đụng config Nginx tổng, Cloudflare tunnel tổng, Docker Compose của service khác.
- Chỉ thêm mới cho `portal.tehui.io.vn`.
- Chỉ sửa trong phạm vi source code project `zl.tehui.io.vn` hiện tại.
- Các project/subdomain khác phải tách biệt hoàn toàn.

## Thực trạng repo hiện tại
Repo hiện đang là 1 app Node thuần:
- `src/server.js`: HTTP server + auth app nội bộ + REST + SSE.
- `public/*`: frontend chat đơn khối.
- `src/providers/zalo-web-provider.js`: adapter Zalo Web.
- `src/lib/store.js`: state store/file JSON.

Hiện tại repo chưa có:
- DB thật.
- user portal nhiều vai trò.
- SSO subdomain.
- RBAC middleware theo resource/action.
- routing omnichannel.
- module launcher / portal shell.

## Kiến trúc đề xuất

### 1) Tách 2 lớp ứng dụng
1. `portal.tehui.io.vn`
   - Login SSO chung.
   - App launcher theo quyền.
   - Quản trị user / role / department / channel.
   - Dashboard vận hành.

2. `zl.tehui.io.vn`
   - Inbox agent workspace.
   - Dùng cookie SSO `.tehui.io.vn` để vào app.
   - Chỉ render channel/thread được phép xem.

### 2) Kiểu tích hợp an toàn
- Không merge portal vào app chat theo kiểu 1 codebase hỗn loạn ngay từ đầu.
- Giai đoạn đầu nên dùng **shared auth contract** + **shared database**.
- `portal.tehui.io.vn` là app mới riêng.
- `zl.tehui.io.vn` giữ vai trò inbox engine/workspace.

## Database đề xuất
Nên bỏ dần file JSON state cho phần CRM nghiệp vụ, chuyển sang DB quan hệ.
Khuyến nghị: **PostgreSQL**.

### Nhóm bảng identity
- `roles`
  - `id`, `code` (`admin|manager|staff`), `name`, `description`
- `users`
  - `id`, `username`, `password_hash`, `display_name`, `email`, `phone`
  - `status` (`online|offline|busy`)
  - `last_active_at`
  - `last_assigned_at`
  - `force_offline_until`
  - `is_active`
  - `created_at`, `updated_at`
- `user_roles`
  - `user_id`, `role_id`
- `departments`
  - `id`, `code`, `name`, `description`, `manager_user_id`, `is_active`
- `user_departments`
  - `user_id`, `department_id`, `is_primary`, `created_at`

### Nhóm bảng kênh / channel
- `channels`
  - `id`
  - `channel_type` (`zalo_personal|zalo_oa|facebook_page`)
  - `code`, `name`
  - `department_id`
  - `bot_status` (`enabled|disabled`)
  - `routing_mode` (`least_connections|round_robin|manual`)
  - `is_active`
  - `created_at`, `updated_at`
- `channel_credentials`
  - `id`, `channel_id`, `secret_ref`, `meta_json`, `created_at`, `updated_at`
  - UI manager/staff không được thấy giá trị secret thô
- `channel_members`
  - `channel_id`, `user_id`, `can_handle`, `priority_weight`

### Nhóm bảng contact / conversation
- `contacts`
  - `id`, `channel_id`, `external_contact_id`, `display_name`, `avatar_url`, `phone`, `meta_json`
- `conversations`
  - `id`, `channel_id`, `contact_id`
  - `external_thread_id`
  - `status` (`bot_handling|open|pending|closed`)
  - `assigned_user_id`
  - `department_id`
  - `last_message_at`
  - `first_response_at`
  - `closed_at`
  - `created_at`, `updated_at`
- `messages`
  - `id`, `conversation_id`, `sender_type`, `sender_user_id`, `external_message_id`
  - `message_type`, `text`, `payload_json`, `sent_at`, `created_at`
- `message_attachments`
  - `id`, `message_id`, `kind`, `url`, `preview_url`, `mime_type`, `name`, `size`, `meta_json`
- `conversation_tags`
  - `conversation_id`, `tag_id`
- `tags`
  - `id`, `name`, `color`, `department_id`
- `conversation_notes`
  - `id`, `conversation_id`, `author_user_id`, `content`, `created_at`
- `conversation_transfers`
  - `id`, `conversation_id`, `from_user_id`, `to_user_id`, `reason`, `created_at`
- `routing_queue`
  - `id`, `conversation_id`, `department_id`, `priority`, `queued_at`, `status`

### Nhóm audit / session / auth
- `auth_sessions`
  - `id`, `user_id`, `session_token_hash`, `expires_at`, `ip`, `user_agent`, `created_at`
- `audit_logs`
  - `id`, `actor_user_id`, `action`, `resource_type`, `resource_id`, `payload_json`, `created_at`
- `sso_tokens` (nếu cần one-time exchange thay vì self-contained JWT)
  - `id`, `user_id`, `jti`, `expires_at`, `consumed_at`

## SSO đề xuất

### Phương án phù hợp nhất giai đoạn đầu
Dùng **JWT HttpOnly cookie dùng chung cho `.tehui.io.vn`**.

Cookie đề xuất:
- `name`: `th_portal_session`
- `domain`: `.tehui.io.vn`
- `httpOnly: true`
- `secure: true`
- `sameSite: Lax`
- `path: /`

JWT claims tối thiểu:
- `sub` = user id
- `username`
- `roles`
- `department_ids`
- `session_version`
- `iat`, `exp`, `jti`

### Flow
1. User login tại `portal.tehui.io.vn`.
2. Portal verify user/password.
3. Portal set cookie `.tehui.io.vn`.
4. User bấm app `Zalo User`.
5. `zl.tehui.io.vn` middleware đọc cookie, verify JWT.
6. Server nạp entitlement hiện tại từ DB.
7. Trả UI theo quyền.

### Ý kiến thêm của mình
Không nên tin hoàn toàn role/department nằm sẵn trong JWT quá lâu.
- JWT chỉ dùng để xác thực phiên.
- Quyền thực tế nên được refresh từ DB mỗi request hoặc cache ngắn 30-60 giây.
=> tránh trường hợp vừa đổi quyền nhưng token cũ vẫn còn hiệu lực quá rộng.

## RBAC middleware

### Permission model nên dùng
Không chỉ check role cứng `admin/manager/staff`, mà map thành permission chi tiết:

Ví dụ:
- `portal.users.read`
- `portal.users.write`
- `portal.departments.write`
- `channels.credentials.read_secret`
- `channels.credentials.manage`
- `conversations.read_all_department`
- `conversations.read_assigned_only`
- `conversations.assign`
- `conversations.transfer`
- `conversations.reply`
- `conversations.force_close`
- `presence.force_offline`

### Rule cốt lõi
- **Admin**: full quyền.
- **Manager**:
  - xem tất cả conversation thuộc department mình quản.
  - assign/transfer trong department.
  - force offline staff trong department.
  - không đọc secret/token thô.
  - không tạo department mới.
- **Staff**:
  - chỉ thấy conversation được assign cho mình hoặc queue được department cấp.
  - chỉ thao tác channel thuộc department mình.
  - không xem secret/token/thread internals.

### Middleware tầng API
Nên đi theo chuỗi:
1. `authenticateSSO()`
2. `loadUserContext()`
3. `requirePermission(permission)`
4. `scopeDepartmentAccess()`
5. `scopeConversationAccess()`

Không chỉ ẩn nút ở frontend; phải chặn ở API.

## Routing omnichannel

### Thuật toán base theo yêu cầu
1. Nếu channel `bot_status = enabled`:
   - bot xử lý trước.
   - nếu bot resolve được -> giữ `bot_handling` hoặc auto-close theo rule.
   - nếu bot fail / khách đòi người thật -> escalate.
2. Lọc staff khả dụng:
   - cùng department
   - thuộc channel đó hoặc department đó
   - `status = online`
   - không bị force offline
3. Chọn agent theo **Least Connections**.
4. Nếu hòa, dùng **Round Robin** qua `last_assigned_at`.
5. Nếu không có ai online -> đưa `pending queue`.
6. Khi staff online lại -> quét queue và assign.

### Sáng tạo thêm để hệ thống mạnh hơn
Mình đề xuất bổ sung 5 lớp thông minh hơn:

#### A. Capacity limit
Mỗi staff có `max_open_conversations`.
- Không chỉ đếm ít nhất, mà còn chặn quá tải.
- Ví dụ staff A đang online nhưng đã ôm 20 ticket thì không assign thêm.

#### B. Skill-based routing
Thêm `conversation_skill` / `staff_skill`.
- Sale, CSKH, kỹ thuật, VIP, khiếu nại.
- Routing ưu tiên người đúng skill trước, rồi mới least-connections.

#### C. Sticky assignment
Nếu khách cũ quay lại trong 24h/72h:
- ưu tiên trả về agent cũ nếu agent đó đang online và chưa full tải.
=> trải nghiệm khách sẽ liền mạch hơn.

#### D. SLA priority
Conversations có thể có `priority`:
- vip
- complaint
- hot lead
- normal
Queue nên ưu tiên theo SLA trước, không chỉ FIFO.

#### E. Rebalance thủ công có kiểm soát
Manager có thể bấm “cân tải” trong department:
- chỉ gợi ý transfer ticket lệch tải
- không auto giật ticket đang chat liên tục nếu chưa có rule timeout

## Presence / online-offline
Phần này rất quan trọng và prompt gốc mới nói một nửa.

Nên có 3 nguồn trạng thái:
1. user tự set `online/busy/offline`
2. heartbeat browser/tab
3. manager force offline

Rule đề xuất:
- Browser ping `last_active_at` mỗi 20-30 giây.
- Nếu quá 90 giây không heartbeat => chuyển `offline` logic.
- Nếu user chọn `busy` => vẫn online nhưng routing weight thấp hoặc không nhận ticket mới.
- `force offline` của manager phải có `reason` + `expires_at`.

## Bảo mật secret/channel credentials
Prompt gốc ghi `credentials JSON`, nhưng mình khuyên **không lưu raw secret thẳng trong cùng bảng business**.

Nên dùng:
- `channel_credentials.secret_ref`
- secret thật nằm ở encrypted store / env-backed secret layer / file mã hóa riêng

Ít nhất nếu chưa có secret manager:
- mã hóa AES-GCM bằng 1 master key từ env
- manager/staff chỉ thấy masked value
- audit log mọi thao tác sửa credentials

## Tích hợp với repo hiện tại

### Giai đoạn 1 - refactor nền móng trong `zl.tehui.io.vn`
- Tách auth module ra khỏi `src/server.js`
- Tạo middleware pipeline
- Tạo DAL/repository layer
- Tạo abstraction cho DB
- Giữ provider Zalo Web nguyên vai trò adapter

### Giai đoạn 2 - CRM schema + user system
- Thêm PostgreSQL
- Migration cho roles/users/departments/channels/conversations/messages
- Backfill từ state JSON hiện tại nếu cần

### Giai đoạn 3 - Portal app mới
- App mới cho `portal.tehui.io.vn`
- Login SSO
- App launcher
- Quản trị user/department/channel

### Giai đoạn 4 - RBAC đầy đủ + scoped UI
- `zl.tehui.io.vn` chỉ render đúng channel/thread được phép
- staff/manager/admin có dashboard riêng

### Giai đoạn 5 - routing engine
- queue
- least-connections
- round-robin tie-break
- sticky assignment
- SLA priority

## Các file nên tách trong repo hiện tại
Gợi ý cấu trúc mới trong `src/`:
- `src/auth/session.js`
- `src/auth/jwt.js`
- `src/auth/cookies.js`
- `src/middleware/authenticate.js`
- `src/middleware/authorize.js`
- `src/middleware/scope.js`
- `src/db/client.js`
- `src/db/migrations/*`
- `src/repositories/users.js`
- `src/repositories/departments.js`
- `src/repositories/channels.js`
- `src/repositories/conversations.js`
- `src/services/routing-service.js`
- `src/services/presence-service.js`
- `src/services/channel-credential-service.js`
- `src/services/audit-service.js`
- `src/routes/portal/*`
- `src/routes/api/*`

## Những điểm mình thấy cần chỉnh lại từ prompt gốc
1. `credentials JSON` là đúng hướng MVP, nhưng production nên tách secret khỏi business record.
2. Không nên để manager chỉ dựa vào UI hide; phải chặn ở API + query scope.
3. `status = online/offline/busy` chưa đủ; cần heartbeat + force_offline + timeout.
4. Routing chỉ least-connections + round-robin là ổn bản đầu, nhưng nên thêm capacity limit và sticky assignment để dùng thực tế đỡ vỡ.
5. Nên coi `Zalo/OA/Facebook` là channel adapters chung, đừng hardcode logic nghiệp vụ vào riêng Zalo.

## Thứ tự code mình khuyên làm ngay
1. Thêm lớp DB + migrations.
2. Thêm auth/session abstraction để sau này thay login local bằng SSO không đau.
3. Thêm bảng users/roles/departments/channels.
4. Thêm RBAC middleware.
5. Thêm conversation ownership/assignment.
6. Thêm routing engine.
7. Sau cùng mới làm portal UI đầy đủ.

## Deliverables ngắn hạn mình có thể làm tiếp ngay
1. Thiết kế schema SQL chi tiết.
2. Viết middleware auth/RBAC skeleton.
3. Tạo khung SSO cookie `.tehui.io.vn`.
4. Refactor `src/server.js` thành router modules.
5. Draft UI portal launcher.

## Kết luận
Ý tưởng gốc của Tehui là đúng hướng và đủ lớn để thành một nền tảng thật, không chỉ là “web Zalo đẹp hơn”.
Điểm quan trọng nhất là:
- tách portal và workspace,
- bỏ auth đơn giản hiện tại để lên SSO + RBAC thật,
- chuyển state nghiệp vụ sang DB,
- xây routing engine như một service riêng.

Làm đúng thứ tự thì sẽ lên được rất chắc mà vẫn không đụng hạ tầng production chung.
