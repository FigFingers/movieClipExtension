import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createMockServer, defaultCatalogInput, ensureTestVideos, normalizeCatalog } from './mock/src/index.js';
import { SITE_ORIGIN, fakeUrls, launchExtensionBrowser, prepareExtension, waitForFakePlayer } from './mock/harness/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'out', 'screenshots');
await mkdir(out, { recursive: true });
const work = await mkdtemp(path.join(root, 'out', 'screenshots-work-'));
process.env.MOVIE_CLIPPER_MOCK_CACHE ||= path.join(root, 'out', 'e2e', 'media');
const viewport = { width: 1440, height: 900 };
const shots = [];
const pageErrors = [];
let mock;
let browser;

async function waitFor(label, read) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await delay(100);
  }
  throw new Error(`待機がタイムアウトしました: ${label}`);
}

async function capture(page, file, title, description) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(out, file), animations: 'disabled', caret: 'hide' });
  shots.push({ file, title, description, viewport });
  console.log(`撮影: ${file} — ${title}`);
}

async function openPlayer(service) {
  const page = await browser.context.newPage();
  const url = service === 'netflix'
    ? fakeUrls.netflixWatch('81000001', { t: 12 })
    : fakeUrls.disneyPlay('5f0c0001-0000-4000-8000-000000000001');
  await page.goto(url);
  await waitForFakePlayer(page);
  await page.locator(service === 'netflix' ? '#record-button' : '#dext-left-button').waitFor();
  await page.waitForFunction(() => (document.querySelector('#hivePlayer1') || document.querySelector('video')).videoWidth > 0);
  return page;
}

async function pressRecord(page, service) {
  return page.evaluate((name) => {
    const video = document.querySelector('#hivePlayer1') || document.querySelector('video');
    const time = video.currentTime;
    document.querySelector(name === 'netflix' ? '#record-button' : '#dext-left-button').click();
    return time;
  }, service);
}

async function finishRecording(page, service, start, name) {
  await page.locator('#hivePlayer1, video').last().evaluate((video) => video.play());
  await page.waitForFunction((from) => (document.querySelector('#hivePlayer1') || document.querySelector('video')).currentTime >= from + 4, start);
  await pressRecord(page, service);
  await page.locator('#nf-memo-sidebar input').fill(name);
}

async function save(page) {
  await page.locator('#nf-memo-sidebar button').getByText('保存', { exact: true }).click();
  await page.locator('#nf-memo-sidebar').waitFor({ state: 'detached' });
}

