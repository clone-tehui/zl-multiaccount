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

## Binary multipart (additive)

`POST /api/compat/manager` accepts `multipart/form-data` as well as the unchanged JSON contract. The session-authenticated `/get/post` alias also accepts multipart; its existing authentication rules are unchanged (do not assume token auth for that alias).

```sh
curl --fail-with-body 'https://<ZALO_SERVER>/api/compat/manager' \
  -H 'Authorization: Bearer <COMPAT_API_TOKEN>' \
  -F 'operation=send_message' \
  -F 'credential_id=<ACCOUNT_ID>' \
  -F 'conversationId=<THREAD_ID>' \
  -F 'content=Optional text' \
  -F 'files=@/absolute/path/photo.png;type=image/png' \
  -F 'files=@/absolute/path/document.pdf;type=application/pdf'
```

Do not set `Content-Type` manually: curl/n8n must supply the multipart boundary. Existing cookie authentication or `x-compat-api-key` may be used instead of Bearer. An account conflicting with the request header/query or other account aliases is rejected; JSON requests and existing legacy fields continue through the original path.

In n8n HTTP Request: POST, URL above, Send Body enabled, Body Content Type **Form-Data**. Add ordinary **Form Data** parameters `operation=send_message`, `credential_id=<ACCOUNT_ID>`, `conversationId=<THREAD_ID>`, and optional `content`. Add parameter type **n8n Binary File**, **Name** `files`, **Input Data Field Name** `data` (or the actual upstream binary property, e.g. `document`). For multiple files add more Binary File parameters with the same Name `files` and the appropriate distinct binary properties. Upstream binary metadata should include `fileName` and `mimeType`; absent MIME falls back to `application/octet-stream`. No base64 expression or JSON conversion is required. This is a setup guide, not a change to any live n8n workflow.

App limits: **60 MiB total wire body**, **25 MiB per binary file**, **10 files**, **40 text fields**, **64 KiB per text field** (MiB = 1,048,576 bytes). Duplicate text fields, invalid boundaries, empty files, unknown binary fields or missing filenames are rejected (400); limit violations return 413. Multipart requires `send_message`/`sendMessage` and a conversation identifier; filenames are basename-only, ASCII-sanitized and limited to 180 characters. MIME is caller metadata, not content validation; zca-js determines upload type/metadata itself from file extension/content. Proxy limits may be lower: the repository nginx example specifies **30 MiB total**, and no proxy config is changed by this feature.

Binary uploads are parsed with bounded memory, then written to unique private temp directories with safe original basenames so zca-js sees the correct extension/name. Temp files, ownership sidecars and directories are removed on completion/failure; aborted parsing creates no files. No permanent upload URL is promised. Provider uploads/sends are awaited before cleanup. An HTTP disconnect after provider execution starts cannot cancel or undo an already-started external send.

Regression: `node --test test/compat-multipart.test.mjs`; provider calls are replaced by a synthetic spy and all URL fixtures are local. No real Zalo sends or live upload smoke tests are performed.
