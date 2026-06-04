export const API_URL = 'http://localhost:3000/api/';
export const SITE_ORIGIN = API_URL.replace(/\/api\/?$/, '');

export function getApiEndpoint(path) {
  return `${API_URL}${path}`;
}

export function getSiteUrl(path = '') {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${SITE_ORIGIN}${normalizedPath}`;
}
