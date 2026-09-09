# Zalo User Server – n8n / codedao12 compatibility

## Mục tiêu
Server cung cấp lớp tương thích gần với các node Zalo User kiểu `codedao12` / `n8n-nodes-ultimate`, đồng thời giữ UI chat web hiện có.

## API docs runtime
- `GET /api/docs/compat`
- Trả về các field chính:
  - `credentials`: `nameAccount`, `userId`, `phoneNumber`, `cookie`, `imei`, `userAgent`, `proxy`, `supportCode`, `licenseKey`
  - `managerRequestFields`: `conversationId`, `content`, `type`, `replyTo`, `senderId`, `accountType`, `attachmentsUrls`, `base64Attachments`
  - `managerTransportFields`: `conversation_id`, `sender_id`, `sender_type`, `reply_to`, `chat_id`, `credential_id`, `operation`, `last_message`, `last_message_type`, `last_message_time`
  - `supportedOperations`: `send_message`, `send_sticker`, `send_typing`, `send_friend_request`, `change_alias`, `change_group_name`

## Webhook n8n
Cấu hình trong UI hoặc qua API:
- `POST /api/integration/config`
- body:
```json
{
  "webhookUrl": "https://n8n.example/webhook/...",
  "webhookSecret": "optional-secret",
  "enabled": true
}
```

Nếu có `webhookSecret`, server gửi header:
- `x-bot-api-secret-token: <secret>`

### Event payload
- Message:
```json
{
  "messageData": {"...": "raw realtime payload"},
  "account": {"id": "...", "displayName": "..."},
  "account_id": "...",
  "account_name": "...",
  "zalo_name": "..."
}
```

- Friend event:
```json
{
  "friendEvent": {"...": "raw realtime payload"},
  "account": {"id": "...", "displayName": "..."},
  "account_id": "...",
  "account_name": "...",
  "zalo_name": "..."
}
```

- Event khác (`reaction`, `typing`, `undo`, `group_event`) dùng wrapper:
```json
{
  "eventName": "reaction",
  "data": {"...": "raw realtime payload"},
  "account": {"id": "...", "displayName": "..."},
  "account_id": "...",
  "account_name": "...",
  "zalo_name": "..."
}
```

## Multi-account
- Mỗi account lưu credentials riêng dưới `data/accounts/<accountId>/credentials.json`
- API:
  - `GET /api/accounts`
  - `POST /api/accounts/select`
- UI có dropdown chọn account và nút thêm account bằng QR.

## Compatibility action endpoint
- `POST /api/compat/manager`
- alias: `POST /get/post`

### Ví dụ gửi text/html
```json
{
  "operation": "send_message",
  "conversationId": "123456789",
  "content": "<p>Hello<br>world</p>",
  "type": 0
}
```
HTML cơ bản sẽ được normalize về text trước khi gửi.

### Ví dụ gửi file
```json
{
  "operation": "send_message",
  "conversationId": "123456789",
  "attachmentsUrls": "https://example.com/a.jpg,https://example.com/b.pdf"
}
```

### Ví dụ gửi sticker
```json
{
  "operation": "send_sticker",
  "conversationId": "123456789",
  "sticker": {
    "id": "23338",
    "cateId": "12736",
    "type": "gif"
  }
}
```

### Ví dụ typing
```json
{
  "operation": "send_typing",
  "conversationId": "123456789",
  "type": 0,
  "typing": true
}
```

## Ghi chú
- Các giá trị auto delete hiện giữ nguyên hệ đang dùng: `86400000`, `604800000`, `1209600000`.
- `credential_id` hiện được dành cho routing account ở lớp compatibility; nên map nó với `accountId` phía server.
- Với payload realtime, server ưu tiên đẩy raw event sang n8n thay vì rút gọn quá mức.
