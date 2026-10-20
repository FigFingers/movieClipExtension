// movie-clipper-mock/harness: ブラウザー（Playwright）を動かす道具。
export { SITE_ORIGIN, launchExtensionBrowser, prepareExtension, routeFakeServices } from './browser.js';

/** 擬似の配信サービスの URL。 */
export const fakeUrls = Object.freeze({
  netflixWatch: (id, { t } = {}) => `https://www.netflix.com/watch/${id}${t !== undefined ? `?t=${t}` : ''}`,
  netflixBrowse: () => 'https://www.netflix.com/browse',
  disneyPlay: (id, { t } = {}) => `https://www.disneyplus.com/ja-jp/play/${id}${t !== undefined ? `?t=${t}` : ''}`,
  disneyHome: () => 'https://www.disneyplus.com/ja-jp',
});

/**
 * 擬似ページの状態（window.__fake）を読む。
 * service・titleId・media（file / url / test-video / audio-only）・seeks・directSeeks・events と、
 * 再生位置（time、Disney+ は作品の時刻 content も）を返す。
 * @param {import('playwright').Page} page
 */
export function readFakePlayer(page) {
  return page.evaluate(() => {
    const fake = window.__fake;
    const video = document.querySelector('#hivePlayer1') || document.querySelector('video');
    return JSON.parse(JSON.stringify({
      service: fake?.service ?? null,
      titleId: fake?.titleId ?? null,
      media: fake?.media ?? null,
      mediaError: fake?.mediaError ?? null,
      apiReady: fake?.apiReady ?? null,
      seeks: fake?.seeks ?? [],
      directSeeks: fake?.directSeeks ?? [],
      events: fake?.events ?? [],
      time: video?.currentTime ?? null,
      content: typeof fake?.contentTime === 'function' ? fake.contentTime() : null,
      paused: video?.paused ?? null,
      videoWidth: video?.videoWidth ?? 0,
      videoHeight: video?.videoHeight ?? 0,
      url: location.href,
    }));
  });
}

/**
 * 擬似ページの動画が再生できる状態になるまで待つ（Netflix はプレイヤー API の準備も待つ）。
 * @param {import('playwright').Page} page
 */
export async function waitForFakePlayer(page, { timeout = 20_000 } = {}) {
  await page.waitForFunction(() => {
    const fake = window.__fake;
    const video = document.querySelector('#hivePlayer1') || document.querySelector('video');
    if (!fake?.titleId || !video || video.readyState < 1) return false;
    return fake.service === 'disney' || fake.apiReady === true;
  }, null, { timeout });
}
