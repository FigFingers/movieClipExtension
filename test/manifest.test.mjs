import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8')
);
const webpackConfig = require('../webpack.config.js');

test('Disney+ installs the history hook in the page MAIN world before the content bundle', () => {
  const historyHook = manifest.content_scripts.find(
    (entry) =>
      entry.matches?.includes('https://www.disneyplus.com/*') &&
      entry.js?.includes('src/util/history_change.js')
  );

  assert.ok(historyHook);
  assert.equal(historyHook.world, 'MAIN');
  assert.equal(historyHook.run_at, 'document_start');

  const disneyBundle = manifest.content_scripts.find((entry) =>
    entry.js?.includes('dist/content_disney.js')
  );
  assert.ok(disneyBundle);
  assert.equal(disneyBundle.run_at, 'document_idle');
});

test('Netflix does not install a duplicate isolated-world history hook', () => {
  const netflixBootstrap = manifest.content_scripts.find(
    (entry) =>
      entry.matches?.includes('https://www.netflix.com/*') &&
      entry.js?.includes('src/inject/inject_script.js')
  );

  assert.ok(netflixBootstrap);
  assert.equal(netflixBootstrap.run_at, 'document_end');
  assert.deepEqual(netflixBootstrap.js, ['src/inject/inject_script.js']);
});

test('manifest references every webpack bundle and no unbundled localhost bridge source', () => {
  const manifestBundles = new Set([
    manifest.background?.service_worker,
    ...manifest.content_scripts.flatMap((entry) => entry.js || []),
  ].filter((path) => typeof path === 'string' && path.startsWith('dist/')));
  const webpackBundles = new Set(
    Object.keys(webpackConfig.entry).map((name) => `dist/${name}.js`)
  );

  assert.deepEqual(manifestBundles, webpackBundles);
  assert.equal(
    manifest.content_scripts.some((entry) =>
      entry.js?.includes('src/content/getClipData.js')
    ),
    false
  );
});

test('manifest permissions and exposed resources stay within the reviewed boundary', () => {
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ['activeTab', 'alarms', 'scripting', 'storage', 'tabs']
  );
  assert.deepEqual(
    [...manifest.host_permissions].sort(),
    [
      'http://127.0.0.1:3000/*',
      'http://localhost:3000/*',
      'https://www.disneyplus.com/*',
      'https://www.netflix.com/*',
    ]
  );
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      matches: ['https://www.netflix.com/*'],
      resources: ['src/util/history_change.js'],
    },
  ]);
});
