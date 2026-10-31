// サイトのログイン状態。本物は Auth.js（Google）のセッション Cookie。モックは利用者を選ぶだけ。
export const SESSION_COOKIE = 'mock_session';

export function sessionCookie(sessionId) {
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
