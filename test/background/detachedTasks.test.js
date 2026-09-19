import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLAYBACK_CLEANUP_RETRY_DELAY_MINUTES,
  runDetachedTask,
  runPlaybackCleanupTask,
} from '../../src/background/detachedTasks.js';

test('a rejected detached task is reported and resolves as a fixed failure', async () => {
  const logs = [];
  const result = await runDetachedTask(
    () => Promise.reject(new Error('private failure detail')),
    {
      label: 'test task',
      logger: (...args) => logs.push(args),
    }
  );

  assert.deepEqual(result, { ok: false, reason: 'task_failed' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], '[background] test task failed');
  assert.deepEqual(logs[0][1], { message: 'private failure detail' });
});

test('playback cleanup failure schedules the same alarm for a delayed retry', async () => {
  const scheduled = [];
  const result = await runPlaybackCleanupTask({
    cleanup: () => Promise.reject(new Error('storage unavailable')),
    alarmName: 'playback-handoff-cleanup:nonce-example',
    scheduleAlarm: async (name, options) => {
      scheduled.push({ name, options });
    },
    logger: () => {},
  });

  assert.deepEqual(result, { ok: false, reason: 'task_failed' });
  assert.deepEqual(scheduled, [{
    name: 'playback-handoff-cleanup:nonce-example',
    options: {
      delayInMinutes: PLAYBACK_CLEANUP_RETRY_DELAY_MINUTES,
    },
  }]);
});

test('recovery failure is also contained instead of rejecting', async () => {
  const logs = [];
  const result = await runDetachedTask(
    () => {
      throw new Error('task failed');
    },
    {
      label: 'recoverable task',
      onError: () => Promise.reject(new Error('retry scheduling failed')),
      logger: (...args) => logs.push(args),
    }
  );

  assert.deepEqual(result, { ok: false, reason: 'task_failed' });
  assert.deepEqual(logs.map(([message]) => message), [
    '[background] recoverable task failed',
    '[background] recoverable task recovery failed',
  ]);
});
