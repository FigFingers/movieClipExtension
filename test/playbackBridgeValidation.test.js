import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PLAYBACK_PAYLOAD_BYTES,
  MAX_PLAYLIST_ITEMS,
  normalizeClipInput,
  normalizeClipSelectedInput,
  normalizePlaybackSnapshot,
  normalizePlaylistInput,
  normalizePlaylistJson,
  parsePlaybackCookies,
} from '../src/shared/playbackBridgeValidation.js';

function clipInput(overrides = {}) {
  return {
    id: 123,
    service: 'Netflix',
    url: '/watch/8001?track=abc',
    startTime: 10,
    endTime: 20,
    title: ' Sample title ',
    ...overrides,
  };
}

test('playback cookies use a whitelist and preserve equals signs in values', () => {
  const parsed = parsePlaybackCookies(
    'title=Example; sessionToken=secret; url=%2Fwatch%2F1%3Fsig%3Da%3Db; service=netflix'
  );

  assert.deepEqual(parsed, {
    values: {
      title: 'Example',
      url: '/watch/1?sig=a=b',
      service: 'netflix',
    },
    invalidKeys: [],
  });
  assert.equal('sessionToken' in parsed.values, false);
});

test('malformed percent encoding invalidates only its whitelisted cookie', () => {
  const parsed = parsePlaybackCookies(
    'title=%E0%A4%A; sessionToken=%E0%A4%A; service=netflix'
  );

  assert.deepEqual(parsed.values, { service: 'netflix' });
  assert.deepEqual(parsed.invalidKeys, ['title']);
});

test('clipSelected normalizes legacy cookies and uses detail clipId as authority', () => {
  const result = normalizeClipSelectedInput(
    [
      'title=%20Example%20',
      'starttime=10.5',
      'endtime=20',
      'url=%2Fwatch%2F8001',
      'service=Netflix',
      'clipId=123',
      'unrelated=secret',
    ].join('; '),
    { clipId: '123' }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    clipId: 123,
    service: 'netflix',
    url: 'https://www.netflix.com/watch/8001',
    startTime: 10.5,
    endTime: 20,
    title: 'Example',
  });
  assert.equal('unrelated' in result.value, false);
  assert.equal('starttime' in result.value, false);
});

test('clipSelected rejects a missing or mismatched detail clipId', () => {
  const cookies = 'clipId=123; service=netflix; url=%2Fwatch%2F1; starttime=1; endtime=2';

  assert.deepEqual(normalizeClipSelectedInput(cookies, {}), {
    ok: false,
    reason: 'invalid_clip_id',
    field: 'clipId',
  });
  assert.deepEqual(normalizeClipSelectedInput(cookies, { clipId: 456 }), {
    ok: false,
    reason: 'clip_id_mismatch',
    field: 'clipId',
  });
  assert.equal(
    normalizeClipSelectedInput(
      'clipId=%E0%A4%A; service=netflix; url=%2Fwatch%2F1; starttime=1; endtime=2',
      { clipId: 123 }
    ).reason,
    'invalid_clip_id'
  );
});

test('single clip input rejects missing payload and invalid clip IDs', () => {
  assert.equal(normalizeClipInput(undefined).reason, 'invalid_payload');
  assert.equal(normalizeClipInput(new Date()).reason, 'invalid_payload');
  for (const clipId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1.5', 'abc', '']) {
    const result = normalizeClipInput(clipInput({ id: undefined, clipId }));
    assert.equal(result.reason, 'invalid_clip_id', String(clipId));
  }
});

test('single clip input rejects unsupported services and cross-service URLs', () => {
  assert.equal(
    normalizeClipInput(clipInput({ service: 'youtube' })).reason,
    'invalid_service'
  );
  for (const url of [
    'http://www.netflix.com/watch/1',
    'https://evil.example/watch/1',
    'https://user:pass@www.netflix.com/watch/1',
  ]) {
    assert.equal(normalizeClipInput(clipInput({ url })).reason, 'invalid_url');
  }
});

test('single clip input accepts the localhost Disney+ service code', () => {
  const result = normalizeClipInput(clipInput({
    service: 'DISNEY_PLUS',
    url: 'https://www.disneyplus.com/ja-jp/play/example',
  }));

  assert.equal(result.ok, true);
  assert.equal(result.value.service, 'disneyplus');
});

