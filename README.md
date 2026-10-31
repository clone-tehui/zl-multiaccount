# Zalo User Server

Bản scaffold đầu cho server Zalo cá nhân self-hosted theo mô hình multi-operator inbox.

## Mục tiêu của bản này

- Web app dễ dùng cho nhiều máy cùng truy cập
- Danh sách hội thoại sắp theo tin mới nhất
- Hiện avatar, user, group, người lạ, tin nhắn
- Đồng bộ realtime trong nội bộ server qua SSE
- Có lớp `provider` để mở rộng tiếp cho media, notes, assignment
- Có luồng QR login/session state chạy được

## Trạng thái hiện tại

Hiện có 2 provider:

- `mock`: chạy demo/local ngay, không cần phụ thuộc ngoài
- `zalo-web`: adapter thật mức cơ bản bằng `zca-js` cho QR login, reconnect từ credentials đã lưu, load bạn bè/nhóm cơ bản, nhận/gửi text realtime

Mặc định `.env.example` và Docker dùng `PROVIDER=zalo-web`.

## Chạy local

```bash
cd zalo-user-server
cp .env.example .env
node src/server.js
```

Mở: `http://localhost:4310`

## Docker

```bash
cd zalo-user-server
docker compose up -d --build
```

## API chính

- `GET /api/health`
- `GET /api/state`
- `GET /api/events` (SSE)
- `POST /api/sessions/qr/start`
- `POST /api/sessions/qr/confirm` (chỉ dùng cho mock)
- `POST /api/messages/send`

## Lưu ý quan trọng

- Adapter `zalo-web` là **unofficial** nên có rủi ro logout, chặn phiên, hoặc khóa tài khoản.
- Mình **không thêm cơ chế né phát hiện / né quét / né ban**. Hướng an toàn hơn là giảm automation, giữ thao tác giống người dùng bình thường, hạn chế spam, rate limit chặt, và ưu tiên review tay cho hành động nhạy cảm.

## Cấu trúc

```text
zalo-user-server/
  public/                # UI tĩnh
  src/
    lib/store.js         # lưu state JSON
    providers/
      mock-provider.js   # provider demo
      zalo-web-provider.js
    server.js            # HTTP + API + SSE
  data/                  # state/runtime
```