async function createGallery() {
  const cards = await Promise.all(shots.map(async (shot, index) => {
    const png = (await readFile(path.join(out, shot.file))).toString('base64');
    return `<article><a href="${shot.file}"><img src="data:image/png;base64,${png}" alt="${shot.title}"></a><div class="caption"><span class="number">0${index + 1}</span><div><h2>${shot.title}</h2><p>${shot.description}</p></div></div></article>`;
  }));
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Movie Clipper — 使用画面</title>
<style>*{box-sizing:border-box}body{margin:0;padding:48px;background:#edf0f5;color:#182335;font-family:"Segoe UI","Yu Gothic",sans-serif}header{max-width:1504px;margin:0 auto 28px}.eyebrow{font-size:12px;letter-spacing:.2em;color:#536a86;font-weight:700}h1{font-size:34px;margin:12px 0}header p{margin:0;color:#536176;line-height:1.8;font-size:14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;max-width:1504px;margin:auto}article{overflow:hidden;background:#fff;border:1px solid #dce2eb;border-radius:12px;box-shadow:0 5px 18px #18335408}img{display:block;width:100%;aspect-ratio:8/5;object-fit:contain;background:#111}.caption{display:flex;gap:14px;padding:20px}.number{font:600 13px monospace;color:#62758e;padding-top:3px}h2{font-size:17px;margin:0 0 7px}article p{font-size:13px;margin:0;color:#596a80;line-height:1.7}@media(max-width:800px){body{padding:20px}.grid{grid-template-columns:1fr}}</style>
<header><div class="eyebrow">MOVIE CLIPPER / SCREEN CAPTURES</div><h1>録画から同期までの使用画面</h1><p>拡張を実際に操作して自動撮影した画面です。配信サービス・動画・サイトはテスト用のモックです。<br>各画像をクリックすると 1440 × 900 px の PNG を開けます。</p></header><main class="grid">${cards.join('')}</main></html>`;
  await writeFile(path.join(out, 'index.html'), html);
  await writeFile(path.join(out, 'screenshots.json'), JSON.stringify({ screenshots: shots }, null, 2));
  const gallery = await browser.context.newPage();
  await gallery.setViewportSize({ width: 1600, height: 1200 });
  await gallery.setContent(html);
  await gallery.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode()));
  });
  await gallery.screenshot({ path: path.join(out, 'overview.png'), fullPage: true, animations: 'disabled' });
}

try {
  const input = defaultCatalogInput();
  for (const service of ['netflix', 'disney']) {
    for (const title of input[service].titles) title.durationSeconds = 60;
  }
  const catalog = normalizeCatalog(input);
  await ensureTestVideos(catalog);
  const extension = await prepareExtension(root, path.join(work, 'extension'));
  mock = createMockServer({ port: 0, catalog });
  mock.store.state.settings.fake.netflix.controlsAutoHide = false;
  mock.store.state.settings.fake.disney.controlsAutoHide = false;
  const { port, origin } = await mock.listen();
  browser = await launchExtensionBrowser({ extensionDir: extension.dir, mockOrigin: origin, mockPort: port, profileDir: path.join(work, 'profile'), viewport });
  browser.context.setDefaultTimeout(15_000);
  browser.context.on('page', (page) => {
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('dialog', (dialog) => {
      pageErrors.push(dialog.message());
      dialog.dismiss().catch(() => {});
    });
  });

  const netflix = await openPlayer('netflix');
  await netflix.locator('video').evaluate((video) => video.pause());
  await capture(netflix, '01-netflix-player.png', 'Netflix：視聴画面', 'プレイヤーの操作バーに録画ボタンなどが追加されます。');
  const start = await pressRecord(netflix, 'netflix');
  await capture(netflix, '02-netflix-recording.png', 'Netflix：録画中', '録画ボタンを一度押すと、赤いアイコンで区間の開始を示します。');
  await finishRecording(netflix, 'netflix', start, '夜明けの交信');
  await capture(netflix, '03-netflix-save.png', 'Netflix：名前を付けて保存', 'もう一度押すと動画が一時停止し、右側に保存パネルが開きます。');
  await save(netflix);

  const disney = await openPlayer('disney');
  const disneyStart = await pressRecord(disney, 'disney');
  await finishRecording(disney, 'disney', disneyStart, '鏡の森の入り口');
  await capture(disney, '04-disney-save.png', 'Disney+：区間の保存', 'Disney+ でも作品名・エピソード・区間を確認し、名前を付けて保存できます。');
  await save(disney);

  const site = await browser.context.newPage();
  await site.goto(`${SITE_ORIGIN}/login?callbackUrl=/account`);
  await site.locator('[data-testid="login-as-1"]').click();
  await site.waitForURL('**/account');
  const reloaded = site.waitForEvent('load');
  reloaded.catch(() => {});
  await site.locator('[data-testid="link-button"]').click();
  const toast = site.locator('#toasts .toast.ok, #toasts .toast.error').first();
  await toast.waitFor();
  assert.equal(await toast.evaluate((el) => el.classList.contains('error')), false, await toast.textContent());
  await reloaded;
  await site.waitForFunction(() => document.querySelector('#fact-auth')?.textContent.includes('linked=true'));
  await waitFor('2 件のクリップが同期される', () => mock.store.state.clips.some((c) => c.name === '夜明けの交信') && mock.store.state.clips.some((c) => c.name === '鏡の森の入り口'));
  await capture(site, '05-linked-account.png', 'サイト：拡張との連携', 'モックの連携画面。連携後は、未送信のクリップがサイトに同期されます。');
  await site.goto(`${SITE_ORIGIN}/my_video`);
  await site.getByText('夜明けの交信', { exact: true }).waitFor();
  await site.getByText('鏡の森の入り口', { exact: true }).waitFor();
  await capture(site, '06-synced-clips.png', 'サイト：保存したクリップ', '先ほど保存した Netflix と Disney+ のクリップが一覧に並びます。');
  assert.deepEqual(pageErrors, [], '撮影中のページ例外・dialog');
  await createGallery();
  console.log(`画像一覧: ${path.join(out, 'index.html')}\n一覧画像: ${path.join(out, 'overview.png')}`);
} catch (error) {
  await writeFile(path.join(out, 'error.txt'), error.stack || String(error));
  throw error;
} finally {
  try {
    await browser?.close();
  } finally {
    await mock?.close();
    await rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}
