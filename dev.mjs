import { watch } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import webpack from 'webpack';
import { createMockServer, defaultCatalogInput, ensureTestVideos, normalizeCatalog } from './e2e/mock/src/index.js';
import { fakeUrls, launchExtensionBrowser } from './e2e/mock/harness/index.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const config = createRequire(import.meta.url)('./webpack.config.js');
const out = path.join(root, 'out', 'dev');
process.env.MOVIE_CLIPPER_MOCK_CACHE ||= path.join(root, 'out', 'e2e', 'media');
await mkdir(out, { recursive: true });
const work = await mkdtemp(path.join(out, 'session-'));
let mock, browser, watcher;
const fileWatchers = [];
let stopping = false;
let reloadQueue = Promise.resolve();

async function cleanup() {
  if (stopping) return;
  stopping = true;
  for (const item of fileWatchers) item.close();
  if (watcher) await new Promise((resolve) => watcher.close(resolve));
  await browser?.close().catch(() => {});
  await mock?.close().catch(() => {});
  await rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}

function reload() {
  reloadQueue = reloadQueue.then(async () => {
    if (!browser || stopping) return;
    const pages = browser.context.pages().filter((page) => /^(https:\/\/www\.(netflix|disneyplus)\.com\/|http:\/\/(localhost|127\.0\.0\.1):3000\/)/.test(page.url()));
    const session = await browser.context.browser().newBrowserCDPSession();
    try {
      await session.send('Extensions.loadUnpacked', { path: root });
    } finally {
      await session.detach();
    }
    await Promise.all(pages.map((page) => page.reload({ waitUntil: 'domcontentloaded' }).catch((error) => console.error('[dev] Page reload failed:', error.message))));
    console.log('[dev] Extension and mock pages reloaded.');
  }).catch((error) => console.error('[dev] Reload failed:', error.message));
}

try {
  const input = defaultCatalogInput();
  for (const service of ['netflix', 'disney']) {
    for (const title of input[service].titles) title.durationSeconds = 60;
  }
  const catalog = normalizeCatalog(input);
  await ensureTestVideos(catalog);
  mock = createMockServer({ port: 0, catalog });
  const { port, origin } = await mock.listen();
  const compiler = webpack({ ...config, mode: 'development', devtool: 'source-map' });
  let firstBuild;
  const built = new Promise((resolve, reject) => { firstBuild = { resolve, reject }; });
  watcher = compiler.watch({}, (error, stats) => {
    if (error || stats.hasErrors()) {
      console.error(error || stats.toString({ all: false, errors: true, errorDetails: true }));
      if (firstBuild) { firstBuild.reject(error || new Error('Initial build failed')); firstBuild = null; }
      return;
    }
    console.log('[dev] Build complete.');
    if (firstBuild) { firstBuild.resolve(); firstBuild = null; } else reload();
  });
  await built;
  browser = await launchExtensionBrowser({ extensionDir: root, mockOrigin: origin, mockPort: port, proxySiteApi: false, extensionDebugging: true, profileDir: path.join(work, 'profile'), headless: false });
  browser.context.on('close', () => { cleanup().finally(() => process.exit(0)); });
  for (const file of ['manifest.json', 'src/inject/inject_script.js', 'src/util/history_change.js', 'src/content/getClipData.js', 'src/content/extension_present.js']) {
    fileWatchers.push(watch(path.join(root, file), () => reload()));
  }
  const page = browser.context.pages()[0] || await browser.context.newPage();
  await page.goto(fakeUrls.netflixWatch('81000001'));
  const disney = await browser.context.newPage();
  await disney.goto(fakeUrls.disneyPlay('5f0c0001-0000-4000-8000-000000000001'));
  const site = await browser.context.newPage();
  await site.goto(`${origin}/__mock`);
  console.log(`[dev] Mock admin: ${origin}/__mock (localhost:3000 connects to your running site).`);
  console.log('[dev] Mock browser ready. Changes rebuild and reload the extension and mock tabs. Press Ctrl+C to stop.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup().finally(() => process.exit(0)); });
} catch (error) {
  console.error('[dev]', error);
  await cleanup();
  process.exitCode = 1;
}
