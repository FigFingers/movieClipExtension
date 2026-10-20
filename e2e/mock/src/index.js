// movie-clipper-mock の公開 API（サーバー・カタログ・テスト用の動画）。
// ブラウザーを動かす道具は movie-clipper-mock/harness にある。
export { createMockServer } from './server.js';
export {
  CatalogError,
  DEFAULT_DURATION_SECONDS,
  defaultCatalog,
  defaultCatalogInput,
  findTitle,
  loadCatalogFile,
  normalizeCatalog,
  withVideoForAll,
} from './fake-services/catalog.js';
export {
  TEST_VIDEO,
  ensureTestVideos,
  findTestVideo,
  generateTestVideo,
  testVideoPath,
} from './fake-services/pattern-video.js';
export { FAKE_SERVICE_HOSTS, fakeServicePath } from './fake-services/routes.js';
