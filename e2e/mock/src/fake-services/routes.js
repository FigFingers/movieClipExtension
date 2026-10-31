// 擬似の配信サービスの画面と動画。
//
// ハーネスは https://www.netflix.com/* と https://www.disneyplus.com/* への要求を、ここ（モックのパス）へ回す。
//   /__fake/netflix/<パス>  /__fake/disney/<パス>  画面（どのパスでも同じ HTML。振り分けはページが行う）
//   /__fake-assets/<名前>                         画面のスクリプトとスタイル
//   /__fake-media/<サービス>/<作品の id>           作品の動画（Range 付き）
// モックのオリジンで直接開けば（http://127.0.0.1:<ポート>/__fake/netflix/watch/81000001 など）、拡張なしで見た目を確かめられる。
import { findTitle, publicCatalog } from './catalog.js';
import { sendMediaFile } from './media.js';
import { findTestVideo } from './pattern-video.js';
import { jsonForScript, redirect, sendHtml, sendText } from '../http.js';

export const FAKE_SERVICE_HOSTS = Object.freeze({
  'www.netflix.com': 'netflix',
  'www.disneyplus.com': 'disney',
});

/** カタログで https の動画を指定した作品の配信元。CSP の media-src に足す。 */
function remoteMediaOrigins(catalog) {
  const origins = new Set();
  for (const service of Object.values(catalog)) {
    for (const title of service.titles) {
      if (title.video?.kind === 'url') origins.add(new URL(title.video.url).origin);
    }
  }
  return [...origins];
}

function cspHeader(mode, catalog) {
  if (mode === 'off') return {};
  const style = mode === 'strict-style' ? "style-src 'self'" : "style-src 'self' 'unsafe-inline'";
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      style,
      "img-src 'self' data: blob:",
      ["media-src 'self' blob:", ...remoteMediaOrigins(catalog)].join(' '),
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; '),
  };
}

function shell(service, state) {
  const title = service === 'netflix' ? 'Netflix（モック）' : 'Disney+（モック）';
  const catalog = publicCatalog(state.catalog, findTestVideo);
  const fakeSettings = { netflix: state.settings.fake.netflix, disney: state.settings.fake.disney };
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/__fake-assets/fake.css">
</head>
<body class="fake-${service}">
<div id="appMountPoint"></div>
<script type="application/json" id="fake-catalog">${jsonForScript(catalog)}</script>
<script type="application/json" id="fake-settings">${jsonForScript(fakeSettings)}</script>
<script src="/__fake-assets/${service}.js"></script>
</body>
</html>`;
}

async function sendMedia(ctx, service, id) {
  const title = findTitle(ctx.store.state.catalog, service, decodeURIComponent(id));
  if (!title) {
    sendText(ctx.res, 404, `title not found: ${service}/${id}`);
    return;
  }
  if (title.video?.kind === 'url') {
    redirect(ctx.res, title.video.url);
    return;
  }
  if (title.video?.kind === 'file') {
    await sendMediaFile(ctx.req, ctx.res, title.video.path, title.video.type);
    return;
  }
  const testVideo = findTestVideo(title.durationSeconds);
  if (testVideo) {
    await sendMediaFile(ctx.req, ctx.res, testVideo, 'video/webm');
    return;
  }
  sendText(ctx.res, 404, 'no media for this title (ensureTestVideos で作るか、カタログで video を指定してください)');
}

export async function handleFakeServices(ctx) {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return false;
  const media = /^\/__fake-media\/(netflix|disney)\/([^/]+)$/.exec(ctx.url.pathname);
  if (media) {
    await sendMedia(ctx, media[1], media[2]);
    return true;
  }
  const page = /^\/__fake\/(netflix|disney)(?:\/|$)/.exec(ctx.url.pathname);
  if (!page) return false;
  const { state } = ctx.store;
  sendHtml(ctx.res, 200, shell(page[1], state), cspHeader(state.settings.fake.csp, state.catalog));
  return true;
}

/** 擬似サービスのオリジンへの要求を、モックのパスに置き換える（ハーネスの route と、デスクトップ版の中継で使う）。 */
export function fakeServicePath(serviceUrl) {
  const url = new URL(serviceUrl);
  const service = FAKE_SERVICE_HOSTS[url.hostname];
  if (!service) return null;
  if (url.pathname.startsWith('/__fake-assets/') || url.pathname.startsWith('/__fake-media/')) return `${url.pathname}${url.search}`;
  return `/__fake/${service}${url.pathname}${url.search}`;
}
