import { sendRuntimeMessage } from './runtimeMessage.js';

const activeRequests = new WeakMap();

function errorMessage(reason) {
  if (reason === 'timeout' || reason === 'network_error') {
    return '記録一覧を取得できませんでした。通信環境を確認してください。';
  }
  if (reason === 'background_unavailable') {
    return '拡張機能を再読み込みしてください。';
  }
  if (reason === 'rate_limited') {
    return 'アクセスが集中しています。時間をおいて再試行してください。';
  }
  return '記録一覧の取得に失敗しました。';
}

// 閉じたパネルや、後から開始したリクエストを古い応答で上書きしない。
export async function loadClipList(container, { title, onLoaded }) {
  const request = {};
  activeRequests.set(container, request);
  const document = container.ownerDocument;
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.textContent = '読込中…';
  container.replaceChildren(status);
  const response = await sendRuntimeMessage({ type: 'FETCH_CLIP_LIST', title });
  if (!container.isConnected || activeRequests.get(container) !== request) return;

  if (!response?.ok || !Array.isArray(response.items)) {
    status.textContent = errorMessage(response?.reason);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '再試行';
    retry.onclick = () => {
      if (retry.disabled || !container.isConnected) return;
      retry.disabled = true;
      return loadClipList(container, { title, onLoaded });
    };
    container.appendChild(retry);
    return;
  }

  if (!response.items.length) {
    status.textContent = title
      ? `「${title}」の記録はまだありません。`
      : '記録がありません。';
    return;
  }
  onLoaded(response.items);
}
