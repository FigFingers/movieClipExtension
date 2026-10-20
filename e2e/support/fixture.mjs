import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as mockApi from '../mock/src/index.js';
import * as harness from '../mock/harness/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const { fakeUrls } = harness;
export const NETFLIX_ID = '81000001';
export const DISNEY_ID = '5f0c0001-0000-4000-8000-000000000001';

let suiteDir;
let catalog;
let extension;
let registered = 0;
let passed = 0;

export async function prepareSuite() {
  const out = path.join(root, 'out', 'e2e');
  await mkdir(out, { recursive: true });
  suiteDir = await mkdtemp(path.join(out, 'run-'));
  process.env.MOVIE_CLIPPER_MOCK_CACHE ||= path.join(out, 'media');
  const input = mockApi.defaultCatalogInput();
  for (const service of ['netflix', 'disney']) {
    for (const title of input[service].titles) title.durationSeconds = 60;
  }
  catalog = mockApi.normalizeCatalog(input);
  await mockApi.ensureTestVideos(catalog, { log: () => {} });
  extension = await harness.prepareExtension(root, path.join(suiteDir, 'extension'));
}

/** 全テストが通ったときだけ、この実行のフォルダーを消す（失敗時の診断は残す）。 */
export async function finishSuite() {
  if (suiteDir && passed === registered) await rm(suiteDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}

export async function waitFor(label, read, { timeout = 10_000 } = {}) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(`待機がタイムアウトしました: ${label}`);
}

export function mockTest(id, title, run) {
  registered += 1;
  test(title, { timeout: 60_000 }, async (t) => {
    const work = path.join(suiteDir, id);
    await mkdir(work, { recursive: true });
    const mock = mockApi.createMockServer({ port: 0, catalog });
    let browser;
    const errors = [];
    const expectedDialogs = [];
    try {
      const { port, origin } = await mock.listen();
      mock.store.state.settings.fake.netflix.controlsAutoHide = false;
      mock.store.state.settings.fake.disney.controlsAutoHide = false;
      browser = await harness.launchExtensionBrowser({
        extensionDir: extension.dir,
        mockOrigin: origin,
        mockPort: port,
        profileDir: path.join(work, 'profile'),
        headless: process.env.E2E_HEADED !== '1',
      });
      browser.context.setDefaultTimeout(10_000);
      await browser.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const attach = (page) => {
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('dialog', (dialog) => {
          const index = expectedDialogs.indexOf(dialog.message());
          if (index === -1) errors.push(`dialog: ${dialog.message()}`);
          else expectedDialogs.splice(index, 1);
          dialog.dismiss().catch(() => {});
        });
      };
      browser.context.on('page', attach);
      browser.context.pages().forEach(attach);
      const fixture = {
        mock,
        browser,
        errors,
        pending: async () => (await browser.storage(['pendingClips'])).pendingClips || [],
        syncRequests: () => mock.store.state.requests.filter((r) => r.path === '/api/extension/sync'),
        /** 出ると分かっている dialog を待つ。それ以外の dialog はテストの失敗にする。 */
        expectDialog(page, message) {
          expectedDialogs.push(message);
          return page.waitForEvent('dialog');
        },
        async open(service = 'netflix', id = NETFLIX_ID) {
          const page = await browser.context.newPage();
          const url = service === 'netflix' ? fakeUrls.netflixWatch(id) : fakeUrls.disneyPlay(id);
          await page.goto(url);
          await harness.waitForFakePlayer(page);
          await page.locator(service === 'netflix' ? '#record-button' : '#dext-left-button').waitFor();
          return page;
        },
        async link() {
          const page = await browser.context.newPage();
          await page.goto(`${harness.SITE_ORIGIN}/login?callbackUrl=/account`);
          await page.locator('[data-testid="login-as-1"]').click();
          await page.waitForURL('**/account');
          // 成功するとサイトが 800ms 後に再読み込みする。失敗はトーストの文言で報告する。
          const reloaded = page.waitForEvent('load');
          reloaded.catch(() => {});
          await page.locator('[data-testid="link-button"]').click();
          const toast = page.locator('#toasts .toast.ok, #toasts .toast.error').first();
          await toast.waitFor();
          if (await toast.evaluate((el) => el.classList.contains('error'))) {
            assert.fail(`連携に失敗しました: ${await toast.textContent()}`);
          }
          await reloaded;
          const stored = await waitFor('拡張の連携', async () => {
            const value = await browser.storage(['extensionAuthToken', 'extensionLinked', 'extensionInstanceId']);
            return value.extensionLinked && value.extensionAuthToken ? value : null;
          });
          return { page, ...stored };
        },
        async fault(status) {
          const response = await fetch(`${origin}/__mock/api/faults`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'POST', path: '/api/extension/sync', status, times: 1 }),
          });
          assert.equal(response.ok, true);
        },
      };
      await run(fixture);
      assert.deepEqual(errors, [], 'ページの例外か想定外の dialog');
      await browser.context.tracing.stop();
      passed += 1;
    } catch (error) {
      if (browser) {
        for (const [index, page] of browser.context.pages().entries()) {
          await page.screenshot({ path: path.join(work, `page-${index}.png`), timeout: 3000 }).catch(() => {});
        }
        await browser.context.tracing.stop({ path: path.join(work, 'trace.zip') }).catch(() => {});
      }
      await writeFile(path.join(work, 'diagnostics.json'), JSON.stringify({
        error: error.stack,
        errors,
        requests: mock.store.state.requests.map(({ method, path: pathname, status }) => ({ method, path: pathname, status })),
      }, null, 2));
      t.diagnostic(`失敗時のスクリーンショット・trace・要求ログ: ${work}`);
      throw error;
    } finally {
      try {
        await browser?.close();
      } finally {
        await mock.close();
        await rm(path.join(work, 'profile'), { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
      }
    }
  });
}

