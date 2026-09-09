export function canAccessDepartment(principal, departmentId) {
  if (!departmentId) return true;
  if ((principal?.permissions || []).includes('*') || (principal?.roles || []).includes('admin')) return true;
  return Array.isArray(principal?.departmentIds) && principal.departmentIds.map(String).includes(String(departmentId));
}

export function assertDepartmentAccess(principal, departmentId) {
  if (!canAccessDepartment(principal, departmentId)) {
    const error = new Error('Forbidden: không thuộc bộ phận được phép');
    error.statusCode = 403;
    throw error;
  }
}

export function scopeLauncherApps(principal) {
  const apps = [];
  if (!principal) return apps;
  apps.push({
    id: 'zalo-user',
    name: 'Zalo User Workspace',
    url: 'https://zl.tehui.io.vn',
    icon: '💬'
  });
  if ((principal.roles || []).includes('admin') || (principal.roles || []).includes('manager')) {
    apps.push({
      id: 'ops-dashboard',
      name: 'Ops Dashboard',
      url: 'https://portal.tehui.io.vn/#ops',
      icon: '📊'
    });
  }
  return apps;
}