test('single clip input requires a finite increasing time range', () => {
  for (const overrides of [
    { startTime: Number.NaN },
    { startTime: Number.POSITIVE_INFINITY },
    { startTime: -1 },
    { startTime: 20, endTime: 20 },
    { startTime: 21, endTime: 20 },
    { startTime: '', endTime: 20 },
  ]) {
    assert.equal(
      normalizeClipInput(clipInput(overrides)).reason,
      'invalid_time_range'
    );
  }
});

test('playlist fills only missing order and removes unknown item fields', () => {
  const result = normalizePlaylistInput([
    clipInput({ id: 1, Subtitles: 'not persisted' }),
    clipInput({ id: 2, order: '7', service: 'disney+', url: '/video/example' }),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.value[0].order, 0);
  assert.equal(result.value[1].order, 7);
  assert.equal(result.value[1].service, 'disneyplus');
  assert.equal(result.value[1].url, 'https://www.disneyplus.com/video/example');
  assert.equal('Subtitles' in result.value[0], false);
  assert.equal(result.value[0].id, result.value[0].clipId);
});

test('playlist rejects invalid and duplicate explicit order values', () => {
  assert.equal(
    normalizePlaylistInput([clipInput({ id: 1, order: -1 })]).reason,
    'invalid_order'
  );
  assert.equal(
    normalizePlaylistInput([clipInput({ id: 1, order: null })]).reason,
    'invalid_order'
  );
  const duplicate = normalizePlaylistInput([
    clipInput({ id: 1, order: 2 }),
    clipInput({ id: 2, order: 2 }),
  ]);
  assert.deepEqual(duplicate, {
    ok: false,
    reason: 'duplicate_order',
    field: 'order',
    index: 1,
  });
});

test('playlist rejects empty, excessive count, malformed JSON, and raw byte excess', () => {
  assert.equal(normalizePlaylistInput([]).reason, 'empty_playlist');
  assert.equal(
    normalizePlaylistInput(
      Array.from({ length: MAX_PLAYLIST_ITEMS + 1 }, (_, index) =>
        clipInput({ id: index + 1 })
      )
    ).reason,
    'queue_too_large'
  );
  assert.equal(normalizePlaylistJson('{').reason, 'invalid_payload');
  assert.equal(
    normalizePlaylistJson('x'.repeat(MAX_PLAYBACK_PAYLOAD_BYTES + 1)).reason,
    'payload_too_large'
  );
});

test('playlist rejects normalized data larger than the byte limit', () => {
  const longPath = `/watch/${'a'.repeat(4000)}`;
  const queue = Array.from({ length: MAX_PLAYLIST_ITEMS }, (_, index) =>
    clipInput({
      id: index + 1,
      url: longPath,
      title: 't'.repeat(500),
      clipname: 'c'.repeat(500),
      user: 'u'.repeat(200),
      username: 'n'.repeat(200),
      epnumber: 'e'.repeat(200),
    })
  );

  assert.equal(normalizePlaylistInput(queue).reason, 'payload_too_large');
});

test('background snapshot normalization keeps only canonical clip data', () => {
  const result = normalizePlaybackSnapshot({
    context: { mode: 'clip', clipId: 123 },
    ownerNonce: 'nonce-canonical',
    snapshot: {
      clip: clipInput({ privateCookie: 'must not persist' }),
      playQueue: [{ secret: true }],
      nextClip: { secret: true },
      unexpected: 'discarded',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.clip.clipId, 123);
  assert.equal('privateCookie' in result.value.clip, false);
  assert.equal('unexpected' in result.value, false);
  assert.equal(result.value.playQueue, null);
  assert.equal(result.value.nextClip, null);
});

test('background snapshot normalization rejects nested invalid data and context mismatch', () => {
  assert.equal(
    normalizePlaybackSnapshot({
      context: { mode: 'clip', clipId: 123 },
      ownerNonce: 'nonce-invalid',
      snapshot: { clip: clipInput({ service: 'youtube' }) },
    }).reason,
    'invalid_service'
  );
  assert.equal(
    normalizePlaybackSnapshot({
      context: { mode: 'clip', clipId: 999 },
      ownerNonce: 'nonce-mismatch',
      snapshot: { clip: clipInput() },
    }).reason,
    'clip_id_mismatch'
  );
});
