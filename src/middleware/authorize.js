export const DEFAULT_ROLE_PERMISSIONS = {
  admin: ['*'],
  manager: [
    'portal.apps.read',
    'portal.users.read',
    'portal.users.write',
    'portal.departments.read',
    'portal.departments.write',
    'portal.departments.assign_staff',
    'channels.read',
    'channels.manage',
    'channels.members.read',
    'conversations.read_department',
    'conversations.assign',
    'conversations.transfer',
    'conversations.reply',
    'presence.force_offline',
    'presence.read'
  ],
  staff: [
    'portal.apps.read',
    'channels.read_assigned',
    'conversations.read_assigned',
    'conversations.reply',
    'conversations.transfer_same_department',
    'presence.self_update'
  ]
};

export const CONFIGURABLE_PERMISSIONS = [
  { key: 'portal.apps.read', label: 'Xem bảng quản trị / tiện ích', group: 'Giao diện' },
  { key: 'portal.users.read', label: 'Xem danh sách user', group: 'User' },
  { key: 'portal.users.write', label: 'Tạo / sửa user', group: 'User' },
  { key: 'portal.departments.read', label: 'Xem bộ phận', group: 'Bộ phận' },
  { key: 'portal.departments.write', label: 'Tạo / sửa bộ phận', group: 'Bộ phận' },
  { key: 'channels.read', label: 'Xem danh sách account Zalo', group: 'Account Zalo' },
  { key: 'channels.read_assigned', label: 'Chỉ xem account được cấp', group: 'Account Zalo' },
  { key: 'channels.manage', label: 'Cấp account cho bộ phận / user', group: 'Account Zalo' },
  { key: 'channels.members.read', label: 'Xem thành viên được cấp account', group: 'Account Zalo' },
  { key: 'conversations.read_department', label: 'Xem hội thoại của bộ phận', group: 'Hội thoại' },
  { key: 'conversations.read_assigned', label: 'Chỉ xem hội thoại được giao', group: 'Hội thoại' },
  { key: 'conversations.assign', label: 'Phân công hội thoại', group: 'Hội thoại' },
  { key: 'conversations.transfer', label: 'Chuyển hội thoại', group: 'Hội thoại' },
  { key: 'conversations.transfer_same_department', label: 'Chuyển hội thoại trong cùng bộ phận', group: 'Hội thoại' },
  { key: 'conversations.reply', label: 'Trả lời tin nhắn', group: 'Hội thoại' },
  { key: 'presence.read', label: 'Xem trạng thái online/offline', group: 'Trạng thái' },
  { key: 'presence.force_offline', label: 'Ép trạng thái nhân sự', group: 'Trạng thái' },
  { key: 'presence.self_update', label: 'Tự đổi trạng thái cá nhân', group: 'Trạng thái' }
];

let rolePermissionsOverride = {};

export function setRolePermissionsOverride(nextValue) {
  rolePermissionsOverride = sanitizeRolePermissionsOverride(nextValue);
}

export function getRolePermissions() {
  return {
    admin: ['*'],
    manager: rolePermissionsOverride.manager?.length ? [...rolePermissionsOverride.manager] : [...DEFAULT_ROLE_PERMISSIONS.manager],
    staff: rolePermissionsOverride.staff?.length ? [...rolePermissionsOverride.staff] : [...DEFAULT_ROLE_PERMISSIONS.staff]
  };
}

export function buildPermissionSet(principal) {
  const rolePermissions = getRolePermissions();
  const out = new Set(Array.isArray(principal?.permissions) ? principal.permissions : []);
  for (const role of Array.isArray(principal?.roles) ? principal.roles : []) {
    for (const permission of rolePermissions[role] || []) out.add(permission);
  }
  return out;
}

export function hasPermission(principal, permission) {
  const set = buildPermissionSet(principal);
  return set.has('*') || set.has(permission);
}

export function requirePermission(principal, permission) {
  if (!principal) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
  if (!hasPermission(principal, permission)) {
    const error = new Error(`Forbidden: thiếu quyền ${permission}`);
    error.statusCode = 403;
    throw error;
  }
  return principal;
}

export function requireAnyPermission(principal, permissions = []) {
  if (!principal) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
  if ((permissions || []).some((permission) => hasPermission(principal, permission))) return principal;
  const error = new Error(`Forbidden: thiếu một trong các quyền ${permissions.join(', ')}`);
  error.statusCode = 403;
  throw error;
}

export function requireAdminAccess(principal) {
  if (!principal) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
  if (!hasPermission(principal, '*') && !(Array.isArray(principal.roles) && principal.roles.includes('admin'))) {
    const error = new Error('Forbidden: chỉ admin được thực hiện thao tác này');
    error.statusCode = 403;
    throw error;
  }
  return principal;
}

function sanitizeRolePermissionsOverride(nextValue) {
  const allowed = new Set(CONFIGURABLE_PERMISSIONS.map((item) => item.key));
  const normalize = (items, fallback) => {
    const list = Array.isArray(items) ? items.map(String).filter((item) => allowed.has(item)) : fallback;
    return [...new Set(list)];
  };
  return {
    manager: normalize(nextValue?.manager, DEFAULT_ROLE_PERMISSIONS.manager),
    staff: normalize(nextValue?.staff, DEFAULT_ROLE_PERMISSIONS.staff)
  };
}
