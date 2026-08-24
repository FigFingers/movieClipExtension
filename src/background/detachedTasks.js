export const PLAYBACK_CLEANUP_RETRY_DELAY_MINUTES = 1;

function reportFailure(logger, label, phase, error) {
  try {
    logger(`[background] ${label} ${phase}`, {
      message: typeof error?.message === 'string'
        ? error.message.slice(0, 500)
        : 'unknown error',
    });
  } catch {
    // 診断出力の失敗によって、処理済みのバックグラウンドエラーを
    // 未処理のPromiseエラーへ戻してはならない。
  }
}

/** 完了を待たないタスクを実行し、返されるPromiseが必ず正常終了するよう保証する。 */
export async function runDetachedTask(
  task,
  {
    label = 'detached task',
    onError,
    logger = (...args) => console.error(...args),
  } = {}
) {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    reportFailure(logger, label, 'failed', error);
    if (typeof onError === 'function') {
      try {
        await onError(error);
      } catch (recoveryError) {
        reportFailure(logger, label, 'recovery failed', recoveryError);
      }
    }
    return { ok: false, reason: 'task_failed' };
  }
}

export function runPlaybackCleanupTask({
  cleanup,
  alarmName,
  scheduleAlarm,
  retryDelayInMinutes = PLAYBACK_CLEANUP_RETRY_DELAY_MINUTES,
  logger,
}) {
  return runDetachedTask(cleanup, {
    label: 'playback cleanup',
    logger,
    onError: () => scheduleAlarm(alarmName, {
      delayInMinutes: retryDelayInMinutes,
    }),
  });
}
