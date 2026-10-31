import { SITE_ORIGIN } from '../api.js';
import { enqueueClip } from './clipQueue.js';
import { getOrCreateInstanceId, saveExtensionAuthToken, unlinkExtension } from './authState.js';

function isSiteSender(sender) {
  try {
    const origin = new URL(sender?.url || sender?.tab?.url).origin;
    return [SITE_ORIGIN, SITE_ORIGIN.replace('//localhost', '//127.0.0.1')].includes(origin);
  } catch { return false; }
}

// Promiseを返したメッセージだけbackgroundが応答する。DOM・Chrome listenerから独立して検証可能。
export function handleStateMessage(message, sender) {
  switch (message?.type) {
    case 'ENQUEUE_CLIP':
      return Promise.resolve().then(() => enqueueClip(message.clip)).then((clip) => ({ ok: true, clip }));
    case 'GET_OR_CREATE_INSTANCE_ID':
      return getOrCreateInstanceId().then((extensionInstanceId) => ({ ok: true, extensionInstanceId }));
    case 'SAVE_EXTENSION_AUTH_TOKEN':
      return isSiteSender(sender) ? saveExtensionAuthToken(message) : Promise.resolve({ ok: false, reason: 'forbidden' });
    case 'UNLINK_EXTENSION':
      return isSiteSender(sender) ? unlinkExtension(message) : Promise.resolve({ ok: false, reason: 'forbidden' });
    default:
      return undefined;
  }
}
