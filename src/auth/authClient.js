export const BASE_ORIGIN = 'https://app.example.com';
export const SESSION_URL = `${BASE_ORIGIN}/api/auth/session`;
export const DONE_URL = `${BASE_ORIGIN}/ext-auth/done`;

export function getLoginUrl() {
  const callbackUrl = encodeURIComponent(DONE_URL);
  return `${BASE_ORIGIN}/api/auth/signin/google?callbackUrl=${callbackUrl}`;
}

export async function fetchSession() {
  const response = await fetch(SESSION_URL, {
    method: 'GET',
    credentials: 'include'
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export function isLoggedIn(session) {
  return Boolean(session?.user?.id);
}
