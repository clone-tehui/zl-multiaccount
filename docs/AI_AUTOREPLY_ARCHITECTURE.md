# AI Auto Reply / Multi-Agent CSKH cho `zlsever`

## 1) Mục tiêu

Biến `zlsever` từ inbox + routing engine thành **AI customer care workspace** có thể:

- tự hiểu khách đang hỏi gì
- chọn đúng nguồn dữ liệu để trả lời
- chỉ dùng model đủ mạnh cho từng tình huống để tiết kiệm chi phí
- bật/tắt/tạm dừng auto reply **theo từng khách / từng thread**
- tự escalate sang người thật khi khách complaint, case rắc rối, thiếu dữ liệu, hoặc confidence thấp
- tái sử dụng cho `ChiHome` trước, rồi mở rộng sang bộ phận khác sau

---

## 2) Những gì đã xác minh trong code hiện tại

### `zlsever`

1. `src/server.js`
   - đã có event `message.created` cho incoming message
   - đã có `applyPortalRoutingOnIncoming()` để auto bind / auto assign theo portal routing
   - đã có `booking-bridge` cho `ChiHome`
   - phù hợp để gắn thêm **AI orchestration hook** ngay sau routing

2. `src/lib/store.js`
   - đang có JSON state trung tâm + bucket theo account
   - thread object đã là nơi hợp lý để lưu `automation mode`, `resumeAt`, `lastEscalatedAt`

3. `src/providers/zalo-web-provider.js`
   - đang hydrate `autoReplies` native của Zalo Web, nhưng đó mới là feature auto reply của nền tảng, **không phải AI orchestration**

### `chihomehotel`

1. `apps/api/src/reservations/reservations.controller.ts`
   - có endpoint `GET /reservations/quick-room-search`
   - đây là nguồn **chuẩn nhất** để AI tìm phòng trống theo ngày

2. `apps/api/src/reservations/reservations.service.ts`
   - quick search đang kiểm tra overlap booking bằng điều kiện thời gian thực sự
   - trả về `roomId`, `roomCode`, `roomNumber`, `building`, `roomType`, `images`
   - đây là đường truy vấn **đủ tốt cho live availability**

3. `apps/api/src/room-types/*`
   - room type hiện có `name`, `description`, `basePrice`, `maxGuests`, `amenities`
   - đây là nguồn fact cho tiện ích / thông tin phòng

4. `apps/api/src/rooms/*`
   - có chi tiết phòng + ảnh + roomType + building + booking active

5. Hiện **chưa thấy module dịch vụ riêng** kiểu extra services / add-ons / policy catalog tách biệt.
   - muốn AI trả lời chính xác về “dịch vụ đi kèm”, cần thêm một nguồn chuẩn hóa thay vì nhét bằng prompt.

---

## 3) Học được từ các hệ thống đã làm mạnh

### Intercom Fin
Từ tài liệu về escalation và knowledge management:
- AI không nên cố trả lời mọi thứ; phải có **rule escalate rõ ràng**
- AI mạnh khi knowledge được quản trị như một hệ thống sống: cập nhật theo thay đổi sản phẩm, review hàng tuần, sửa các gap sau các case escalated
- escalations nên dựa trên:
  - khách đòi người thật
  - sentiment xấu / complaint
  - lặp vòng
  - data-driven rules

### Zendesk
Từ định hướng AI agents / service knowledge graph:
- không chỉ là FAQ bot
- phải có 5 lớp: **AI agents + service knowledge + actions/integrations + governance + measurement**
- handoff không chỉ là “chuyển người”; phải đem theo ngữ cảnh + lý do escalated

### Microsoft multi-agent
Từ bài viết về multi-agent intelligence:
- single-agent “biết tuốt” sớm muộn cũng vỡ
- multi-agent hợp lý khi:
  - domain nhiều nhánh
  - tool/data access khác nhau
  - cần đổi model linh hoạt theo nhiệm vụ
- orchestrator nên điều phối agent chuyên nhiệm thay vì nhồi mọi thứ vào một prompt khổng lồ

### Kết luận thực dụng cho `zlsever`
`zlsever` nên đi theo hướng:
- **tool-first, data-first, model-second**
- không đẩy mọi message vào model lớn
- không để LLM tự bịa availability / giá / tiện ích phòng

---

