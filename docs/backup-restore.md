# Backup / Restore / Domain cho `zalo-user-server`

## Mục tiêu
Giữ nguyên:
- UI web hiện tại trong `public/`
- logic API / state / SSE / compatibility trong `src/`
- dữ liệu đăng nhập + state multi-account trong `data/`

Để sau này nếu Zalo đổi cách login, mình chỉ thay lớp adapter/provider, còn UI + API + logic vận hành vẫn giữ nguyên.

---

## 1) Rủi ro thực tế khi chạy 10 account Zalo

### Có rủi ro không?
Có.

Vì `zalo-user-server` hiện dùng `zca-js`, tức là **adapter unofficial**. Nên các rủi ro thật gồm:
- Zalo đổi API/webflow → session hỏng hoặc login lại
- account bị logout bất ngờ
- rate limit / chặn tạm thời một số hành động
- account bị review nếu có hành vi giống spam hoặc automation quá mức
- thay đổi fingerprint / môi trường login làm session chết

### Có dùng ổn định cho cỡ 10 acc được không?
**Có thể dùng được, nhưng không nên hứa “an toàn tuyệt đối”.**

Thực tế ổn định hay không phụ thuộc nhiều vào:
- mức độ automation của từng acc
- tần suất gửi tin / reaction / kết bạn / đổi trạng thái
- việc có giữ session ổn định hay không
- IP / môi trường chạy có thay đổi liên tục không

### Khuyến nghị thực tế để giảm rủi ro
Không có cách “chống ban tuyệt đối”, nhưng nên làm như sau:

1. **Mỗi account giữ 1 session bền, không login/logout liên tục**
   - tránh xoá credentials bừa bãi
   - tránh đổi môi trường chạy liên tục

2. **Không spam hàng loạt**
   - không bắn cùng một nội dung cho quá nhiều người trong thời gian ngắn
   - không dùng account mới để gửi nhiều hành động ngay

3. **Ưu tiên account có lịch sử dùng thật**
   - acc đã có tương tác thật thường ổn hơn acc trắng

4. **Không chạy nhiều hành động nhạy cảm cùng lúc trên 10 acc**
   - kết bạn hàng loạt
   - gửi link hàng loạt
   - nhắn tin quá dày
   - đổi trạng thái hàng loạt

5. **Giữ IP / máy chủ ổn định**
   - đừng đổi server liên tục
   - đừng đổi quốc gia/IP bất thường

6. **Tách lỗi từng account**
   - 1 acc lỗi không được làm crash cả cụm
   - nên coi mỗi account là một session độc lập trong cùng app

7. **Có backup dữ liệu / credentials hằng ngày**
   - nếu session chết còn dựng lại nhanh

8. **Theo dõi log và có ngưỡng an toàn vận hành**
   - nếu một acc bị logout/reconnect lặp bất thường thì dừng automation acc đó trước

### Mức độ mình đánh giá hiện tại
- **Phù hợp để self-host nội bộ và vận hành có kiểm soát**
- **Không nên xem là nền tảng “zero-risk” để scale spam**
- Với 10 acc, nên đi theo hướng:
  - gửi có kiểm soát
  - không burst mạnh
  - backup tốt
  - giữ nguyên UI/logic, chỉ thay adapter khi Zalo đổi

---

## 2) Nguyên tắc kiến trúc để sau này Zalo đổi login vẫn giữ nguyên UI/logic

Giữ cố định các lớp sau:
- `public/` → toàn bộ giao diện
- `src/server.js` → contract HTTP / SSE / compat endpoint
- `src/lib/store.js` → state model / view model

Chỉ thay đổi chủ yếu ở:
- `src/providers/zalo-web-provider.js`
- hoặc tạo provider mới cùng interface

Nói ngắn gọn:
- **UI không phụ thuộc trực tiếp vào cách login của Zalo**
- **logic app không nên phụ thuộc vào chi tiết webflow của Zalo**
- nếu mai Zalo đổi QR/login/API, mình chỉ cần thay lớp provider/adaptor

---

## 3) File nào phải backup

### Bắt buộc
- `.env`
- `docker-compose.yml`
- `Dockerfile`
- `package.json`
- `package-lock.json`
- `public/`
- `src/`
- `data/`
- `docs/`
- `deploy/`
- `scripts/`

