/**
 * @typedef {Object} CookieOptions
 * @property {string} [path]
 * @property {number} [maxAge]
 * @property {string | Date} [expires]
 * @property {string} [sameSite]
 * @property {boolean} [secure]
 */

/**
 * @param {string} name
 * @param {string} value
 * @param {CookieOptions} [options]
 */
export function setCookie(name, value, options = {}) {
  const parts = [`${name}=${value}`];

  if (options.path) {
    parts.push(`path=${options.path}`);
  }
  if (typeof options.maxAge === "number") {
    parts.push(`max-age=${options.maxAge}`);
  }
  if (options.expires) {
    const expiresValue = options.expires instanceof Date
      ? options.expires.toUTCString()
      : options.expires;
    parts.push(`expires=${expiresValue}`);
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.secure === true) {
    parts.push("Secure");
  } else if (options.secure === false) {
    parts.push("");
  }

  document.cookie = parts.join("; ");
}

/**
 * @param {string} [cookieString]
 */
export function parseCookies(cookieString = document.cookie) {
  const cookies = cookieString.split("; ");
  const cookieObj = {};
  for (const cookie of cookies) {
    if (!cookie) continue;
    const [key, value] = cookie.split("=");
    cookieObj[key] = decodeURIComponent(value || "");
  }
  return cookieObj;
}

/**
 * @param {string} name
 * @param {string} [cookieString]
 */
export function getCookie(name, cookieString) {
  const cookies = parseCookies(cookieString);
  return cookies[name];
}
