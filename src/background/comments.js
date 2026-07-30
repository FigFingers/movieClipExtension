import { getApiEndpoint } from './../api.js';
import {
  STORAGE_KEYS,
  clearExtensionAuthState,
  storageGet,
} from './../shared/storage.js';
import { runExclusive } from './sync.js';

const DEFAULT_COMMENT_LIMIT = 20;
const MAX_COMMENT_LIMIT = 100;
const MAX_COMMENT_BODY_LENGTH = 500;

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
  if (body.length < 1 || body.length > MAX_COMMENT_BODY_LENGTH) {
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

function parseResponseJson(response) {
  return response.json().catch(() => null);
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

async function requestCommentsApi({ method, value }) {
  const stored = await storageGet([
    STORAGE_KEYS.extensionInstanceId,
    STORAGE_KEYS.extensionAuthToken,
  ]);
  const extensionInstanceId = stored[STORAGE_KEYS.extensionInstanceId];
  const extensionAuthToken = stored[STORAGE_KEYS.extensionAuthToken];

  if (
    typeof extensionInstanceId !== 'string' ||
    extensionInstanceId.length === 0 ||
    typeof extensionAuthToken !== 'string' ||
    extensionAuthToken.length === 0
  ) {
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
  try {
    response = await fetch(url, options);
  } catch (error) {
    console.warn('[extension-comments] network error', {
      method,
      message: error?.message,
    });
    return { ok: false, reason: 'network_error' };
  }

  const data = await parseResponseJson(response);
  const reason = getCommentsResponseReason(response.status);

  if (reason === null) {
    const result = data && typeof data === 'object' && !Array.isArray(data)
      ? { ...data }
      : {};
    result.ok = true;
    return result;
  }

  if (response.status === 401) {
    await clearExtensionAuthState();
  }

  return copyServerErrorDetails({
    ok: false,
    reason,
    status: response.status,
  }, data);
}

export async function fetchClipComments(input = {}) {
  const validated = validateFetchClipCommentsInput(input);
  if (!validated.ok) return validated;

  return runExclusive(() => requestCommentsApi({
    method: 'GET',
    value: validated.value,
  }));
}

export async function postClipComment(input = {}) {
  const validated = validatePostClipCommentInput(input);
  if (!validated.ok) return validated;

  return runExclusive(() => requestCommentsApi({
    method: 'POST',
    value: validated.value,
  }));
}
