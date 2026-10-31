// サイト（react--site）の画面のモック。拡張と関わる部分だけを、サイトと同じ手順で作る。
// 画面のスクリプトは src/public/site.js（サイトの src/lib/extension/client.ts などの写し）。
import { HttpError, escapeHtml, jsonForScript, readBody, redirect, sendHtml } from '../http.js';
import { clipView, listClips } from './v1-api.js';
import { clearSessionCookie, sessionCookie } from './session.js';

const NAV = [
  ['/', 'ホーム'],
  ['/my_video', 'マイビデオ'],
  ['/playlists', 'プレイリスト'],
  ['/account', '拡張の連携'],
  ['/__mock', 'モック管理'],
];

function layout(ctx, { title, body, data = {}, scripts = ['site.js'] }) {
  const user = ctx.sessionUser;
  const nav = NAV.map(([href, label]) => {
    const current = ctx.url.pathname === href ? ' aria-current="page"' : '';
    return `<a href="${href}"${current}>${escapeHtml(label)}</a>`;
  }).join('');
  const account = user
    ? `<span class="who">${escapeHtml(user.name)} でログイン中</span><form method="post" action="/logout"><button type="submit" class="link">ログアウト</button></form>`
    : `<a class="button small" href="/login">ログイン</a>`;
  const pageData = {
    user: user ? { id: user.id, name: user.name } : null,
    ...data,
  };
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Movie Clipper（モック）</title>
<link rel="stylesheet" href="/__mock-assets/site.css">
</head>
<body>
<header class="site-header">
  <a class="brand" href="/">Movie Clipper <span class="badge">MOCK</span></a>
  <nav>${nav}</nav>
  <div class="account">${account}</div>
</header>
<div class="ext-status" id="ext-status" role="status">拡張: 確認中…</div>
<main>
${body}
</main>
<div class="toasts" id="toasts" aria-live="polite"></div>
<script type="application/json" id="page-data">${jsonForScript(pageData)}</script>
${scripts.map((name) => `<script type="module" src="/__mock-assets/${name}"></script>`).join('\n')}
</body>
</html>`;
}

function formatSeconds(ms) {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/** サイトのクリップカードが openClipPlayback に渡す値（src/lib/clips/playback.ts の ClipPlayback）。 */
function playbackData(view) {
  return {
    id: view.id,
    name: view.name,
    title: view.title,
    username: view.user?.name ?? '',
    service: view.vod?.code ?? '',
    url: view.url,
    starttime: view.startMs / 1000,
    endtime: view.endMs / 1000,
    epnumber: view.epnum,
  };
}

function clipCards(views, { emptyText }) {
  if (views.length === 0) return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  return `<ul class="clips">${views.map((view) => `
  <li class="clip" data-clip-id="${view.id}">
    <div class="clip-head">
      <span class="service">${escapeHtml(view.vod?.name ?? '?')}</span>
      <strong class="clip-name">${escapeHtml(view.name)}</strong>
    </div>
    <div class="clip-meta">${escapeHtml(view.title)}${view.epnum ? `（${escapeHtml(view.epnum)}）` : ''} · ${formatSeconds(view.startMs)}–${formatSeconds(view.endMs)} · ${escapeHtml(view.user?.name ?? '不明')}</div>
    <div class="clip-url">${escapeHtml(view.url)}</div>
    <div class="clip-actions">
      <button type="button" data-action="watch" data-clip-id="${view.id}" title="サイトの現行の方式。window.open で新しいタブを開き、Cookie と clipSelected で拡張に渡す">観る</button>
      <button type="button" class="secondary" data-action="watch-same-tab" data-clip-id="${view.id}" title="SET_CLIP_DATA で拡張に渡し、結果を待ってから同じタブで移動する">観る（同じタブ・SET_CLIP_DATA）</button>
    </div>
  </li>`).join('')}</ul>`;
}

function homePage(ctx) {
  const reason = ctx.url.searchParams.get('reason');
  const welcome = reason === 'install' || reason === 'update'
    ? `<section class="notice" data-testid="welcome">
        <h2>${reason === 'install' ? '拡張機能をインストールしました' : '拡張機能を更新しました'}</h2>
        <p>拡張が開いた案内ページです（${escapeHtml(ctx.url.search)}）。記録をサイトに保存するには、<a href="/account">拡張の連携</a>から連携してください。</p>
      </section>`
    : '';
  const { data } = listClips(ctx.store, { limit: 50 });
  return layout(ctx, {
    title: 'ホーム',
    data: { clips: data.map(playbackData) },
    body: `${welcome}
<section>
  <h1>新着のクリップ</h1>
  <p class="hint">「観る」はサイトと同じく <code>window.open</code> で新しいタブを開き、Cookie と <code>clipSelected</code> イベントで拡張に区間を渡します。開けなかったときは、サイトと同じく何も渡しません。</p>
  ${clipCards(data, { emptyText: 'クリップはまだありません。' })}
</section>
<section>
  <h2>引き継ぎの結果</h2>
  <ol class="log" id="handoff-log" data-testid="handoff-log"></ol>
</section>`,
  });
}

function loginPage(ctx) {
  const callbackUrl = ctx.url.searchParams.get('callbackUrl') || '/account';
  const users = ctx.store.state.users.filter((user) => user.deletedAt === null);
  return layout(ctx, {
    title: 'ログイン',
    scripts: ['site.js'],
    body: `<section class="narrow">
  <h1>ログイン</h1>
  <p class="hint">本物のサイトは Google のログインだけです。モックでは利用者を選ぶとログインします。</p>
  ${users.map((user) => `<form method="post" action="/login/as/${user.id}">
    <input type="hidden" name="callbackUrl" value="${escapeHtml(callbackUrl)}">
    <button type="submit" class="google" data-testid="login-as-${user.id}">Google でログイン（${escapeHtml(user.name)}）</button>
  </form>`).join('')}
</section>`,
  });
}

function linkedRows(ctx) {
  const user = ctx.sessionUser;
  const rows = ctx.store.state.linkedExtensions.filter((entry) => entry.userId === user.id && entry.revokedAt === null);
  if (rows.length === 0) return '<p class="empty" data-testid="no-linked">連携している拡張はありません。</p>';
  return `<table class="table" data-testid="linked-table">
  <thead><tr><th>ID</th><th>extensionInstanceId</th><th>連携</th><th>最終利用</th><th>有効期限</th><th></th></tr></thead>
  <tbody>${rows.map((entry) => `<tr>
    <td>${entry.id}</td>
    <td><code>${escapeHtml(entry.extensionInstanceId)}</code></td>
    <td>${escapeHtml(entry.linkedAt)}</td>
    <td>${escapeHtml(entry.lastSeenAt)}</td>
    <td>${escapeHtml(entry.expiresAt)}</td>
    <td><button type="button" class="secondary" data-action="unlink" data-linked-id="${entry.id}" data-instance-id="${escapeHtml(entry.extensionInstanceId)}">解除</button></td>
  </tr>`).join('')}</tbody>
</table>`;
}

function accountPage(ctx) {
  if (!ctx.sessionUser) return redirectToLogin(ctx);
  return layout(ctx, {
    title: '拡張の連携',
    body: `<section>
  <h1>拡張の連携</h1>
  <dl class="facts" id="ext-facts" data-testid="ext-facts">
    <dt>検知フラグ（__CLIP_EXTENSION_PRESENT__）</dt><dd id="fact-present">—</dd>
    <dt>extensionInstanceId（GET_EXTENSION_INSTANCE_ID）</dt><dd id="fact-instance">—</dd>
    <dt>連携状態（EXTENSION_AUTH_STATUS_REQUEST）</dt><dd id="fact-auth">—</dd>
  </dl>
  <p>
    <button type="button" data-action="link" data-testid="link-button">拡張と連携する</button>
    <button type="button" class="secondary" data-action="refresh-facts">状態を読み直す</button>
  </p>
  <p class="hint">連携は利用者の操作のあとだけ行います（サイトの linkExtensionToCurrentUserFromUserAction と同じ）。トークンは <code>EXT_LINK_WITH_AUTH_TOKEN</code> で画面から拡張へ渡ります（G-10）。拡張は結果を返さないため、画面は成功したかを知りません。</p>
  <h2>連携している拡張</h2>
  ${linkedRows(ctx)}
</section>`,
  });
}

function redirectToLogin(ctx) {
  const callbackUrl = `${ctx.url.pathname}${ctx.url.search}`;
  return { redirect: `/login?callbackUrl=${encodeURIComponent(callbackUrl)}` };
}

function myVideoPage(ctx) {
  if (!ctx.sessionUser) return redirectToLogin(ctx);
  const { data } = listClips(ctx.store, { limit: 100, userId: ctx.sessionUser.id });
  return layout(ctx, {
    title: 'マイビデオ',
    data: { clips: data.map(playbackData) },
    body: `<section>
  <h1>マイビデオ</h1>
  <p class="hint">拡張から同期されたクリップもここに出ます。</p>
  ${clipCards(data, { emptyText: '自分のクリップはまだありません。' })}
</section>
<section>
  <h2>引き継ぎの結果</h2>
  <ol class="log" id="handoff-log"></ol>
</section>`,
  });
}

function playlistsPage(ctx) {
  const rows = ctx.store.state.playlists;
  return layout(ctx, {
    title: 'プレイリスト',
    body: `<section>
  <h1>プレイリスト</h1>
  <ul class="plain">${rows.map((playlist) => `<li><a href="/playlists/${playlist.id}">${escapeHtml(playlist.name)}</a>（${playlist.clipIds.length} 件）</li>`).join('')}</ul>
</section>`,
  });
}

/** PlaylistView.tsx が playQueue に入れる形。order は 0 始まりの配列の位置。 */
function playQueueItem(view, index) {
  return {
    id: view.id,
    order: index,
    clipname: view.name,
    title: view.title,
    service: view.vod?.code ?? '',
    Subtitles: view.epnum,
    url: view.url,
    startTime: view.startMs / 1000,
    endTime: view.endMs / 1000,
  };
}

function playlistPage(ctx, id) {
  const playlist = ctx.store.state.playlists.find((entry) => entry.id === Number(id));
  if (!playlist) throw new HttpError(404, 'プレイリストが見つかりません。');
  const views = playlist.clipIds
    .map((clipId) => ctx.store.findClip(clipId))
    .filter(Boolean)
    .map((clip) => clipView(ctx.store, clip));
  return layout(ctx, {
    title: playlist.name,
    data: { playQueue: views.map(playQueueItem), clips: views.map(playbackData) },
    body: `<section>
  <h1>${escapeHtml(playlist.name)}</h1>
  <p><button type="button" data-action="play-playlist" data-testid="play-playlist">▶ プレイリスト再生</button> <span class="hint">${views.length} 件のクリップ</span></p>
  <p class="hint">サイトと同じく <code>localStorage.playQueue</code> に並びを入れ、<code>PLAY_PLAYLIST_START</code> を送ります。視聴ページへの移動は拡張が行います。</p>
  ${clipCards(views, { emptyText: 'クリップがありません。' })}
</section>
<section>
  <h2>引き継ぎの結果</h2>
  <ol class="log" id="handoff-log"></ol>
</section>`,
  });
}

function consolePage(ctx) {
  return layout(ctx, {
    title: 'モック管理',
    scripts: ['site.js', 'console.js'],
    body: `<section>
  <h1>モック管理</h1>
  <p class="hint">状態は 2 秒ごとに読み直します。API は <code>/__mock/api/*</code>（README を参照）。</p>
  <div class="grid">
    <div class="panel">
      <h2>操作</h2>
      <p>
        <button type="button" data-admin="reset">初期データに戻す</button>
        <button type="button" class="secondary" data-admin="reset-empty">空にする</button>
        <button type="button" class="secondary" data-admin="clear-faults">障害をすべて消す</button>
      </p>
      <h3>障害の注入</h3>
      <form id="fault-form" class="form">
        <label>メソッド <select name="method"><option>*</option><option>GET</option><option>POST</option></select></label>
        <label>パス <input name="path" value="/api/extension/sync" required></label>
        <label>種類 <select name="kind"><option>status</option><option>delay</option><option>hang</option><option>malformed</option><option>reset</option></select></label>
        <label>status <input name="status" type="number" value="500"></label>
        <label>delayMs <input name="delayMs" type="number" value="0"></label>
        <label>回数（空は無制限） <input name="times" type="number" value="1"></label>
        <button type="submit">追加</button>
      </form>
      <h3>設定</h3>
      <form id="settings-form" class="form">
        <label>400 の本文 <select name="validationErrorFormat">
          <option value="site-dev">site-dev（flatten のみ）</option>
          <option value="site-prod">site-prod（details なし）</option>
          <option value="invalid-items">invalid-items（Design Doc §7.4 の提案）</option>
        </select></label>
        <label>トークンの有効期間（日） <input name="authTokenTtlDays" type="number" step="0.01"></label>
        <label>許可する Origin（カンマ区切り） <input name="allowedOrigins"></label>
        <label class="check"><input type="checkbox" name="relinkReassignsUser"> 再連携で連携先の利用者を付け替える（G-08）</label>
        <label>擬似ページの CSP <select name="fakeCsp"><option>strict</option><option>strict-style</option><option>off</option></select></label>
        <button type="submit">保存</button>
      </form>
    </div>
    <div class="panel">
      <h2>連携している拡張</h2>
      <div id="linked"></div>
      <h2>障害</h2>
      <div id="faults"></div>
    </div>
  </div>
  <div class="panel">
    <h2>クリップ（新しい順）</h2>
    <div id="clips"></div>
  </div>
  <div class="panel">
    <h2>要求の記録（新しい順）</h2>
    <div id="requests"></div>
  </div>
</section>`,
  });
}

async function readForm(req) {
  const raw = (await readBody(req)).toString('utf8');
  return new URLSearchParams(raw);
}

function safeCallback(value) {
  // 外部への移動に使わせない。
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export async function handlePages(ctx) {
  const { pathname } = ctx.url;
  let result = null;
  try {
    if (ctx.method === 'POST') {
      const loginMatch = /^\/login\/as\/(\d+)$/.exec(pathname);
      if (loginMatch) {
        const form = await readForm(ctx.req);
        const user = ctx.store.findUser(loginMatch[1]);
        if (!user) throw new HttpError(404, '利用者が見つかりません。');
        const sessionId = ctx.store.createSession(user.id);
        redirect(ctx.res, safeCallback(form.get('callbackUrl')), { 'Set-Cookie': sessionCookie(sessionId) });
        return true;
      }
      if (pathname === '/logout') {
        if (ctx.sessionId) ctx.store.endSession(ctx.sessionId);
        redirect(ctx.res, '/', { 'Set-Cookie': clearSessionCookie() });
        return true;
      }
      return false;
    }
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return false;
    if (pathname === '/') result = homePage(ctx);
    else if (pathname === '/login') result = loginPage(ctx);
    else if (pathname === '/account' || pathname === '/extension') result = accountPage(ctx);
    else if (pathname === '/my_video') result = myVideoPage(ctx);
    else if (pathname === '/playlists') result = playlistsPage(ctx);
    else if (/^\/playlists\/\d+$/.test(pathname)) result = playlistPage(ctx, pathname.split('/')[2]);
    else if (pathname === '/__mock' || pathname === '/__mock/') result = consolePage(ctx);
    else if (pathname.startsWith('/next')) result = homePage(ctx);
    else return false;
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    sendHtml(ctx.res, error.status, layout(ctx, { title: 'エラー', body: `<p class="error">${escapeHtml(error.message)}</p>` }));
    return true;
  }
  if (result && typeof result === 'object' && result.redirect) {
    redirect(ctx.res, result.redirect);
    return true;
  }
  sendHtml(ctx.res, 200, result);
  return true;
}
