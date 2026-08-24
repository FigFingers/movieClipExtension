export const PLAYBACK_CLEANUP_RETRY_DELAY_MINUTES = 1;

function reportFailure(logger, label, phase, error) {
  try {
    logger(`[background] ${label} ${phase}`, {
      message: typeof error?.message === 'string'
        ? error.message.slice(0, 500)
        : 'unknown error',
    });
  } catch {
    // A diagnostic sink must never turn a handled background failure back into
    // an unhandled rejection.
  }
}

/** Run a fire-and-forget task while guaranteeing that its Promise resolves. */
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
