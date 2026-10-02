# Zalo User Server

Self-hosted Zalo personal multi-account server dùng `zca-js`.

## Trạng thái

Có 2 provider:

- `mock`
- `zalo-web` — QR login, reconnect credentials, realtime listener, nhận/gửi text/media cơ bản.

Mặc định dùng `PROVIDER=zalo-web`.

## Chatbot bridge sang int-chat

Repo này là **channel transport cho Zalo cá nhân**. AI/chatbot brain không nằm ở đây.

```text
Zalo cá nhân
   ↓
zca-js api.listener.on("message")
   ↓
ZaloWebProvider
   ↓
POST int-chat /webhooks/zalo
   ↓
ChiHome chatbot
   ↓
POST zl-multiaccount /api/chatbot/send
   ↓
ZaloWebProvider.sendMessage()
   ↓
zca-js api.sendMessage()
   ↓
Zalo cá nhân
```

Điểm quan trọng:

- reuse listener `zca-js` đang chạy; **không mở listener Zalo thứ hai**;
- chỉ forward inbound message, bỏ `isOutgoing/self` để chống loop;
- mặc định bỏ group;
- có thể giới hạn account nào được nối chatbot;
- account đã bật dedicated bridge sẽ không chạy AI automation cũ của repo này để tránh 2 bot cùng trả lời;
- outbound chatbot chỉ được gửi qua account nằm trong bridge allowlist.

## Bridge env

```text
CHATBOT_WEBHOOK_URL=http://localhost:4100/webhooks/zalo
CHATBOT_BRIDGE_SECRET=change-me-zalo-bridge

# Empty = tất cả account đã login; hoặc comma-separated Zalo account IDs.
CHATBOT_BRIDGE_ACCOUNT_IDS=

CHATBOT_BRIDGE_ALLOW_GROUPS=false
CHATBOT_BRIDGE_TIMEOUT_MS=8000
```

Shared secret phải trùng với:

```text
int-chat ZALO_BRIDGE_SECRET
```

## Dedicated chatbot send endpoint

```text
POST /api/chatbot/send
x-chatbot-bridge-secret: <CHATBOT_BRIDGE_SECRET>
```

Body:

```json
{
  "accountId": "ZALO_ACCOUNT_ID",
  "threadId": "ZALO_THREAD_ID",
  "text": "Nội dung bot trả lời"
}
```

Endpoint này gọi existing:

```text
provider.sendMessage()
→ ZaloWebProvider.sendMessage()
→ api.sendMessage(message, threadId, ThreadType.User/Group)
```

## Chạy local

```bash
cp .env.example .env
node src/server.js
```

Mở: `http://localhost:4310`

## Docker

```bash
docker compose up -d --build
```

## API chính

- `GET /api/health`
- `GET /api/state`
- `GET /api/events` (SSE)
- `POST /api/sessions/qr/start`
- `POST /api/messages/send`
- `POST /api/chatbot/send`

## Test

```bash
npm run check
npm run test:chatbot-bridge
```

## Lưu ý Zalo

`zca-js` là **unofficial Zalo Web API**. Có rủi ro logout/chặn phiên/khóa account. Không dùng cơ chế né phát hiện; hạn chế spam và automation quá mức.

Theo contract của `zca-js`, listener realtime chạy bằng:

```text
api.listener.on("message", ...)
api.listener.start()
```

và gửi message bằng:

```text
api.sendMessage(..., threadId, ThreadType.User/Group)
```

Chỉ một Zalo Web listener nên không mở Zalo Web browser song song với listener production nếu điều đó làm session listener bị dừng.
