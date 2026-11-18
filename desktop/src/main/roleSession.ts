/** Saving browser storage is not proof of login. Reject known unauthenticated pages. */
export function validateRoleSessionLocation(url: string, baseUrl: string, loginUrl?: string, loginFormVisible = false): void {
  const current = new URL(url), base = new URL(baseUrl);
  const login = loginUrl ? new URL(loginUrl, base) : undefined;
  const onLogin = login ? current.pathname === login.pathname && current.hash === login.hash
    : /(?:^|[\/#])(?:login|signin|sign-in)(?:[\/?#]|$)/i.test(current.pathname + current.hash);
  if (current.origin !== base.origin || onLogin || loginFormVisible) {
    throw new Error('AUTH_REQUIRED: 当前页面尚未完成登录，请登录成功后再保存角色会话');
  }
}
