import { BinBankCard } from 'zca-js';

export const LATEST_ZALO_FEATURES = [
  { id: 'getListBank', label: 'Danh sách ngân hàng', manage: true },
  { id: 'getListBankAccount', label: 'Tài khoản ngân hàng đã lưu', manage: true },
  { id: 'createBankAccount', label: 'Thêm thông tin ngân hàng', manage: true },
  { id: 'updateBankAccount', label: 'Sửa thông tin ngân hàng', manage: true },
  { id: 'deleteBankAccount', label: 'Xóa thông tin ngân hàng', manage: true },
  { id: 'getListDevice', label: 'Thiết bị liên kết', manage: true },
  { id: 'registerCatalog', label: 'Đăng ký danh mục sản phẩm', manage: true },
  { id: 'scanURL', label: 'Kiểm tra liên kết', manage: false },
  { id: 'lostFocus', label: 'Báo trạng thái rời ứng dụng', manage: false }
];

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`${label} không hợp lệ.`);
  return number;
}

function bankPayload(payload) {
  const binBank = integer(payload.binBank, 'Ngân hàng', 1);
  if (!Object.values(BinBankCard).includes(binBank)) throw new Error('Ngân hàng chưa được phiên bản Zalo này hỗ trợ.');
  const numAccBank = String(payload.numAccBank || '').trim();
  const nameAccBank = String(payload.nameAccBank || '').trim();
  if (!/^[\dA-Za-z]{4,40}$/.test(numAccBank)) throw new Error('Số tài khoản phải có 4–40 ký tự chữ hoặc số.');
  if (!nameAccBank || nameAccBank.length > 100) throw new Error('Nhập tên chủ tài khoản, tối đa 100 ký tự.');
  return { binBank, numAccBank, nameAccBank };
}

export async function executeLatestZaloFeature(api, operation, payload = {}) {
  const feature = LATEST_ZALO_FEATURES.find((item) => item.id === operation);
  if (!feature) throw new Error('Tính năng không hợp lệ.');
  if (!api || typeof api[operation] !== 'function') {
    const error = new Error('Account chưa kết nối hoặc Zalo chưa hỗ trợ tính năng này.');
    error.statusCode = 409;
    throw error;
  }
  switch (operation) {
    case 'getListBank': return api.getListBank();
    case 'getListBankAccount': return api.getListBankAccount(integer(payload.page ?? 0, 'Trang', 0, 10000), integer(payload.limit ?? 20, 'Số mục', 1, 50));
    case 'createBankAccount': return api.createBankAccount(bankPayload(payload));
    case 'updateBankAccount': return api.updateBankAccount({ ...bankPayload(payload), accountId: integer(payload.accountId, 'Mã thông tin ngân hàng', 1) });
    case 'deleteBankAccount':
      if (typeof payload.isDefault !== 'boolean') throw new Error('Thiếu trạng thái mặc định của thông tin ngân hàng.');
      return api.deleteBankAccount({ accountId: integer(payload.accountId, 'Mã thông tin ngân hàng', 1), isDefault: payload.isDefault });
    case 'registerCatalog':
      if (typeof payload.enabled !== 'boolean') throw new Error('Chọn bật hoặc tắt danh mục sản phẩm.');
      await api.registerCatalog(payload.enabled);
      return { enabled: payload.enabled };
    case 'lostFocus': return api.lostFocus();
    case 'scanURL': {
      const value = String(payload.url || '').trim();
      let url;
      try { url = new URL(value); } catch { throw new Error('Nhập liên kết HTTP hoặc HTTPS hợp lệ.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 4096) throw new Error('Liên kết không hợp lệ hoặc có chứa thông tin đăng nhập.');
      const result = await api.scanURL(url.href);
      if (typeof result?.isSafe !== 'boolean') throw new Error('Zalo chưa trả về kết quả kiểm tra liên kết hợp lệ.');
      return { isSafe: result.isSafe };
    }
    case 'getListDevice': {
      const result = await api.getListDevice();
      const devices = result?.devices;
      if (!devices || typeof devices !== 'object') throw new Error('Zalo chưa trả về danh sách thiết bị hợp lệ.');
      return {
        primaryDevicePresent: Boolean(devices.masterId),
        lastUpdatedAt: Number(devices.lastUpdateTs || 0),
        companions: (Array.isArray(devices.companions) ? devices.companions : []).map((device) => ({
          name: String(device?.deviceName || device?.name || device?.displayName || 'Thiết bị không có tên').slice(0, 100),
          type: String(device?.deviceType || device?.type || '').slice(0, 50),
          lastUpdatedAt: Number(device?.lastUpdateTs || device?.lastLoginTime || 0)
        }))
      };
    }
  }
}
