// モックの状態。すべてメモリに置き、reset で初期データに戻す。
import { randomBytes, randomUUID } from 'node:crypto';
import { defaultCatalog } from './fake-services/catalog.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function defaultSettings() {
  return {
    // サイトの EXTENSION_AUTH_TOKEN_TTL_MS（90 日）と LINK_TOKEN_TTL_MS（10 分）。
    authTokenTtlMs: 90 * DAY_MS,
    linkTokenTtlMs: 10 * 60 * 1000,
    // サイトの CLIP_API_ALLOWED_ORIGINS に当たる。Origin の無い要求は常に通す（サイトと同じ）。
    allowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000', 'chrome-extension://*'],
    // 400 の本文の形。
    //   site-dev:      開発時のサイト。details に Zod の flatten()（項目の clientItemId は含まない）
    //   site-prod:     本番のサイト。details を返さない
    //   invalid-items: Design Doc §7.4 の提案。invalidItems に項目ごとの clientItemId を返す
    validationErrorFormat: 'site-dev',
    // 同じ extensionInstanceId で別の利用者が連携したとき、連携先を付け替える（サイトの現行動作、G-08）。
    relinkReassignsUser: true,
    commentRateLimitPerMinute: 30,
    fake: {
      // 擬似ページの CSP。strict は script を自分のオリジンだけにする。strict-style は style も同様に絞る。
      csp: 'strict',
      netflix: {
        controlsAutoHide: true,
        controlsHideMs: 3000,
        honorStartParam: true,
        playerApiDelayMs: 800,
        seekLatencyMs: 150,
        // video.currentTime を直接書き換えると、本物と同じくエラー表示にする。
        strictSeek: true,
        autoplay: true,
        // 動画を再生するとき、右上に再生位置を出す。本物に近い見た目にしたいときは false。
        hud: true,
      },
      disney: {
        // video.currentTime と作品の時刻（進行バーの aria-valuenow）のずれ。本物は MSE のため 0 にならない。
        timelineOffsetSeconds: 7.5,
        honorStartParam: false,
        controlsAutoHide: true,
        controlsHideMs: 3000,
        autoplay: true,
        hud: true,
      },
    },
  };
}

export function opaqueToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * サイトのモックの初期データ。カタログの作品から作る（作品が足りなければ、その分は作らない）。
 * 既定のカタログでは、クリップの ID は 1〜6 の順になる（ハーネスのシナリオがこの ID を使う）。
 */
function seedSite(catalog, now) {
  const netflix = catalog.netflix.titles;
  const disney = catalog.disney.titles;
  // サイトの DB は URL を相対パスと完全な URL の両方で持つ（src/lib/clips/playback.ts）。両方を入れる。
  const templates = [
    ['n0a', netflix[0], (t) => ({ userId: 2, vodId: 1, name: '冒頭の信号音', title: t.series, startMs: 30_500, endMs: 38_200, url: `/watch/${t.id}`, epnum: t.episodeNumber || null })],
    ['n0b', netflix[0], (t) => ({ userId: 2, vodId: 1, name: '静かな交信', title: t.series, startMs: 95_000, endMs: 101_000, url: `https://www.netflix.com/watch/${t.id}`, epnum: t.episodeNumber || null })],
    ['n1', netflix[1], (t) => ({ userId: 1, vodId: 1, name: '二つ目の周波数の始まり', title: t.series, startMs: 12_000, endMs: 18_000, url: `/watch/${t.id}`, epnum: t.episodeNumber || null })],
    ['n2', netflix[2], (t) => ({ userId: 2, vodId: 1, name: '夜のテストパターン', title: t.series, startMs: 60_000, endMs: 66_000, url: `/watch/${t.id}`, epnum: t.episodeNumber || null })],
    ['d0', disney[0], (t) => ({ userId: 2, vodId: 2, name: '鏡の森の入口', title: t.title, startMs: 20_000, endMs: 26_000, url: `https://www.disneyplus.com/ja-jp/play/${t.id}`, epnum: t.subtitle || null })],
    ['d1', disney[1], (t) => ({ userId: 1, vodId: 2, name: 'モックの旅立ち', title: t.title, startMs: 40_000, endMs: 45_000, url: `/ja-jp/play/${t.id}`, epnum: t.subtitle || null })],
  ].filter(([, title]) => title);
  const ids = {};
  const clips = templates.map(([key, title, build], index) => {
    ids[key] = index + 1;
    const at = new Date(now - (templates.length - index) * 60_000).toISOString();
    return { id: index + 1, ...build(title), views: 0, createdAt: at, updatedAt: at, deletedAt: null };
  });

  const comments = [];
  const addComment = (clipId, userId, body, atMs = null) => {
    if (!clipId) return;
    comments.push({
      id: comments.length + 1,
      clipId,
      userId,
      body,
      atMs,
      clientRequestId: null,
      createdAt: new Date(now - (100 - comments.length) * 30_000).toISOString(),
      deletedAt: null,
    });
  };
  addComment(ids.n0a, 2, 'この音が好き');
  addComment(ids.n0a, 1, 'ここから雰囲気が変わる', 33_000);
  addComment(ids.n0a, 2, '何度も見てしまう');
  // 20 件を超えるコメントで、拡張のページ送り（cursor）を確かめる。
  for (let index = 1; index <= 25; index += 1) {
    addComment(ids.n1, index % 2 === 0 ? 1 : 2, `ページ送りの確認用コメント ${index}`);
  }

  const playlists = [
    ['同じ作品の中で進む', ['n0a', 'n0b']],
    ['作品をまたぐ（Netflix）', ['n0a', 'n1', 'n2']],
    ['サービスをまたぐ（Netflix → Disney+）', ['n1', 'd0', 'n0a']],
  ]
    .map(([name, keys]) => ({ name, clipIds: keys.map((key) => ids[key]).filter(Boolean) }))
    .filter((playlist) => playlist.clipIds.length >= 2)
    .map((playlist, index) => ({ id: index + 1, userId: 1, ...playlist }));
  return { clips, comments, playlists };
}