## 4) Kiến trúc đề xuất

```text
Incoming Zalo message
   ↓
Thread automation gate
   ↓
Orchestrator agent
   ├─ Intent classifier agent
   ├─ Flow/policy agent
   ├─ ChiHomeHotel live data agent
   ├─ Internal docs retrieval agent
   ├─ Reply composer agent
   ├─ Verifier / guardrail agent
   └─ Escalation agent
   ↓
Send reply / create human handoff / disable auto for thread
```

### 4.1 Orchestrator agent
Nhiệm vụ:
- hiểu message thuộc loại nào
- quyết định có auto reply không
- gọi agent/tool nào
- chọn model tier nào
- quyết định escalate hay trả lời

Không nên để orchestrator tự trả lời dài; nó chủ yếu là **router + policy brain**.

### 4.2 Intent classifier agent
Dùng model rẻ để phân loại nhanh:
- greeting
- hỏi phòng trống
- hỏi giá / loại phòng
- hỏi tiện ích / dịch vụ
- hỏi check-in/check-out/policy
- booking intent
- complaint
- hỏi nhiều ý cùng lúc
- spam / vô nghĩa

Model tier: **small**

### 4.3 Flow / policy agent
Xử lý các kịch bản nhiều bước:
- lấy thiếu ngày check-in / check-out
- lấy số khách
- hỏi rõ loại phòng / khu vực / ngân sách
- follow flow sale / chốt booking / nhắc thanh toán

Agent này nên chạy theo **state machine + template + slot filling**, không nên để LLM tự ứng biến hoàn toàn.

### 4.4 ChiHomeHotel live data agent
Đây là agent quan trọng nhất cho ChiHome.

Nó **không bịa** mà chỉ đọc dữ liệu thật từ `chihomehotel`:
- phòng trống theo ngày → `GET /reservations/quick-room-search`
- loại phòng / base price / amenities → `GET /room-types`, `GET /room-types/:id`
- chi tiết phòng / ảnh / building → `GET /rooms/:id`, `GET /rooms`
- danh sách toà → `GET /buildings`

Nguyên tắc:
- availability phải là live query
- amenities / room facts lấy từ API chuẩn
- nếu không có dữ liệu chuẩn cho “dịch vụ extra” thì agent phải nói “chưa có nguồn xác minh” và escalate / hỏi thêm, không đoán

### 4.5 Internal docs retrieval agent
Dùng cho:
- quy định nội bộ
- SOP chăm sóc khách
- FAQ đặc thù
- kịch bản xử lý tình huống
- policy hoàn/đổi/checkout sớm/trễ

Nên dùng:
- doc chunk ngắn, có metadata
- ưu tiên exact snippets trước vector search rộng
- mỗi department có knowledge scope riêng

### 4.6 Reply composer agent
Nhiệm vụ:
- viết câu trả lời tự nhiên, gọn, đúng giọng thương hiệu
- chỉ dùng facts đã được live tool hoặc retrieval trả về
- không tự bổ sung fact mới

Model tier:
- simple factual → small
- structured quote / multi-constraint → medium
- complaint / delicate tone → large

### 4.7 Verifier / guardrail agent
Chạy ở các case có rủi ro:
- availability + giá + điều kiện booking
- complaint
- cancellation/refund
- policy nhiều điều kiện

Nó check:
- câu trả lời có dùng fact chưa được grounding không
- có mâu thuẫn với data/tool output không
- có vi phạm guardrail không

### 4.8 Escalation agent
Nếu case khó / rủi ro:
- **không trả lời khách**
- gắn trạng thái escalated
- tắt auto cho thread đó
- đẩy cảnh báo cho admin/nhân viên
- lưu summary: khách hỏi gì, dữ liệu nào đã kiểm, vì sao AI không trả lời

---

## 5) Chính sách bật / tắt theo từng khách

Mỗi thread cần state riêng:

```json
{
  "mode": "off | auto | snoozed | human_only | paused_by_escalation",
  "resumeAt": "ISO datetime | null",
  "reason": "string | null",
  "lastEscalatedAt": "ISO datetime | null",
  "escalationCount": 0,
  "assignedFlowId": "string | null"
}
```

