// content script と background service worker の両方から使う storage ユーティリティ。
// DOM (window/location) に依存するコードをここに置いてはならない。

export const STORAGE_KEYS = {
  extensionInstanceId: 'extensionInstanceId',
  extensionAuthToken: 'extensionAuthToken',
  extensionTokenExpiresAt: 'extensionTokenExpiresAt',
  extensionTokenRefreshBackoff: 'extensionTokenRefreshBackoff',
  extensionLinked: 'extensionLinked',
  lastSyncAt: 'lastSyncAt',
  pendingClips: 'pendingClips',
};

export function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

export function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export function normalizePendingClips(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((clip) => clip?.clientItemId && clip?.url);
}

export async function clearExtensionAuthState() {
  await storageRemove([
    STORAGE_KEYS.extensionAuthToken,
    STORAGE_KEYS.extensionTokenExpiresAt,
    // トークンを捨てる以上、旧トークンで積み上がったリフレッシュ抑制も持ち越さない。
    STORAGE_KEYS.extensionTokenRefreshBackoff,
  ]);
  await storageSet({ [STORAGE_KEYS.extensionLinked]: false });
}
