/** Explicit POST queries retain read permissions without granting mutation privileges. */
export function isAdminPostQuery(pathname: string, method: string): boolean {
  return method.toUpperCase() === 'POST' && ['/api/v1/admin/accounts/today-stats/batch', '/api/v1/admin/accounts/check-mixed-channel'].includes(pathname)
}
