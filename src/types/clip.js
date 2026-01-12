/**
 * @typedef {Object} ClipDataProps
 * @property {string} [title]
 * @property {string} [user]
 * @property {string|number} [startTime]
 * @property {string|number} [endTime]
 * @property {string} [url]
 * @property {string} [service]
 * @property {string|number} [clipId]
 * @property {string|number} [id]
 * @property {string} [username]
 * @property {string} [epnumber]
 */

/**
 * @typedef {Object} ClipListProps
 * @property {ClipDataProps[]} items
 * @property {(clipId: string | number | undefined) => void} [onSelect]
 */

/**
 * @typedef {ClipDataProps & {
 *   order: number
 * }} CacheItem
 */

export {};
