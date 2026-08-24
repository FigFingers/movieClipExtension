let exclusiveChain = Promise.resolve();

/**
 * 認証状態を読み取って更新する可能性がある、すべてのバックグラウンド処理を直列化する。
 * キューを継続するため末尾では失敗を吸収するが、呼び出し元には元の失敗をそのまま返す。
 */
export function runExclusive(task) {
  const run = exclusiveChain.then(() => task());
  exclusiveChain = run.then(
    () => {},
    () => {}
  );
  return run;
}
