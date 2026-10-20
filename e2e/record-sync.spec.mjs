import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import {
  DISNEY_ID, NETFLIX_ID, assertTimes, fakeUrls, finishSuite, mockTest,
  prepareSuite, pressRecord, record, save, waitFor,
} from './support/fixture.mjs';

before(prepareSuite, { timeout: 60_000 });
after(finishSuite);

mockTest('netflix-queue', 'Netflix: 保存した名前・作品・区間を未連携のキューに残す', async (f) => {
  const page = await f.open();
  const recorded = await record(page);
  assert.equal(await page.locator('video').evaluate((v) => v.paused), true);
  await save(page, 'Netflix のテストクリップ');
  const pending = await f.pending();
  assert.equal(pending.length, 1);
  const [clip] = pending;
  assert.equal(clip.clipName, 'Netflix のテストクリップ');
  assert.equal(clip.title, 'モック・ステーション');
  assert.equal(clip.epnumber, 'S1:E1');
  assert.equal(clip.service, 'Netflix');
  assert.equal(clip.url, fakeUrls.netflixWatch(NETFLIX_ID));
  assertTimes(clip, recorded);
  assert.equal(f.syncRequests().length, 0);
  await page.waitForFunction(() => !document.querySelector('video').paused);
});

mockTest('netflix-movie', 'Netflix: 映画の作品名も保存できる', async (f) => {
  const page = await f.open('netflix', '81000003');
  await record(page);
  await save(page, '映画のシーン');
  const [clip] = await f.pending();
  assert.equal(clip.title, 'テスト・パターンの夜');
  assert.equal(clip.epnumber, null);
  assert.equal(clip.url, fakeUrls.netflixWatch('81000003'));
});

mockTest('cancel', 'Netflix: 保存パネルを閉じるとクリップを追加しない', async (f) => {
  const page = await f.open();
  const count = f.mock.store.state.clips.length;
  await record(page);
  await page.locator('#nf-memo-sidebar button').getByText('×', { exact: true }).click();
  await page.locator('#nf-memo-sidebar').waitFor({ state: 'detached' });
  assert.deepEqual(await f.pending(), []);
  assert.equal(f.mock.store.state.clips.length, count);
  assert.equal(f.syncRequests().length, 0);
});

mockTest('short-range', 'Netflix: 1 秒未満の区間を拒否し、その後は録画し直せる', async (f) => {
  const page = await f.open();
  await page.locator('video').evaluate((v) => v.pause());
  await pressRecord(page);
  const dialogPromise = f.expectDialog(page, '録画範囲が短すぎます');
  await pressRecord(page);
  const dialog = await dialogPromise;
  assert.equal(dialog.message(), '録画範囲が短すぎます');
  assert.equal(await page.locator('#nf-memo-sidebar').count(), 0);
  assert.deepEqual(await f.pending(), []);
  await page.locator('video').evaluate((v) => v.play());
  await record(page);
  await save(page, '録画し直した区間');
  assert.equal((await f.pending()).length, 1);
  assert.equal((await f.pending())[0].clipName, '録画し直した区間');
});

mockTest('disney-time', 'Disney+: メディア時刻のずれを除いた作品の区間を保存する', async (f) => {
  const page = await f.open('disney', DISNEY_ID);
  const recorded = await record(page, 'disney');
  assert.ok(Math.abs(recorded.start.mediaTime - recorded.start.contentTime - 7.5) < 0.1);
  await save(page, 'Disney+ のテストクリップ');
  const pending = await f.pending();
  assert.equal(pending.length, 1);
  const [clip] = pending;
  assert.equal(clip.clipName, 'Disney+ のテストクリップ');
  assert.equal(clip.title, '魔法のテストランド');
  assert.equal(clip.epnumber, 'S1:E1 鏡の森');
  assert.equal(clip.service, 'Disney+');
  assert.equal(clip.url, fakeUrls.disneyPlay(DISNEY_ID));
  assertTimes(clip, recorded, 1.1);
});

for (const service of ['netflix', 'disney']) {
  mockTest(`${service}-save-retry`, `${service}: ローカル保存に失敗しても名前と区間を保持して再試行できる`, async (f) => {
    const page = await f.open(service, service === 'netflix' ? NETFLIX_ID : DISNEY_ID);
    const recorded = await record(page, service);
    const worker = await f.browser.getServiceWorker();
    // content script の isolated world で、次のキュー書込みだけを失敗させる。
    await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: () => {
          const original = chrome.storage.local.set;
          chrome.storage.local.set = (items, callback) => {
            if (Object.hasOwn(items, 'pendingClips')) {
              chrome.storage.local.set = original;
              throw new Error('test: local storage write failed');
            }
            return original.call(chrome.storage.local, items, callback);
          };
        },
      });
    }, page.url());
    const sidebar = page.locator('#nf-memo-sidebar');
    await sidebar.locator('input').fill('失敗しても残る名前');
    await sidebar.getByRole('button', { name: '保存', exact: true }).click();
    await sidebar.getByRole('alert').waitFor();
    assert.match(await sidebar.getByRole('alert').textContent(), /保存できませんでした/);
    assert.equal(await sidebar.locator('input').inputValue(), '失敗しても残る名前');
    assert.equal(await sidebar.getByRole('button', { name: '保存', exact: true }).isEnabled(), true);
    const video = page.locator(service === 'disney' ? '#hivePlayer1' : 'video');
    assert.equal(await video.evaluate((v) => v.paused), true);
    assert.deepEqual(await f.pending(), []);

    await save(page, '失敗しても残る名前');
    const pending = await f.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].clipName, '失敗しても残る名前');
    assertTimes(pending[0], recorded, service === 'disney' ? 1.1 : 0.3);
    await page.waitForFunction(() => !(document.querySelector('#hivePlayer1') || document.querySelector('video')).paused);
  });
}

