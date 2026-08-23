import assert from 'node:assert/strict';
import test from 'node:test';

import { setTextContentIfChanged } from '../../src/content/domUpdates.js';
import { commitSelectedClip } from '../../src/content/netflixClipSelection.js';

test('unchanged Disney+ button labels do not rewrite their text node', () => {
  let textContent = 'コメント';
  let writeCount = 0;
  const label = {
    get textContent() {
      return textContent;
    },
    set textContent(value) {
      textContent = value;
      writeCount += 1;
    },
  };

  assert.equal(setTextContentIfChanged(label, 'コメント'), false);
  assert.equal(writeCount, 0);
  assert.equal(setTextContentIfChanged(label, 'コメントを見る'), true);
  assert.equal(writeCount, 1);
  assert.equal(textContent, 'コメントを見る');
});

test('Netflix selection stores one complete mode update before opening', async () => {
  let finishStorage;
  const events = [];
  const writes = [];
  const storage = {
    set(value) {
      events.push('storage:start');
      writes.push(value);
      return new Promise((resolve) => {
        finishStorage = () => {
          events.push('storage:end');
          resolve();
        };
      });
    },
  };

  const committing = commitSelectedClip({
    data: {
      id: 42,
      title: 'Example',
      service: 'netflix',
      url: '/watch/42',
      StartTime: 10,
      EndTime: 20,
      ignored: 'not persisted',
    },
    requestedClipId: 99,
    ownerNonce: 'owner-nonce-42',
    storage,
    setCookies: () => events.push('cookies'),
    openClip: () => events.push('open'),
  });

  assert.deepEqual(events, ['storage:start']);
  assert.deepEqual(writes, [
    {
      clip: {
        clipId: 42,
        service: 'netflix',
        url: 'https://www.netflix.com/watch/42',
        startTime: 10,
        endTime: 20,
        title: 'Example',
      },
      currentClipId: 42,
      currentClipOrder: 0,
      playClipSystemKey: 1,
      playlistSystemKey: 0,
      playmode: 'clip',
      playbackOwnerNonce: 'owner-nonce-42',
    },
  ]);

  finishStorage();
  const selectedClip = await committing;

  assert.deepEqual(events, ['storage:start', 'storage:end', 'cookies', 'open']);
  assert.deepEqual(selectedClip, {
    clipId: 42,
    service: 'netflix',
    url: 'https://www.netflix.com/watch/42',
    startTime: 10,
    endTime: 20,
    title: 'Example',
  });
});
