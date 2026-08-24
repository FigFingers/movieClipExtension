let exclusiveChain = Promise.resolve();

/**
 * Serialize all background operations that can read and then mutate auth
 * state. Rejections are absorbed only for the queue tail so the caller still
 * receives its original failure.
 */
export function runExclusive(task) {
  const run = exclusiveChain.then(() => task());
  exclusiveChain = run.then(
    () => {},
    () => {}
  );
  return run;
}
