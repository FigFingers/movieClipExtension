// サイト画面から受けた linkToken を background に渡し、連携の成否だけを画面へ返す。
// 画面→content: { requestId, extensionInstanceId, linkToken } / content→画面: { requestId, ok, linked, reason, status }
export const PAGE_LINK_WITH_LINK_TOKEN = 'EXT_LINK_WITH_LINK_TOKEN';
export const PAGE_LINK_RESULT = 'EXTENSION_LINK_RESULT';
export const RUNTIME_LINK_WITH_LINK_TOKEN = 'LINK_WITH_LINK_TOKEN';

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function postToPage(data, targetOrigin) {
  window.postMessage(data, targetOrigin);
}

function pickRequestId(value) {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

// background の応答をそのまま転送せず、決めた項目だけを画面へ返す。
function toPageResult(requestId, result) {
  return {
    type: PAGE_LINK_RESULT,
    requestId,
    ok: result?.ok === true,
    linked: result?.linked === true,
    reason: typeof result?.reason === 'string' ? result.reason : null,
    status: Number.isInteger(result?.status) ? result.status : null,
  };
}

export async function handleExtensionLinkWithLinkToken(message, targetOrigin, {
  sendMessage = sendRuntimeMessage,
  postMessage = postToPage,
} = {}) {
  const requestId = pickRequestId(message?.requestId);
  let result;

  if (typeof message?.linkToken !== 'string') {
    result = { ok: false, reason: 'invalid_link_token' };
  } else {
    try {
      result = await sendMessage({
        type: RUNTIME_LINK_WITH_LINK_TOKEN,
        extensionInstanceId: message.extensionInstanceId,
        linkToken: message.linkToken,
      });
    } catch {
      result = { ok: false, reason: 'background_unavailable' };
    }
  }

  const response = toPageResult(requestId, result);
  postMessage(response, targetOrigin);
  return response;
}
