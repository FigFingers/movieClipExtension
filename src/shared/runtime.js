// 呼出元が必要に応じてqueued/background_unavailableへ変換する。空応答を保存成功にしない。
export function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) { reject(new Error('Background unavailable')); return; }
    runtime.sendMessage(message, (response) => {
      if (runtime.lastError) { reject(new Error(runtime.lastError.message)); return; }
      if (!response) { reject(new Error('Empty background response')); return; }
      resolve(response);
    });
  });
}
