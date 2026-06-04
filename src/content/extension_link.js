import {
  handleExtensionAuthStatusRequest,
  handleExtensionLinkWithAuthToken,
  checkAndRenewToken,
} from './extensionSync.js';

console.log('[extension-link] content script loaded on', location.href);

checkAndRenewToken();

// サイト側 ExtensionLinker が検知できるようにする
window.__CLIP_EXTENSION_PRESENT__ = true;

window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type !== 'GET_EXTENSION_INSTANCE_ID') return;

  console.log('[extension-link] GET_EXTENSION_INSTANCE_ID received', {
    requestId: data.requestId,
  });

  const port = chrome.runtime.connect({ name: 'extensionInstanceId' });
  port.onMessage.addListener((response) => {
    console.log('[extension-link] background response', response);
    window.postMessage(
      { type: 'EXTENSION_INSTANCE_ID_RESPONSE', requestId: data.requestId, ...response },
      window.location.origin
    );
    port.disconnect();
  });
  port.postMessage({});
});

window.addEventListener('message', async (event) => {
  if (event.source !== window) return;

  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (
    data.type !== 'EXTENSION_AUTH_STATUS_REQUEST' &&
    data.type !== 'EXTENSION_CHECK_AUTH' &&
    data.type !== 'EXT_LINK_WITH_AUTH_TOKEN'
  ) return;

  try {
    if (data.type === 'EXTENSION_AUTH_STATUS_REQUEST' || data.type === 'EXTENSION_CHECK_AUTH') {
      await handleExtensionAuthStatusRequest(
        data,
        event.origin || window.location.origin
      );
      return;
    }

    if (data.type === 'EXT_LINK_WITH_AUTH_TOKEN') {
      await handleExtensionLinkWithAuthToken(data);
    }
  } catch (error) {
    console.warn('[extension-sync] failed to handle extension link message', {
      type: data.type,
      message: error?.message,
    });
  }
});