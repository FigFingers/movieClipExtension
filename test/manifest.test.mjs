import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8')
);

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