### Hành vi UI đề xuất
Nút ở thread header:
- Tắt
- Bật auto
- Mở lại sau 5 phút
- 10 phút
- 20 phút
- 30 phút
- 60 phút
- số giờ tuỳ chỉnh
- Chuyển người xử lý

Nếu escalated:
- auto chuyển `paused_by_escalation`
- hiện badge đỏ `AI đã dừng – cần người xử lý`

---

## 6) Rule escalation bắt buộc

AI phải dừng và báo người khi gặp một trong các case sau:

1. khách yêu cầu gặp người thật
2. complaint / tức giận / đe doạ bóc phốt / hoàn tiền
3. AI confidence thấp
4. khách hỏi lòng vòng 2–3 lượt mà chưa resolve
5. data sống không truy xuất được
6. không có nguồn fact chuẩn cho câu hỏi
7. chính sách nhạy cảm: refund, discount đặc biệt, ngoại lệ SOP
8. khách VIP / booking giá trị cao / case ưu tiên cao

### Hành động khi escalated
- không gửi trả lời tự động cho khách
- ghi summary cho admin
- tắt auto thread đó
- set assignee / queue theo portal routing nếu cần

---

## 7) Tối ưu token và tối ưu model

Đây là chỗ sống còn.

### 7.1 Không dùng LLM nếu rule đủ xử lý
Ví dụ:
- thread đang `off`
- khách chỉ gửi sticker / icon / spam
- outside business rules → template sẵn

### 7.2 Phân tầng model
- **small**: classify, slot fill, routing, simple rewrite
- **medium**: compose factual multi-field, verify structured output
- **large**: complaint, mơ hồ nhiều nhánh, policy xung đột, fallback

### 7.3 Tool-first trước, compose sau
Case “còn phòng nào từ 22 đến 24/5”:
1. small model parse date
2. gọi `quick-room-search`
3. small/medium model chỉ làm việc **diễn đạt kết quả**

=> token thấp hơn rất nhiều so với nhét catalog vào prompt.

### 7.4 Retrieval rất hẹp
Không đưa cả knowledge base vào context.
Chỉ đưa:
- top snippet liên quan
- policy node liên quan
- latest tool result

### 7.5 Conversation memory dạng summary
Không gửi full chat history 50 tin mỗi lượt.
Nên giữ:
- short rolling summary
- slot state (ngày ở, số khách, ngân sách, loại phòng, tòa)
- unresolved questions

### 7.6 Cache theo thread
- cache room type catalog ngắn hạn
- cache building list
- cache doc retrieval snippets
- cache last parsed intent trong vài phút

### 7.7 Escalate sớm hơn thay vì đốt token vô ích
Nếu confidence thấp hoặc complaint, dừng sớm và giao người.
Đây thường rẻ hơn cố “thông minh” quá mức.

---

## 8) Kiến trúc knowledge cho ChiHome

## 8.1 Live APIs (nguồn sự thật)
- availability → `reservations/quick-room-search`
- room facts → `rooms`, `room-types`, `buildings`

## 8.2 Internal docs
- SOP trả lời khách
- policy checkin/checkout
- rules upsell / discount
- kịch bản sale / follow-up / complaint

## 8.3 Missing source cần bổ sung
Hiện chưa verify thấy module `services/add-ons` riêng trong `chihomehotel`.
Nếu muốn AI trả lời chắc về:
- giặt ủi
- đón sân bay
- thuê xe
- phụ thu thêm người
- dọn phòng ngoài lịch

thì nên thêm ít nhất một trong ba cách:
1. bảng `service_catalog` ở `chihomehotel`
2. API riêng `GET /services`
3. knowledge source nội bộ có schema chặt, không phải prompt text rời rạc

---

## 9) Tích hợp runtime đề xuất trong `zlsever`

## 9.1 Hook xử lý incoming
Điểm móc phù hợp:
- sau `message.created`
- sau `applyPortalRoutingOnIncoming()`
- trước khi broadcast hoàn tất hoặc qua background worker nhẹ

## 9.2 Các service nên thêm
- `src/services/ai-automation-service.js` ✅ đã scaffold bản đầu
- `src/services/chihomehotel-client.js`
- `src/services/knowledge-retrieval-service.js`
- `src/services/llm-router-service.js`
- `src/services/ai-reply-runner.js`
- `src/services/escalation-service.js`