export function createInitialState({ seed = 'default', now = Date.now(), catalog = defaultCatalog() } = {}) {
  const empty = seed === 'empty';
  const { clips, comments, playlists } = empty ? { clips: [], comments: [], playlists: [] } : seedSite(catalog, now);
  return {
    /** 擬似の配信サービスの作品（fake-services/catalog.js で正規化したもの） */
    catalog,
    users: [
      { id: 1, name: 'みかん', email: 'mikan@example.test', deletedAt: null },
      { id: 2, name: 'りんご', email: 'ringo@example.test', deletedAt: null },
    ],
    vods: [
      { id: 1, code: 'NETFLIX', name: 'Netflix', aliases: [] },
      { id: 2, code: 'DISNEY_PLUS', name: 'Disney+', aliases: ['DisneyPlus'] },
      { id: 3, code: 'PRIME_VIDEO', name: 'Prime Video', aliases: ['prime'] },
    ],
    clips,
    comments,
    playlists,
    /** session id → userId */
    sessions: {},
    linkTokens: [],
    linkedExtensions: [],
    /** `${linkedExtensionId}:${clientItemId}` */
    syncReceipts: [],
    faults: [],
    settings: defaultSettings(),
    requests: [],
    nextIds: {
      clip: clips.length + 1,
      comment: comments.length + 1,
      linkedExtension: 1,
      fault: 1,
      request: 1,
    },
  };
}

export const MAX_REQUEST_LOG = 500;

export function createStore(options = {}) {
  let state = createInitialState(options);

  const store = {
    get state() {
      return state;
    },
    reset(resetOptions = {}) {
      const keepSettings = resetOptions.keepSettings === true ? state.settings : null;
      // カタログは差し替えたものを引き継ぐ（初期データだけを作り直す）。
      state = createInitialState({ ...options, ...resetOptions, catalog: resetOptions.catalog ?? state.catalog });
      if (keepSettings) state.settings = keepSettings;
      return state;
    },
    nextId(kind) {
      const id = state.nextIds[kind];
      state.nextIds[kind] += 1;
      return id;
    },
    findUser(id) {
      return state.users.find((user) => user.id === Number(id) && user.deletedAt === null) || null;
    },
    sessionUser(sessionId) {
      if (!sessionId) return null;
      const userId = state.sessions[sessionId];
      return userId ? store.findUser(userId) : null;
    },
    createSession(userId) {
      const sessionId = randomUUID();
      state.sessions[sessionId] = Number(userId);
      return sessionId;
    },
    endSession(sessionId) {
      delete state.sessions[sessionId];
    },
    findVodByLookup(value) {
      const query = String(value ?? '').trim().toLowerCase();
      if (!query) return null;
      return state.vods.find((vod) =>
        vod.code.toLowerCase() === query
        || vod.name.toLowerCase() === query
        || vod.aliases.some((alias) => alias.toLowerCase() === query)) || null;
    },
    findVod(id) {
      return state.vods.find((vod) => vod.id === Number(id)) || null;
    },
    findClip(id) {
      return state.clips.find((clip) => clip.id === Number(id) && clip.deletedAt === null) || null;
    },
    logRequest(entry) {
      const record = { id: store.nextId('request'), at: new Date().toISOString(), ...entry };
      state.requests.push(record);
      if (state.requests.length > MAX_REQUEST_LOG) {
        state.requests.splice(0, state.requests.length - MAX_REQUEST_LOG);
      }
      return record;
    },
  };
  return store;
}

/** 設定の一部を深くマージする。未知のキーは無視する。 */
export function mergeSettings(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return current;
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(current, key)) continue;
    const base = current[key];
    if (base && typeof base === 'object' && !Array.isArray(base) && value && typeof value === 'object' && !Array.isArray(value)) {
      next[key] = mergeSettings(base, value);
    } else {
      next[key] = value;
    }
  }
  return next;
}
