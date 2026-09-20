import {
  STORAGE_KEYS,
  clearExtensionAuthState,
  storageGet,
  storageSet,
} from './../shared/storage.js';
import { isValidExtensionInstanceId } from './../shared/authValidation.js';
import { runExclusive } from './authMutex.js';

async function readOrCreateInstanceId() {
  const stored = await storageGet([STORAGE_KEYS.extensionInstanceId]);
  const existingId = stored[STORAGE_KEYS.extensionInstanceId];
  if (isValidExtensionInstanceId(existingId)) {
    return existingId;
  }

  // 認証トークンはinstance IDに紐づく。IDが欠落または破損しているのに
  // 古いトークンを保持すると、連携済みと誤表示され、後続の401で消去されるまで
  // すべてのAPIリクエストが失敗し続ける。
  await clearExtensionAuthState();

  const extensionInstanceId = crypto.randomUUID();
  await storageSet({ [STORAGE_KEYS.extensionInstanceId]: extensionInstanceId });
  return extensionInstanceId;
}

async function readValidInstanceIdOrRepair() {
  const stored = await storageGet([STORAGE_KEYS.extensionInstanceId]);
  const existingId = stored[STORAGE_KEYS.extensionInstanceId];
  if (isValidExtensionInstanceId(existingId)) {
    return existingId;
  }

  // 更新前にミューテックス内で再読込する。有効なIDの参照はコメント・同期リクエスト中も
  // 待たせず、修復処理だけをすべての認証書き込みと同じ順序で実行する。
  return runExclusive(readOrCreateInstanceId);
}

let instanceIdPromise = null;

// すでに認証ミューテックス内にいる呼び出し元は、再入不可のロックを
// 取り直さないようこの入口を使う。
export function getOrCreateInstanceIdWhileExclusive() {
  return readOrCreateInstanceId();
}

/**
 * 実行中の読込・生成処理だけを共有する。完了後はストレージを再読込することで、
 * Service Workerが生存中にローカルストレージが消去・破損しても回復できる。
 */
export function getOrCreateInstanceId() {
  if (!instanceIdPromise) {
    const pending = readValidInstanceIdOrRepair();
    const shared = pending.then(
      (extensionInstanceId) => {
        if (instanceIdPromise === shared) instanceIdPromise = null;
        return extensionInstanceId;
      },
      (error) => {
        if (instanceIdPromise === shared) instanceIdPromise = null;
        throw error;
      }
    );
    instanceIdPromise = shared;
  }
  return instanceIdPromise;
}
