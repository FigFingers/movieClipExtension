import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCommentsApiUrl,
  getCommentsResponseReason,
  validateFetchClipCommentsInput,
  validatePostClipCommentInput,
} from '../src/background/comments.js';

test('コメント一覧入力を正規化し、limit の既定値を設定する', () => {
  assert.deepEqual(validateFetchClipCommentsInput({ clipId: ' 42 ' }), {
    ok: true,
    value: {
      clipId: 42,
      limit: 20,
    },
  });

  assert.deepEqual(validateFetchClipCommentsInput({
    clipId: 42,
    cursor: '9',
    limit: '100',
  }), {
    ok: true,
    value: {
      clipId: 42,
      cursor: 9,
      limit: 100,
    },
  });
});

test('コメント一覧入力の不正な整数と limit を拒否する', () => {
  for (const clipId of [undefined, null, true, 0, -1, 1.5, '1.5', 'abc']) {
    const result = validateFetchClipCommentsInput({ clipId });
    assert.equal(result.ok, false);
    assert.equal(result.field, 'clipId');
  }

  for (const limit of [0, 101, 1.5, 'abc', null]) {
    const result = validateFetchClipCommentsInput({ clipId: 1, limit });
    assert.equal(result.ok, false);
    assert.equal(result.field, 'limit');
  }

  const cursorResult = validateFetchClipCommentsInput({ clipId: 1, cursor: 0 });
  assert.equal(cursorResult.ok, false);
  assert.equal(cursorResult.field, 'cursor');
});

test('コメント本文を trim し、1〜500文字だけ許可する', () => {
  assert.deepEqual(validatePostClipCommentInput({
    clipId: '7',
    body: '  hello  ',
  }), {
    ok: true,
    value: {
      clipId: 7,
      body: 'hello',
    },
  });

  assert.equal(validatePostClipCommentInput({
    clipId: 7,
    body: 'a'.repeat(500),
  }).ok, true);

  for (const body of [undefined, null, 123, '', '   ', 'a'.repeat(501)]) {
    const result = validatePostClipCommentInput({ clipId: 7, body });
    assert.equal(result.ok, false);
    assert.equal(result.field, 'body');
  }
});

test('コメントAPI URLは認証instanceIdとページネーションだけをqueryに含める', () => {
  const url = new URL(buildCommentsApiUrl({
    clipId: 123,
    cursor: 456,
    limit: 20,
  }, '11111111-1111-4111-8111-111111111111'));

  assert.equal(url.pathname, '/api/extension/clips/123/comments');
  assert.equal(
    url.searchParams.get('extensionInstanceId'),
    '11111111-1111-4111-8111-111111111111'
  );
  assert.equal(url.searchParams.get('cursor'), '456');
  assert.equal(url.searchParams.get('limit'), '20');
});

test('HTTP statusをコメントUI向けreasonへ変換する', () => {
  assert.equal(getCommentsResponseReason(200), null);
  assert.equal(getCommentsResponseReason(201), null);
  assert.equal(getCommentsResponseReason(400), 'validation_error');
  assert.equal(getCommentsResponseReason(401), 'unauthorized');
  assert.equal(getCommentsResponseReason(403), 'forbidden');
  assert.equal(getCommentsResponseReason(404), 'not_found');
  assert.equal(getCommentsResponseReason(500), 'request_failed');
});
