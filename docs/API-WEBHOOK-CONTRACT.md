# API và webhook — static source contract và giới hạn kiểm chứng

Task sao lưu source VPS ngày31/10/2026. Đây là ghi nhận static từ95file snapshot, không phải kết quả gọi API nghiệp vụ. Inventory máy đọc được nằm ở `api-inventory.json`:90literal method/path pairs, thêm5route dynamic/array/upgrade ghi riêng. Regex không thay cho contract test toàn bộ route.

## Auth và account scope

`src/server.js` tạo principal từ session cookie, compat token hoặc ChiHome lookup auth, rồi đặt account trong AsyncLocalStorage. Header `X-Zalo-Account-Id` và query `accountId` xung đột trả403. Account không trong quyền nhìn thấy bị từ chối; selection mặc định theo session. Body selector qua `validateBodyAccountScope` và validate context; không coi active account toàn cục là quyền truy cập.

Compat principal dùng `Authorization: Bearer <COMPAT_API_TOKEN>`, `x-compat-api-key` hoặc `x-bot-api-secret-token`; cấu hình env ưu tiên hơn integration secret. `/api/compat/manager` có ngoại lệ token qua global API gate. Alias `/get/post` có đường đi khác; tài liệu host hiện khuyên dùng cookie và không giả định token cho alias. Chưa audit đầy đủ các biến thể alias, không đổi source để đồng nhất.

`/api/chatbot/send` dùng riêng `x-chatbot-bridge-secret`; cần `accountId`, `threadId`, `text` không rỗng và allowlist account. Thành công trả `{ok:true,message}`; sai secret401, account bị cấm403. Không gọi endpoint này trong task.

Tra cứu ChiHome trong snapshot publish chỉ chấp nhận `CHIHOME_BOOKING_BRIDGE_SECRET` đã cấu hình (qua `x-chihome-bridge-secret`, `x-booking-bridge-secret` hoặc query `secret`), ngoài principal compat/session hiện có. Biến thiếu/rỗng từ chối đường auth này; không còn literal dự phòng. Đây là thay đổi chỉ ở bản snapshot, chưa áp dụng production. API admin/portal có guard riêng; staff còn cần account/channel/thread membership phù hợp, không chỉ role name.

## Webhook outbound

Provider `deliverWebhookEvent` kiểm integration enabled/URL và selectedAccountIds. Message được normalize và bọc `messageData`; friend dùng `friendEvent`; các event khác dùng `eventName`/`data`; envelope mang account/account_id/account_name/zalo_name. Trường `AIchat` chỉ là `ON` hoặc `off` theo thread trong bucket account. Album được gom theo account/thread/group trong khoảng700ms. `sendWebhookBody` POST JSON, thêm `x-bot-api-secret-token` nếu có secret, cập nhật lastDeliveryAt/lastDeliveryError; không thấy retry/AbortController riêng ở đường này.

Bridge chatbot riêng chỉ bật khi URL+secret có giá trị; selected account list rỗng nghĩa là không lọc account. Chặn outgoing, mặc định chặn group. POST JSON với `x-chatbot-bridge-secret`; tối đa3attempt, mặc định timeout8000ms mỗi attempt, chờ250/500ms giữa lần thử. Payload gồm event/source/messageData/account/recipient_account_id/thread/sender/AIchat. Sender là người gửi, recipient_account_id là account nhận; không đồng nhất hai identity. Raw/normalized message có thể chứa dữ liệu khách, nên chỉ dùng ví dụ synthetic và không copy payload production vào repo/evidence.

Ví dụ envelope minh họa, chỉ thể hiện cấu trúc và không thực thi:

```json
{"event":"message","source":"zl-multiaccount","account_id":"synthetic-account-A","recipient_account_id":"synthetic-account-A","thread":{"id":"synthetic-thread","type":"direct","title":"Synthetic"},"sender":{"id":"synthetic-sender","displayName":"Synthetic"},"messageData":{"threadId":"synthetic-thread","senderId":"synthetic-sender","isOutgoing":false},"AIchat":"off"}
```

SSE `/api/events` gắn account khi mở, lọc quyền account/thread trước serialize. Voice WSS `/api/calls/media` kiểm same-host Origin và quyền account/direct-thread/reply; reauthorize khi trao đổi và heartbeat. JSON command gồm start/accept/reject/end; binary dành cho audio, không phải webhook tin nhắn. Capabilities báo audio và video:false. Không mở voice production hoặc gửi media.

## Mức coverage và phần còn thiếu

Đã đọc source auth/account selection, route gates, webhook/album/bridge, AIchat và voice gateway;69JS/MJS syntax đạt,27test synthetic đạt. Tests gồm multipart dispatch, QR ownership, voice lifecycle/media/access, latest SDK dispatch và chatbot filtering/retry. Tests không tạo QR thật, không gọi provider/send/webhook khách; child app dùng mock provider và dữ liệu tạm.

Chưa hoàn thành request/response schema, RBAC matrix và synthetic contract coverage cho từng route trong inventory. Chưa chạy authenticated live API, staff E2E, inbound Zalo, handset/audio hoặc webhook delivery thật; các phần này không được thực hiện trong task source-only này. Docs có trước trong candidate giữ provenance host/local/remote tại file-provenance.json, không khẳng định tất cả đã được revalidate. Không publish tài liệu như một API specification hoàn chỉnh.


## Route inventory và ví dụ synthetic
Xem [api-inventory.json](api-inventory.json) cho 90 method/path literal và 5 route bổ sung; line numbers tham chiếu snapshot gốc, auth gate mới giảm một dòng từ vị trí1899. `GET /api/health` và `GET /api/version` là health/version. `GET /api/chihome/resolve-thread` dùng auth ChiHome/compat/session; thiếu auth trả401. `POST /api/compat/manager` dùng auth compat/session, chọn account bằng `credential_id`/`accountId` cùng header account theo quyền principal; multipart `operation=send_message`, `conversationId`, `content`, binary `files` được synthetic test, không thực thi lệnh gửi production. `POST /api/chatbot/send` cần bridge secret riêng và account allowlist. `GET /api/events` là SSE; upgrade `/api/calls/media` là WSS audio.

Ví dụ request chỉ mô tả hợp đồng, không chứa credential thật:
```http
POST /api/compat/manager
Authorization: Bearer <COMPAT_API_TOKEN>
X-Zalo-Account-Id: synthetic-account-A
Content-Type: application/json

{"operation":"send_message","credential_id":"synthetic-account-A","conversationId":"synthetic-thread","content":"Synthetic example only"}
```
Compat response schema phụ thuộc operation/provider; không khẳng định một schema chung. Chatbot success `{ "ok": true, "message": {} }` có message theo provider; thiếu/sai secret401, account ngoài allowlist403. Những ví dụ này không phải lời mời chạy write trên production.

Auth/env regression mới chạy trực tiếp hàm source trong VM: thiếu/rỗng/whitespace env, sai token, hai header/query, cấu hình đúng và compat precedence. Đây là static unit regression; chưa phải HTTP/RBAC acceptance cho toàn bộ ChiHome route.
