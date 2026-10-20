// 擬似の配信サービスで見せる作品の一覧（カタログ）。
//
// 作品ごとに動画を指定できる。指定が無い作品は、テスト用の動画（pattern-video.js が作る、
// 時刻を焼き込んだ WebM）を使い、それも無ければ無音の音声だけで再生する（ページが作る）。
//
// カタログの JSON（例は examples/catalog.example.json）:
//   {
//     "netflix": { "titles": [{ "id": "81000001", "series": "作品名", "episodeNumber": "S1:E1",
//                               "episodeTitle": "話の名前", "video": "./videos/ep1.webm", "nextId": "81000002" }] },
//     "disney":  { "titles": [{ "id": "5f0c…", "title": "作品名", "subtitle": "S1:E1 話の名前",
//                               "video": "https://example.com/movie.webm" }] }
//   }
// video は、カタログのファイルからの相対パス、絶対パス、https の URL のどれか。
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';

export const SERVICES = Object.freeze(['netflix', 'disney']);
/** 動画を指定しない作品の長さ。テスト用の動画もこの長さで作る。 */
export const DEFAULT_DURATION_SECONDS = 300;

const MEDIA_TYPES = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
};

export class CatalogError extends Error {}

/** 既定のカタログ。作品名はすべて架空。サイトのモックの初期データもこの ID を使う。 */
export function defaultCatalogInput() {
  return {
    netflix: {
      titles: [
        { id: '81000001', series: 'モック・ステーション', episodeNumber: 'S1:E1', episodeTitle: '最初の信号', nextId: '81000002' },
        { id: '81000002', series: 'モック・ステーション', episodeNumber: 'S1:E2', episodeTitle: '二つ目の周波数' },
        { id: '81000003', series: 'テスト・パターンの夜' },
      ],
    },
    disney: {
      titles: [
        { id: '5f0c0001-0000-4000-8000-000000000001', title: '魔法のテストランド', subtitle: 'S1:E1 鏡の森' },
        { id: '5f0c0001-0000-4000-8000-000000000002', title: 'ちいさなモックの冒険' },
      ],
    },
  };
}

export function defaultCatalog() {
  return normalizeCatalog(defaultCatalogInput());
}

function text(value, field, where, { required = false, max = 500 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new CatalogError(`${where}: ${field} が必要です`);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw new CatalogError(`${where}: ${field} は文字列にしてください`);
  const result = String(value).trim();
  if (result.length > max) throw new CatalogError(`${where}: ${field} が長すぎます（${max} 文字まで）`);
  return result;
}

function mediaTypeOf(name) {
  return MEDIA_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

/** video の指定を { kind: 'file' | 'url', … } にする。ファイルは在ることを確かめる。 */
export function normalizeVideo(value, where, baseDir = process.cwd()) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new CatalogError(`${where}: video は文字列にしてください`);
  if (/^https:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new CatalogError(`${where}: video の URL が正しくありません: ${value}`);
    }
    return { kind: 'url', url: url.href, type: mediaTypeOf(url.pathname) };
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    // http の動画は https の視聴ページから読めない（混在コンテンツ）。ローカルに置くか https にする。
    throw new CatalogError(`${where}: video は https の URL かファイルのパスにしてください: ${value}`);
  }
  const file = path.resolve(baseDir, value);
  let info;
  try {
    info = statSync(file);
  } catch {
    throw new CatalogError(`${where}: 動画のファイルが見つかりません: ${file}`);
  }
  if (!info.isFile()) throw new CatalogError(`${where}: 動画のパスがファイルではありません: ${file}`);
  return { kind: 'file', path: file, size: info.size, type: mediaTypeOf(file) };
}

function duration(value, where) {
  if (value === undefined || value === null) return DEFAULT_DURATION_SECONDS;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 5 || number > 6 * 60 * 60) {
    throw new CatalogError(`${where}: durationSeconds は 5〜21600 の秒数にしてください`);
  }
  return Math.ceil(number);
}

function normalizeNetflixTitle(raw, index, baseDir) {
  const where = `netflix.titles[${index}]`;
  if (!raw || typeof raw !== 'object') throw new CatalogError(`${where}: 作品はオブジェクトにしてください`);
  const id = text(raw.id, 'id', where, { required: true, max: 20 });
  if (!/^\d+$/.test(id)) throw new CatalogError(`${where}: Netflix の id は数字だけにしてください（URL の /watch/<id>）`);
  const episodeNumber = text(raw.episodeNumber, 'episodeNumber', where, { max: 50 });
  return {
    id,
    // episodeNumber があれば話（作品名とエピソードが分かれた表示）、無ければ映画として描く。
    kind: raw.kind === 'movie' || raw.kind === 'episode' ? raw.kind : (episodeNumber ? 'episode' : 'movie'),
    series: text(raw.series, 'series', where, { required: true }),
    episodeNumber,
    episodeTitle: text(raw.episodeTitle, 'episodeTitle', where),
    durationSeconds: duration(raw.durationSeconds, where),
    nextId: text(raw.nextId, 'nextId', where, { max: 20 }) || null,
    video: normalizeVideo(raw.video, where, baseDir),
  };
}

