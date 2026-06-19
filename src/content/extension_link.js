import {
  handleExtensionAuthStatusRequest,
  handleExtensionLinkWithAuthToken,
  checkAndRenewToken,
} from './extensionSync.js';
import { SITE_ORIGIN } from './../api.js';

// 認証ブリッジのメッセージを受け付ける信頼済みオリジン（アプリ本体のみ）。
// manifest を絞っていても、別ポート等で読み込まれた場合の多層防御として検証する。
const TRUSTED_ORIGINS = new Set([
  SITE_ORIGIN,
  SITE_ORIGIN.replace('//localhost', '//127.0.0.1'),
]);

function isTrustedOrigin(origin) {
  return TRUSTED_ORIGINS.has(origin);
}

console.log('[extension-link] content script loaded on', location.href);

checkAndRenewToken();

// 検知フラグ __CLIP_EXTENSION_PRESENT__ は MAIN world (extension_present.js) で公開する。
// この content script は isolated world で動くため、ここで代入してもページからは見えない。

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!isTrustedOrigin(event.origin)) return;

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
  if (!isTrustedOrigin(event.origin)) return;

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