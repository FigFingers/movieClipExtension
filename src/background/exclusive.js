// 認証更新と通信は同じ順序で処理する。キューの保存は通信を待たせない独立した列を使う。
export function createSerialExecutor() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}

export const runAuthExclusive = createSerialExecutor();
