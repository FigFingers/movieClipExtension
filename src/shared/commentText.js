export const COMMENT_BODY_MAX_CODE_POINTS = 500;

export function countUnicodeCodePoints(value) {
  return Array.from(value).length;
}

export function isValidCommentBody(value) {
  if (typeof value !== 'string') return false;
  const length = countUnicodeCodePoints(value.trim());
  return length >= 1 && length <= COMMENT_BODY_MAX_CODE_POINTS;
}