mockTest('link-and-sync', 'サイト連携: 未連携で保存したクリップを連携直後に一度だけ同期する', async (f) => {
  const page = await f.open();
  const recorded = await record(page);
  await save(page, '連携後に同期するクリップ');
  assert.equal((await f.pending()).length, 1);
  const linked = await f.link();
  const clip = await waitFor('サイトにクリップ作成', () => f.mock.store.state.clips.find((c) => c.name === '連携後に同期するクリップ'));
  await waitFor('同期後のキュー消去', async () => (await f.pending()).length === 0);
  assert.equal(clip.userId, 1);
  assert.equal(clip.vodId, 1);
  assert.equal(clip.url, fakeUrls.netflixWatch(NETFLIX_ID));
  assertTimes({ startTime: clip.startMs / 1000, endTime: clip.endMs / 1000 }, recorded);
  const requests = f.syncRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, 200);
  assert.equal(requests[0].origin, `chrome-extension://${f.browser.extensionId}`);
  assert.equal(requests[0].body.extensionInstanceId, linked.extensionInstanceId);
  assert.equal(f.mock.store.state.clips.filter((c) => c.name === clip.name).length, 1);
});

mockTest('retry-500', '同期エラー: 500 の後もキューを保持し alarm で同じクリップを再送する', async (f) => {
  await f.link();
  await f.fault(500);
  const page = await f.open();
  await record(page);
  await save(page, '再送するクリップ');
  const pending = await f.pending();
  assert.equal(pending.length, 1);
  assert.equal(f.syncRequests().at(-1).status, 500);
  assert.equal(f.mock.store.state.clips.some((c) => c.name === '再送するクリップ'), false);
  // Service Worker の起動時の再送と区別するため、印を付けた同じ Service Worker が送ったことを確かめる。
  await (await f.browser.getServiceWorker()).evaluate(() => { globalThis.__beforeAlarm = true; });
  assert.equal(f.syncRequests().length, 1);
  await f.browser.fireAlarm('extension-sync-retry');
  await waitFor('再送後のキュー消去', async () => (await f.pending()).length === 0);
  assert.equal(await (await f.browser.getServiceWorker()).evaluate(() => globalThis.__beforeAlarm === true), true, 'alarm ではなく Service Worker の再起動で再送した');
  const requests = f.syncRequests();
  assert.deepEqual(requests.map((r) => r.status), [500, 200]);
  assert.equal(requests[1].body.items[0].clientItemId, pending[0].clientItemId);
  assert.equal(f.mock.store.state.clips.filter((c) => c.name === '再送するクリップ').length, 1);
});

mockTest('revoked-token', '同期エラー: 401 では連携トークンを破棄し、未送信クリップは保持する', async (f) => {
  await f.link();
  await f.fault(401);
  const page = await f.open();
  await record(page);
  await save(page, '再連携を待つクリップ');
  const pending = await f.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].clipName, '再連携を待つクリップ');
  assert.equal(f.syncRequests().at(-1).status, 401);
  const stored = await f.browser.storage(['extensionAuthToken', 'extensionLinked']);
  assert.equal(Boolean(stored.extensionAuthToken), false);
  assert.equal(Boolean(stored.extensionLinked), false);
  assert.equal(f.mock.store.state.clips.some((c) => c.name === pending[0].clipName), false);
});

for (const [id, status, options] of [
  ['malformed-success', 200, { kind: 'malformed' }],
  ['unidentified-validation', 400, {}],
]) {
  mockTest(id, `同期エラー: ${id}でもキューを保持し同じIDで再送できる`, async (f) => {
    await f.link();
    await f.fault(status, options);
    const page = await f.open();
    await record(page);
    await save(page, '応答不明でも残すクリップ');
    const pending = await f.pending();
    assert.equal(pending.length, 1);
    assert.equal(f.syncRequests().at(-1).status, status);
    assert.equal(f.mock.store.state.clips.some((c) => c.name === pending[0].clipName), false);
    await f.browser.fireAlarm('extension-sync-retry');
    await waitFor('再送後のキュー消去', async () => (await f.pending()).length === 0);
    assert.deepEqual(f.syncRequests().map((r) => r.status), [status, 200]);
    assert.equal(f.syncRequests()[1].body.items[0].clientItemId, pending[0].clientItemId);
    assert.equal(f.mock.store.state.clips.filter((c) => c.name === pending[0].clipName).length, 1);
  });
}