function normalizeDisneyTitle(raw, index, baseDir) {
  const where = `disney.titles[${index}]`;
  if (!raw || typeof raw !== 'object') throw new CatalogError(`${where}: 作品はオブジェクトにしてください`);
  const id = text(raw.id, 'id', where, { required: true, max: 100 });
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new CatalogError(`${where}: Disney+ の id は英数字とハイフンだけにしてください（URL の /play/<id>）`);
  return {
    id,
    title: text(raw.title, 'title', where, { required: true }),
    subtitle: text(raw.subtitle, 'subtitle', where),
    durationSeconds: duration(raw.durationSeconds, where),
    video: normalizeVideo(raw.video, where, baseDir),
  };
}

/**
 * カタログを検証して正規化する。サービスを省くと、そのサービスの作品は無しになる。
 * 正規化したもの（video がオブジェクト）を渡しても、そのまま通す。
 * @param {unknown} raw
 * @param {{ baseDir?: string }} [options] video の相対パスの基準
 */
export function normalizeCatalog(raw, { baseDir = process.cwd() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CatalogError('カタログはオブジェクトにしてください');
  const unknown = Object.keys(raw).filter((key) => !SERVICES.includes(key));
  if (unknown.length) throw new CatalogError(`知らないサービスです: ${unknown.join(', ')}（netflix・disney）`);
  const catalog = {};
  for (const service of SERVICES) {
    const titles = raw[service]?.titles ?? [];
    if (!Array.isArray(titles)) throw new CatalogError(`${service}.titles は配列にしてください`);
    const normalize = service === 'netflix' ? normalizeNetflixTitle : normalizeDisneyTitle;
    const list = titles.map((title, index) => {
      // 正規化済みの video（オブジェクト）は検証し直さない。
      if (title?.video && typeof title.video === 'object') {
        return { ...normalize({ ...title, video: undefined }, index, baseDir), video: title.video };
      }
      return normalize(title, index, baseDir);
    });
    const ids = new Set();
    for (const title of list) {
      if (ids.has(title.id)) throw new CatalogError(`${service}: id が重複しています: ${title.id}`);
      ids.add(title.id);
    }
    catalog[service] = { titles: list };
  }
  for (const title of catalog.netflix.titles) {
    if (title.nextId && !catalog.netflix.titles.some((other) => other.id === title.nextId)) {
      throw new CatalogError(`netflix: nextId の作品がありません: ${title.nextId}`);
    }
  }
  return catalog;
}

/** JSON のファイルからカタログを読む。video の相対パスはファイルの場所から解決する。 */
export async function loadCatalogFile(file) {
  const resolved = path.resolve(file);
  let raw;
  try {
    raw = JSON.parse(await readFile(resolved, 'utf8'));
  } catch (error) {
    throw new CatalogError(`カタログを読めません: ${resolved}（${error.message}）`);
  }
  return normalizeCatalog(raw, { baseDir: path.dirname(resolved) });
}

/** すべての作品の動画を 1 つのファイル（または URL）にする（--video）。 */
export function withVideoForAll(catalog, video, { baseDir = process.cwd() } = {}) {
  const normalized = normalizeVideo(video, '--video', baseDir);
  const result = {};
  for (const service of SERVICES) {
    result[service] = { titles: catalog[service].titles.map((title) => ({ ...title, video: normalized })) };
  }
  return result;
}

export function findTitle(catalog, service, id) {
  return catalog?.[service]?.titles.find((title) => title.id === String(id)) || null;
}

/**
 * ページに渡す形。ファイルのパスは出さず、配信用の URL（/__fake-media/…）にする。
 * @param {(durationSeconds: number) => string | null} findTestVideo テスト用の動画のパス（無ければ null）
 */
export function publicCatalog(catalog, findTestVideo = () => null) {
  const result = {};
  for (const service of SERVICES) {
    result[service] = catalog[service].titles.map((title) => {
      const { video, ...rest } = title;
      let mediaUrl = null;
      let media = 'audio-only';
      if (video?.kind === 'url') {
        mediaUrl = video.url;
        media = 'url';
      } else if (video?.kind === 'file') {
        mediaUrl = `/__fake-media/${service}/${encodeURIComponent(title.id)}`;
        media = 'file';
      } else if (findTestVideo(title.durationSeconds)) {
        mediaUrl = `/__fake-media/${service}/${encodeURIComponent(title.id)}`;
        media = 'test-video';
      }
      return { ...rest, mediaUrl, media };
    });
  }
  return result;
}
