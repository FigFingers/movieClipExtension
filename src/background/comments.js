import { getApiEndpoint } from './../api.js';
import {
  STORAGE_KEYS,
  clearExtensionAuthState,
  storageGet,
} from './../shared/storage.js';
import {
  isValidExtensionAuthToken,
  isValidExtensionInstanceId,
} from './../shared/authValidation.js';
import { runExclusive } from './authMutex.js';
import { getOrCreateInstanceIdWhileExclusive } from './instanceId.js';
import { isValidCommentBody } from '../shared/commentText.js';

const DEFAULT_COMMENT_LIMIT = 20;
const MAX_COMMENT_LIMIT = 100;
export const COMMENTS_REQUEST_TIMEOUT_MS = 15 * 1000;

function validationError(field, message) {
  return {
    ok: false,
    reason: 'validation_error',
    field,
    message,
  };
}

function toPositiveSafeInteger(value) {
  let numberValue;

  if (typeof value === 'number') {
    numberValue = value;
  } else if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) return null;
    numberValue = Number(normalized);
  } else {
    return null;
  }

  return Number.isSafeInteger(numberValue) && numberValue > 0
    ? numberValue
    : null;
}

export function validateFetchClipCommentsInput(input = {}) {
  const clipId = toPositiveSafeInteger(input?.clipId);
  if (clipId === null) {
    return validationError('clipId', 'clipId must be a positive safe integer');
  }

  const limitValue = input?.limit === undefined
    ? DEFAULT_COMMENT_LIMIT
    : toPositiveSafeInteger(input.limit);
  if (limitValue === null || limitValue > MAX_COMMENT_LIMIT) {
    return validationError('limit', 'limit must be an integer from 1 to 100');
  }

  const value = { clipId, limit: limitValue };
  if (input?.cursor !== undefined) {
    const cursor = toPositiveSafeInteger(input.cursor);
    if (cursor === null) {
      return validationError('cursor', 'cursor must be a positive safe integer');
    }
    value.cursor = cursor;
  }

  return { ok: true, value };
}

export function validatePostClipCommentInput(input = {}) {
  const clipId = toPositiveSafeInteger(input?.clipId);
  if (clipId === null) {
    return validationError('clipId', 'clipId must be a positive safe integer');
  }

  if (typeof input?.body !== 'string') {
    return validationError('body', 'body must be a string');
  }

  const body = input.body.trim();
  if (!isValidCommentBody(body)) {
    return validationError('body', 'body must contain 1 to 500 characters after trimming');
  }

  return {
    ok: true,
    value: { clipId, body },
  };
}

export function getCommentsResponseReason(status) {
  if (status === 200 || status === 201) return null;
  if (status === 400) return 'validation_error';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'request_failed';
}

export function buildCommentsApiUrl({ clipId, cursor, limit }, extensionInstanceId) {
  const url = new URL(getApiEndpoint(`extension/clips/${clipId}/comments`));
  url.searchParams.set('extensionInstanceId', extensionInstanceId);
  if (cursor !== undefined) {
    url.searchParams.set('cursor', String(cursor));
  }
  url.searchParams.set('limit', String(limit));
  return url.toString();
}