## 9.3 API admin/UI
- `GET /api/ai-automation/config` ✅ scaffold
- `POST /api/ai-automation/config` ✅ scaffold
- `GET /api/threads/automation` ✅ scaffold
- `POST /api/threads/automation` ✅ scaffold
- `POST /api/ai-automation/plan-preview` ✅ scaffold

---

## 10) UX đề xuất

### Khu admin cấu hình AI
Tabs:
1. Tổng quan
2. Kịch bản / Flows
3. Knowledge sources
4. ChiHomeHotel live integration
5. Escalation rules
6. Model routing / cost control
7. Logs / analytics

### Thread-level controls
Ở từng khách:
- trạng thái auto hiện tại
- nút pause/resume nhanh
- lý do dừng gần nhất
- lần escalated gần nhất
- AI summary của thread
- AI draft gần nhất (nếu chạy assistive mode)

### Assistive mode trước, autonomous mode sau
Khuyên rollout theo 3 bước:
1. **Draft only**: AI chỉ gợi ý câu trả lời cho nhân viên
2. **Hybrid auto**: auto cho FAQ/availability/policy rõ ràng, case khó vẫn human
3. **Full auto có guardrail**: chỉ sau khi đo được accuracy/handoff tốt

---

## 11) Đo lường bắt buộc

Các chỉ số nên log:
- auto reply rate
- exact resolution rate
- escalation rate
- false answer rate
- average tokens / conversation
- average tokens / resolved case
- tool success rate
- human override rate
- complaint auto-stop rate

Không đo thì sẽ không biết “thông minh hơn” hay chỉ “tốn tiền hơn”.

---

## 12) Lộ trình triển khai khuyên dùng

### Phase 1 — Foundation
- thread-level on/off/snooze
- config global
- plan preview
- log decision skeleton
- chihomehotel client read-only

### Phase 2 — Draft assistant
- classify intent
- gọi live APIs
- compose draft cho nhân viên duyệt
- đo accuracy

### Phase 3 — Safe auto reply
- auto cho greeting / FAQ / availability / room facts
- escalation auto-stop
- admin alerts

### Phase 4 — Multi-agent đầy đủ
- flow runner
- verifier
- complaint/handoff intelligence
- per-department knowledge routing

### Phase 5 — Optimization
- cache
- token budget
- model auto-selection theo metrics thật
- analytics dashboard

---

## 13) Quyết định kỹ thuật nên chốt sớm

1. model providers nào được phép dùng
2. có dùng OpenRouter để route model rẻ không
3. auth giữa `zlsever` ↔ `chihomehotel` sẽ dùng API key riêng hay service JWT
4. knowledge docs sẽ lưu ở đâu
5. admin alert sẽ đi qua portal activity hay kênh message riêng

---

## 14) Artifact đã tạo trong repo

- `src/services/ai-automation-service.js`
  - normalize config
  - normalize thread automation state
  - thread patching
  - plan preview
  - escalation heuristics
  - model tier selection
  - specialist-agent planning

- `src/server.js`
  - API config AI
  - API thread automation
  - API plan preview

- `src/lib/store.js`
  - state mặc định cho `aiAutomation`

---

## 15) Nguồn tham khảo bên ngoài đã dùng để chắt lọc

- Intercom Fin escalation guidance  
  https://www.intercom.com/help/en/articles/12396892-manage-fin-ai-agent-s-escalation-guidance-and-rules
- Intercom knowledge management for AI support  
  https://www.intercom.com/help/en/articles/11782981-mastering-knowledge-management-for-great-ai-support
- Microsoft: Designing Multi-Agent Intelligence  
  https://developer.microsoft.com/blog/designing-multi-agent-intelligence
- Zendesk AI agent / resolution platform direction  
  https://www.zendesk.com/blog/zendesk-insights/innovation/relate-2025-resolution-platform-ai-agents/

---

## 16) Kết luận ngắn

Nếu làm đúng, hệ này không nên là “1 con bot trả lời chung chung”, mà là:
- **1 bộ điều phối**
- dùng **nhiều agent nhỏ chuyên việc**
- ưu tiên **tool thật + data thật**
- chỉ gọi model mạnh khi thật sự cần
- biết **dừng đúng lúc** và nhường người thật

Đó mới là cách để vừa thông minh hơn, vừa chính xác hơn, vừa đỡ đốt token.
