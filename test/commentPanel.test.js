import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isAmbiguousPostFailure,
  resolveCurrentClipIdFromState,
  shouldClearSubmittedDraft,
} from '../src/content/commentPanel.js';

test('単体再生は clipId を id より優先する', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playmode: 'clip',
      clip: { clipId: 123, id: 999 },
    }),
    123
  );
});

test('単体再生は id と数値文字列を後方互換として受け付ける', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playmode: 'clip',
      clip: { id: '456' },
    }),
    456
  );
});

test('プレイリスト再生は currentClipOrder に一致する項目を解決する', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playmode: 'playlist',
      currentClipOrder: '2',
      playQueue: [
        { order: 0, id: 100 },
        { order: 2, clipId: '102', id: 999 },
      ],
    }),
    102
  );
});

test('プレイリストの currentClipId は正として利用しない', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playmode: 'playlist',
      currentClipOrder: 3,
      currentClipId: 777,
      playQueue: [{ order: 2, id: 100 }],
    }),
    null
  );
});

test('サーバーIDが無いローカル録画クリップは null にする', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playmode: 'clip',
      clip: {
        clientItemId: 'local-only',
        title: 'ローカル録画',
      },
    }),
    null
  );
});

test('0・負数・非整数・unsafe integer はクリップIDとして拒否する', () => {
  for (const clipId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'abc']) {
    assert.equal(
      resolveCurrentClipIdFromState({
        playmode: 'clip',
        clip: { clipId },
      }),
      null
    );
  }
});

test('playmode が無い旧状態では mode key をフォールバック利用する', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playClipSystemKey: 1,
      clip: { clipId: 88 },
    }),
    88
  );
  assert.equal(
    resolveCurrentClipIdFromState({
      playlistSystemKey: 1,
      currentClipOrder: 0,
      playQueue: [{ order: 0, id: 89 }],
    }),
    89
  );
});

test('プレイリスト再生は残留した単体再生の clip を参照しない', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playmode: 'playlist',
      clip: { clipId: 555 },
      currentClipOrder: 1,
      playQueue: [
        { order: 0, id: 100 },
        { order: 1, id: 101 },
      ],
    }),
    101
  );
});

test('clipId cookie が失効した単体再生は null にする', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playmode: 'clip',
      clip: { title: 'タイトル', starttime: '10', endtime: '20' },
    }),
    null
  );
});

test('再生モードが無い通常視聴では null にする', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      clip: { clipId: 123 },
      currentClipId: 123,
    }),
    null
  );
});

test('投稿待ちの間に書き換えた次の下書きは消さない', () => {
  assert.equal(shouldClearSubmittedDraft('送信した本文', '送信した本文'), true);
  assert.equal(shouldClearSubmittedDraft('次のコメント', '送信した本文'), false);
});

test('投稿済みか不明な失敗は一覧で確認する', () => {
  for (const reason of [
    'invalid_response',
    'network_error',
    'timeout',
    'background_unavailable',
    'request_failed',
  ]) {
    assert.equal(isAmbiguousPostFailure(reason), true);
  }
  assert.equal(isAmbiguousPostFailure('validation_error'), false);
  assert.equal(isAmbiguousPostFailure('unauthorized'), false);
});
