// ハーネスの共通の引数。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCatalog, loadCatalogFile, withVideoForAll } from '../src/fake-services/catalog.js';
import { ensureTestVideos } from '../src/fake-services/test-video.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 拡張のフォルダー。--extension、環境変数 MOVIE_CLIPPER_EXTENSION_DIR、隣の movieClipExtension の順に探す。
 */
export function resolveExtensionDir(value) {
  return path.resolve(value || process.env.MOVIE_CLIPPER_EXTENSION_DIR || path.join(ROOT, '..', 'movieClipExtension'));
}

/**
 * 擬似の配信サービスのカタログを決め、動画を指定していない作品のテスト用の動画を用意する。
 * @param {{ catalog?: string, video?: string, makeVideo?: boolean, log?: (line: string) => void }} options
 */
export async function prepareCatalog({ catalog, video, makeVideo = true, log = console.log } = {}) {
  let result = catalog ? await loadCatalogFile(catalog) : defaultCatalog();
  if (video) result = withVideoForAll(result, video);
  if (makeVideo) await ensureTestVideos(result, { log });
  return result;
}