async function parseResponseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    // Keep aborts observable by requestCommentsApi so a stalled response body is
    // reported as a timeout instead of a malformed successful response.
    if (error?.name === 'AbortError') throw error;
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isIsoDateString(value) {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isComment(value, expectedClipId) {
  return isPlainObject(value)
    && isPositiveSafeInteger(value.id)
    && value.clipId === expectedClipId
    && (isPositiveSafeInteger(value.userId) || value.userId === null)
    && (typeof value.username === 'string' || value.username === null)
    && isValidCommentBody(value.body)
    && isIsoDateString(value.createdAt);
}

export function isValidCommentsSuccessResponse(method, data, expectedClipId) {
  if (
    !isPlainObject(data)
    || data.ok !== true
    || !isPositiveSafeInteger(expectedClipId)
  ) {
    return false;
  }

  if (method === 'GET') {
    if (
      data.clipId !== expectedClipId
      || !Array.isArray(data.comments)
      || !data.comments.every((comment) => isComment(comment, expectedClipId))
    ) {
      return false;
    }
    if (typeof data.hasNext !== 'boolean') return false;

    if (data.hasNext) {
      const lastComment = data.comments.at(-1);
      return lastComment !== undefined && data.nextCursor === lastComment.id;
    }

    return data.nextCursor === null;
  }

  if (method === 'POST') {
    return isComment(data.comment, expectedClipId);
  }

  return false;
}

function copyServerErrorDetails(result, data) {
  if (typeof data?.message === 'string') {
    result.message = data.message;
  }
  if (typeof data?.code === 'string') {
    result.code = data.code;
  }
  return result;
}

function timeoutResult() {
  return { ok: false, reason: 'timeout' };
}

async function requestCommentsApi({ method, value, signal, deadline }) {
  if (signal.aborted || Date.now() >= deadline) return timeoutResult();

  const stored = await storageGet([
    STORAGE_KEYS.extensionInstanceId,
    STORAGE_KEYS.extensionAuthToken,
    STORAGE_KEYS.extensionLinked,
  ]);
  const extensionInstanceId = stored[STORAGE_KEYS.extensionInstanceId];
  const extensionAuthToken = stored[STORAGE_KEYS.extensionAuthToken];

  // The request may have spent its entire deadline waiting for runExclusive or
  // storage. Never start a stale network request after the caller timed out.
  if (signal.aborted || Date.now() >= deadline) return timeoutResult();

  if (!isValidExtensionInstanceId(extensionInstanceId)) {
    await getOrCreateInstanceIdWhileExclusive();
    if (signal.aborted || Date.now() >= deadline) return timeoutResult();
    return { ok: false, reason: 'missing_token' };
  }

  if (!isValidExtensionAuthToken(extensionAuthToken)) {
    if (
      extensionAuthToken !== undefined
      || stored[STORAGE_KEYS.extensionLinked] === true
    ) {
      await clearExtensionAuthState();
      if (signal.aborted || Date.now() >= deadline) return timeoutResult();
    }
    return { ok: false, reason: 'missing_token' };
  }

  const headers = {
    Authorization: `Bearer ${extensionAuthToken}`,
  };
  let url = getApiEndpoint(`extension/clips/${value.clipId}/comments`);
  const options = {
    method,
    headers,
    cache: 'no-store',
    signal,
  };

  if (method === 'GET') {
    url = buildCommentsApiUrl(value, extensionInstanceId);
  } else {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify({
      extensionInstanceId,
      body: value.body,
    });
  }

  let response;
  let data;
  try {
    response = await fetch(url, options);
    data = await parseResponseJson(response);
  } catch (error) {
    const timedOut = signal.aborted || Date.now() >= deadline;
    console.warn('[extension-comments] network error', {
      method,
      message: error?.message,
      timedOut,
    });
    return { ok: false, reason: timedOut ? 'timeout' : 'network_error' };
  }

  // Once fetch and JSON consumption have completed, wall-clock drift alone is
  // not a timeout. Only the timer actually aborting this request can discard a
  // completed response (matching fetchJsonWithTimeout semantics).
  if (signal.aborted) return timeoutResult();

  const expectedSuccessStatus = method === 'GET' ? 200 : 201;
  const successfulStatus = response.status === expectedSuccessStatus;
  const reason = getCommentsResponseReason(response.status) || 'request_failed';

  if (successfulStatus) {
    if (!isValidCommentsSuccessResponse(method, data, value.clipId)) {
      console.warn('[extension-comments] malformed success response', {
        method,
        status: response.status,
      });
      return {
        ok: false,
        reason: 'invalid_response',
        status: response.status,
      };
    }

    return { ...data, ok: true };
  }

  if (response.status === 401) {
    const current = await storageGet([STORAGE_KEYS.extensionAuthToken]);
    if (current[STORAGE_KEYS.extensionAuthToken] !== extensionAuthToken) {
      console.log('[extension-comments] stale 401 for replaced token; keeping current token');
      return copyServerErrorDetails({
        ok: false,
        reason: 'stale_unauthorized',
        status: response.status,
      }, data);
    }

    await clearExtensionAuthState();
  }

  return copyServerErrorDetails({
    ok: false,
    reason,
    status: response.status,
  }, data);
}

function runCommentsRequest(method, value) {
  const abortController = new AbortController();
  const deadline = Date.now() + COMMENTS_REQUEST_TIMEOUT_MS;
  let timeoutId;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      abortController.abort();
      resolve(timeoutResult());
    }, COMMENTS_REQUEST_TIMEOUT_MS);
  });
  const requestPromise = runExclusive(() => requestCommentsApi({
    method,
    value,
    signal: abortController.signal,
    deadline,
  }));

  return Promise.race([requestPromise, timeoutPromise])
    .finally(() => clearTimeout(timeoutId));
}

export async function fetchClipComments(input = {}) {
  const validated = validateFetchClipCommentsInput(input);
  if (!validated.ok) return validated;

  return runCommentsRequest('GET', validated.value);
}

export async function postClipComment(input = {}) {
  const validated = validatePostClipCommentInput(input);
  if (!validated.ok) return validated;

  return runCommentsRequest('POST', validated.value);
}
