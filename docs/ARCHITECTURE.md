# Kiến trúc MVP

## 1. Mô hình tổng thể

```text
Browser nhân viên
   ↕
Web UI / SSE / REST
   ↕
Zalo User Server
   ↕
Provider Adapter (mock / zalo-web)
   ↕
Zalo Web session
```

## 2. Thành phần

### UI
- Sidebar hội thoại
- Panel tin nhắn
- Composer
- Khu vực trạng thái đăng nhập QR/session

### Server
- Lưu state hội thoại
- Broadcast realtime cho nhiều client
- Nhận/gửi tin qua provider
- Giữ metadata contact/thread

### Provider
- `startQrLogin()`
- `confirmQrLogin()`
- `sendMessage()`
- `hydrateInitialState()`
- `attachRealtime()`

## 3. Đồng bộ realtime

- Server giữ state chuẩn
- Mỗi khi có event mới → persist state → broadcast SSE
- UI nhận patch và render lại, đồng thời re-sort sidebar theo `lastMessageAt`

## 4. Hướng phát triển kế tiếp

1. Thay `mock-provider` bằng adapter Zalo Web thật
2. Thêm upload file/media pipeline
3. Thêm auth nội bộ cho nhân viên
4. Thêm assignment / tag / note / unread per operator
5. Thêm snapshot recovery sau reconnect

## 5. Nguyên tắc giảm rủi ro vận hành

- Không gửi hàng loạt tốc độ cao
- Giới hạn tần suất gửi trên mỗi thread/account
- Không tự động click/chạy hành vi bất thường liên tục
- Bắt buộc manual reconnect khi session bất thường
- Log đầy đủ để phát hiện lỗi sớm

Đây là hướng giảm rủi ro kỹ thuật; không phải cam kết tránh phát hiện hay tránh chế tài từ nền tảng.