// 実際のプレイヤーを再生し、ボタンを押す瞬間の時刻を同じ JS タスクで採取する。
// Disney+ の UI は整数秒を返すため、丸めと UI 更新タイミングの差を許す。
export async function pressRecord(page, service = 'netflix') {
  return page.evaluate((serviceName) => {
    const video = document.querySelector('#hivePlayer1') || document.querySelector('video');
    const contentTime = serviceName === 'disney' ? window.__fake.contentTime() : video.currentTime;
    const mediaTime = video.currentTime;
    document.querySelector(serviceName === 'netflix' ? '#record-button' : '#dext-left-button').click();
    return { contentTime, mediaTime };
  }, service);
}

export async function record(page, service = 'netflix') {
  const start = await pressRecord(page, service);
  await page.waitForFunction(({ serviceName, from }) => {
    const time = serviceName === 'disney' ? window.__fake.contentTime() : document.querySelector('video').currentTime;
    return time >= from + 2;
  }, { serviceName: service, from: start.contentTime });
  const end = await pressRecord(page, service);
  await page.locator('#nf-memo-sidebar input').waitFor();
  return { start, end };
}

export async function save(page, name) {
  await page.locator('#nf-memo-sidebar input').fill(name);
  await page.locator('#nf-memo-sidebar button').getByText('保存', { exact: true }).click();
  await page.locator('#nf-memo-sidebar').waitFor({ state: 'detached' });
}

export function assertTimes(clip, recorded, tolerance = 0.3) {
  assert.ok(Math.abs(clip.startTime - recorded.start.contentTime) < tolerance, `開始: ${clip.startTime} ≒ ${recorded.start.contentTime}`);
  assert.ok(Math.abs(clip.endTime - recorded.end.contentTime) < tolerance, `終了: ${clip.endTime} ≒ ${recorded.end.contentTime}`);
}