### Đặc biệt quan trọng
Trong `data/` có:
- `data/state.json`
- `data/accounts/<accountId>/credentials.json`

Đây là phần quyết định khả năng dựng lại nhanh các account.

---

## 4) Cách tạo backup nhanh

### Script có sẵn
```bash
cd /Users/ctm/Documents/zalo-user-server
./scripts/backup.sh
```

Script sẽ tạo file dạng:
```bash
~/.openclaw/workspace/backups/zalo-user-server-backup-YYYYMMDD-HHMMSS.tar.gz
```

Và mặc định sẽ:
- tạo **1 bản backup mới nhất**
- **xoá các bản backup cũ hơn** cùng mẫu tên trong thư mục backup

---

## 5) Cách restore lên Docker

### Bước 1: copy file backup sang máy mới
Ví dụ file:
```bash
zalo-user-server-backup-YYYYMMDD-HHMMSS.tar.gz
```

### Bước 2: giải nén
```bash
mkdir -p /opt/zalo-user-server
cd /opt/zalo-user-server

tar -xzf /path/to/zalo-user-server-backup-YYYYMMDD-HHMMSS.tar.gz --strip-components=1
```

### Bước 3: kiểm tra `.env`
Đảm bảo tối thiểu:
```env
PORT=4310
DATA_DIR=/data
APP_ORIGIN=https://zl.tehui.io.vn
PROVIDER=zalo-web
SESSION_SECRET=...giữ nguyên nếu muốn giữ session web app...
APP_USERNAME=...
APP_PASSWORD=...
```

### Bước 4: dựng Docker
```bash
cd /opt/zalo-user-server
docker compose up -d --build
```

### Bước 5: kiểm tra
```bash
curl http://127.0.0.1:4310/api/health
curl http://127.0.0.1:4310/api/version
```

---

## 6) Trỏ domain `zl.tehui.io.vn`

## Yêu cầu
DNS của `zl.tehui.io.vn` phải trỏ A record về IP máy chủ đang chạy Docker.

Ví dụ:
- `zl.tehui.io.vn` → `YOUR_SERVER_IP`

## Reverse proxy Nginx
Dùng file:
- `deploy/nginx.zl.tehui.io.vn.conf`

Cài vào máy chủ Nginx:
```bash
sudo cp deploy/nginx.zl.tehui.io.vn.conf /etc/nginx/sites-available/zl.tehui.io.vn
sudo ln -sf /etc/nginx/sites-available/zl.tehui.io.vn /etc/nginx/sites-enabled/zl.tehui.io.vn
sudo nginx -t
sudo systemctl reload nginx
```

Nếu dùng cert Let’s Encrypt:
```bash
sudo certbot --nginx -d zl.tehui.io.vn
```

Sau đó web public sẽ đi vào:
- `https://zl.tehui.io.vn`

và reverse proxy về:
- `http://127.0.0.1:4310`

---

## 7) Khi cần chuyển server mà vẫn muốn “bật lên chạy ngay”

Checklist tối thiểu:
1. copy file backup `.tar.gz`
2. restore ra thư mục mới
3. đảm bảo DNS domain trỏ về server mới
4. cài Docker + Docker Compose
5. `docker compose up -d --build`
6. kiểm tra `api/health`
7. mở web và xác nhận account/session còn hoạt động

---

## 8) Điều gì KHÔNG đảm bảo dù đã backup

Backup giúp:
- dựng lại code/UI/logic/data rất nhanh
- giữ state nội bộ và credentials đã lưu

Nhưng backup **không đảm bảo**:
- Zalo vẫn chấp nhận session cũ mãi mãi
- Zalo không đổi cơ chế login
- server mới/IP mới không làm session bị yêu cầu xác thực lại

Cho nên hướng đúng là:
- backup đầy đủ
- giữ giao diện/logic ổn định
- chừa chỗ để thay provider/login adapter sau này

---

## 9) Khuyến nghị vận hành lâu dài

Nếu Tehui muốn dùng ổn định cho ~10 acc, mình khuyên nên làm thêm sau bước backup này:
- cron backup hằng ngày cho thư mục backup
- healthcheck + alert nếu container restart bất thường
- theo dõi số lần login lại của từng account
- giới hạn tốc độ action theo account
- tách config/account state rõ ràng hơn nữa nếu sau này scale tiếp
