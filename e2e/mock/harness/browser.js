// 拡張を読み込んだ Chromium を起動し、モックにつなぐ。
//
// - http://localhost:3000 … モックを 3000 番で起動していればそのまま。別のポートなら Chromium の
//   プロキシをモックにして、localhost への要求もプロキシを通す（--proxy-bypass-list=<-loopback>）。
//   拡張の Service Worker の fetch もプロキシを通るため、拡張を書き換えずに済む。
// - https://www.netflix.com/*・https://www.disneyplus.com/* … Playwright の route でモックの
//   擬似ページ（/__fake/*）を返す。本物のサービスには接続しない。
//
// Google Chrome（ブランド版）は --load-extension を受け付けないため、Playwright の Chromium を使う。
import { chromium } from 'playwright';
import { access, cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fakeServicePath } from '../src/fake-services/routes.js';

export const SITE_ORIGIN = 'http://localhost:3000';
const FAKE_SERVICE_PATTERN = /^https:\/\/www\.(?:netflix|disneyplus)\.com\//;

function referencedFiles(manifest) {
  const files = new Set(['manifest.json']);
  const add = (value) => {
    if (typeof value === 'string' && value) files.add(value.replace(/^\//, ''));
  };
  add(manifest.background?.service_worker);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) add(file);
    for (const file of script.css || []) add(file);
  }
  for (const entry of manifest.web_accessible_resources || []) {
    for (const file of entry.resources || []) add(file);
  }
  for (const icon of Object.values(manifest.icons || {})) add(icon);
  for (const icon of Object.values(manifest.action?.default_icon || {})) add(icon);
  add(manifest.action?.default_popup);
  add(manifest.options_page);
  add(manifest.options_ui?.page);
  return [...files];
}

/**
 * manifest.json が参照するファイルだけを作業用のフォルダーへ写す。
 * node_modules などを Chromium に読ませないためと、写した先を消せば毎回まっさらになるため。
 */
export async function prepareExtension(extensionDir, outDir) {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`拡張の manifest.json を読めません: ${manifestPath}（${error.message}）`);
  }
  const files = referencedFiles(manifest);
  const missing = [];
  for (const file of files) {
    try {
      await access(path.join(extensionDir, file));
    } catch {
      missing.push(file);
    }
  }
  if (missing.length > 0) {
    throw new Error(`拡張のビルド済みファイルがありません: ${missing.join(', ')}\n拡張のフォルダーで npm run build を実行してください。`);
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const file of files) {
    await cp(path.join(extensionDir, file), path.join(outDir, file), { recursive: true });
  }
  return { dir: outDir, manifest, files };
}

async function fulfillFromMock(route, mockOrigin) {
  const request = route.request();
  const target = fakeServicePath(request.url());
  if (!target) {
    await route.abort('blockedbyclient');
    return;
  }
  // 動画の部分要求（Range）はそのまま渡す。https の動画を指す作品はリダイレクトを返すので、追わずにブラウザーへ返す。
  const range = request.headers().range;
  const response = await fetch(`${mockOrigin}${target}`, {
    method: request.method(),
    headers: { 'X-Forwarded-Url': request.url(), ...(range ? { Range: range } : {}) },
    redirect: 'manual',
  });
  const headers = Object.fromEntries(response.headers.entries());
  delete headers['content-length'];
  delete headers['transfer-encoding'];
  delete headers.connection;
  await route.fulfill({
    status: response.status,
    headers,
    body: Buffer.from(await response.arrayBuffer()),
  });
}

/**
 * https://www.netflix.com/* と https://www.disneyplus.com/* を、モックの擬似ページで返す。
 * 拡張なしの Playwright のテストでも使える（browser.newContext() の context を渡す）。
 * @param {import('playwright').BrowserContext} context
 * @param {string} mockOrigin モックに直接つなぐ URL（http://127.0.0.1:<port>）
 */
export function routeFakeServices(context, mockOrigin) {
  // モックへの要求が切れた・閉じた後の要求は失敗として返し、返せなければ捨てる。
  return context.route(FAKE_SERVICE_PATTERN, (route) => fulfillFromMock(route, mockOrigin)
    .catch(() => route.abort('failed').catch(() => {})));
}

/**
 * @param {object} options
 * @param {string} options.extensionDir 写し終えた拡張のフォルダー（prepareExtension の dir）
 * @param {string} options.mockOrigin モックに直接つなぐ URL（http://127.0.0.1:<port>）
 * @param {number} options.mockPort
 * @param {string} options.profileDir Chromium のプロファイル。消してから使う
 * @param {boolean} [options.headless]
 * @param {boolean} [options.proxySiteApi] localhost:3000 の API もモックへ振り分ける
 * @param {boolean} [options.extensionDebugging] 開発用ブラウザーで CDP による拡張の再読み込みを許可する
 * @param {{ width: number, height: number }} [options.viewport]
 */
export async function launchExtensionBrowser({
  extensionDir,
  mockOrigin,
  mockPort,
  profileDir,
  headless = true,
  proxySiteApi = true,
  extensionDebugging = false,
  viewport = { width: 1280, height: 800 },
  slowMo,
}) {
  await rm(profileDir, { recursive: true, force: true });
  const args = [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  // manifest.json の host_permissions と content_scripts がサイトを localhost:3000 に固定しているため、3000 番以外で動くモックへはプロキシで回す。
  const proxied = proxySiteApi && mockPort !== 3000;
  if (extensionDebugging) args.push('--enable-unsafe-extension-debugging');
  if (proxied) {
    args.push(`--proxy-server=http://127.0.0.1:${mockPort}`, '--proxy-bypass-list=<-loopback>');
  }
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless,
    viewport,
    args,
    slowMo,
  });
  await routeFakeServices(context, mockOrigin);

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(serviceWorker.url()).host;

  /** 動いている拡張の Service Worker。止まっていれば起こす。 */
  async function getServiceWorker({ timeout = 10_000 } = {}) {
    const live = context.serviceWorkers().find((worker) => worker.url().startsWith(`chrome-extension://${extensionId}/`));
    if (live) return live;
    const waiting = context.waitForEvent('serviceworker', { timeout });
    // サイトのページで拡張に問い合わせると、Service Worker が起きる。
    const page = await context.newPage();
    try {
      await page.goto(`${SITE_ORIGIN}/__mock`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.evaluate(() => window.postMessage({ type: 'GET_EXTENSION_INSTANCE_ID', requestId: 'wake' }, location.origin)).catch(() => {});
      return await waiting;
    } finally {
      await page.close().catch(() => {});
    }
  }

  return {
    context,
    extensionId,
    proxied,
    getServiceWorker,
    /** chrome.storage.local の中身 */
    async storage(keys = null) {
      const worker = await getServiceWorker();
      return worker.evaluate((requested) => chrome.storage.local.get(requested), keys);
    },
    /** 拡張の alarm を今すぐ鳴らす（読み込んだだけの拡張は、間隔の下限が無い）。 */
    async fireAlarm(name) {
      const worker = await getServiceWorker();
      await worker.evaluate(async (alarmName) => {
        // 周期つきの alarm は周期を保ったまま、最初の発火だけを今にする。
        const existing = await chrome.alarms.get(alarmName);
        await chrome.alarms.create(alarmName, {
          when: Date.now() + 50,
          ...(existing?.periodInMinutes ? { periodInMinutes: existing.periodInMinutes } : {}),
        });
      }, name);
    },
    async close() {
      await context.close();
    },
  };
}
