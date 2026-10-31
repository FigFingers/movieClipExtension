// テスト用の動画（WebM）を作る。ffmpeg は使わず、Playwright の Chromium の WebCodecs で
// 描いた画面を VP8 に、無音を Opus に符号化し、webm-muxer で WebM にまとめる。
//
// 画面にはカラーバー、動く四角、再生位置（mm:ss.f）とフレーム番号、1 秒ごとの赤い印を焼き込む。
// キーフレームは 2 秒ごと（配信サービスのセグメントに近い間隔）で、シークの遅れも再現する。
// 作った動画は .cache/（環境変数 MOVIE_CLIPPER_MOCK_CACHE で変えられる）に置き、次からは使い回す。
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES } from './catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const TEST_VIDEO = Object.freeze({
  width: 640,
  height: 360,
  fps: 10,
  keyframeIntervalSeconds: 2,
  videoBitrate: 250_000,
});

export function testVideoCacheDir() {
  return path.resolve(process.env.MOVIE_CLIPPER_MOCK_CACHE || path.join(ROOT, '.cache'));
}

export function testVideoPath(durationSeconds) {
  const { width, height, fps } = TEST_VIDEO;
  return path.join(testVideoCacheDir(), `test-pattern-${width}x${height}-${fps}fps-${durationSeconds}s.webm`);
}

/** 作ってあればパスを、無ければ null を返す。 */
export function findTestVideo(durationSeconds) {
  const file = testVideoPath(durationSeconds);
  return existsSync(file) ? file : null;
}

/** カタログのうち、動画を指定していない作品に要る長さ。 */
export function requiredTestVideoDurations(catalog) {
  const durations = new Set();
  for (const service of SERVICES) {
    for (const title of catalog[service].titles) {
      if (!title.video) durations.add(title.durationSeconds);
    }
  }
  return [...durations].sort((a, b) => a - b);
}

/**
 * ページの中で動く。外の変数は使えない（Playwright が関数のソースだけを送る）。
 * @returns {Promise<{ frames: number }>}
 */
async function encodeInPage({ durationSeconds, width, height, fps, keyframeIntervalSeconds, videoBitrate }) {
  const { Muxer, StreamTarget } = window.WebMMuxer;
  let writes = Promise.resolve();
  const toBase64 = (bytes) => {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  };
  const target = new StreamTarget({
    onData: (data, position) => {
      const copy = data.slice();
      // 書き込みは順に送る（終わりにヘッダーを書き直すため、順序が入れ替わると壊れる）。
      writes = writes.then(() => window.__writeChunk(toBase64(copy), position));
    },
    chunked: true,
    chunkSize: 2 * 1024 * 1024,
  });
  const muxer = new Muxer({
    target,
    video: { codec: 'V_VP8', width, height, frameRate: fps },
    audio: { codec: 'A_OPUS', numberOfChannels: 1, sampleRate: 48000 },
  });

  let failure = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => { failure = error; },
  });
  const videoConfig = { codec: 'vp8', width, height, bitrate: videoBitrate, framerate: fps };
  if (!(await VideoEncoder.isConfigSupported(videoConfig)).supported) throw new Error('VP8 encoder is not supported');
  videoEncoder.configure(videoConfig);
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (error) => { failure = error; },
  });
  audioEncoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 16000 });

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
  const barHeight = Math.round(height * 0.55);
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  const timecode = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds - minutes * 60;
    return `${pad(minutes)}:${pad(Math.floor(rest))}.${Math.floor((rest % 1) * 10)}`;
  };

  function draw(seconds, index) {
    const barWidth = width / bars.length;
    bars.forEach((color, bar) => {
      context.fillStyle = color;
      context.fillRect(Math.floor(bar * barWidth), 0, Math.ceil(barWidth), barHeight);
    });
    context.fillStyle = '#101418';
    context.fillRect(0, barHeight, width, height - barHeight);
    // 1 秒の中の進み具合
    context.fillStyle = '#ffd400';
    context.fillRect(0, barHeight, width * (seconds % 1), 6);
    // 動く四角（動きで再生中かが分かる）
    const boxX = ((seconds * 90) % (width + 80)) - 80;
    context.fillStyle = '#ffffff';
    context.fillRect(boxX, barHeight + 14, 80, 24);
    context.textAlign = 'center';
    context.fillStyle = '#ffffff';
    context.font = `bold ${Math.round(height * 0.17)}px monospace`;
    context.fillText(timecode(seconds), width / 2, barHeight + Math.round(height * 0.29));
    context.font = `${Math.round(height * 0.05)}px monospace`;
    context.fillText(`frame ${index}  ${seconds.toFixed(1)}s  movie-clipper-mock`, width / 2, barHeight + Math.round(height * 0.38));
    if (index % fps === 0) {
      context.fillStyle = '#ff2d55';
      context.beginPath();
      context.arc(width - 24, 24, 12, 0, Math.PI * 2);
      context.fill();
    }
  }

  const keyEvery = fps * keyframeIntervalSeconds;
  const silence = new Float32Array(48000);
  for (let second = 0; second < durationSeconds; second += 1) {
    for (let frameInSecond = 0; frameInSecond < fps; frameInSecond += 1) {
      const index = second * fps + frameInSecond;
      const seconds = index / fps;
      draw(seconds, index);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(seconds * 1e6), duration: Math.round(1e6 / fps) });
      videoEncoder.encode(frame, { keyFrame: index % keyEvery === 0 });
      frame.close();
    }
    const audio = new AudioData({
      format: 'f32-planar',
      sampleRate: 48000,
      numberOfFrames: 48000,
      numberOfChannels: 1,
      timestamp: second * 1e6,
      data: silence,
    });
    audioEncoder.encode(audio);
    audio.close();
    while (videoEncoder.encodeQueueSize > 30 || audioEncoder.encodeQueueSize > 4) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (failure) throw failure;
    if (second % 15 === 0) window.__progress(second, durationSeconds);
  }
  await videoEncoder.flush();
  await audioEncoder.flush();
  if (failure) throw failure;
  muxer.finalize();
  await writes;
  return { frames: durationSeconds * fps };
}

/**
 * テスト用の動画を作る。
 * @param {{ durationSeconds: number, out?: string, onProgress?: (done: number, total: number) => void }} options
 */
export async function generateTestVideo({ durationSeconds, out = testVideoPath(durationSeconds), onProgress } = {}) {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1) throw new Error('durationSeconds は 1 以上の整数にしてください');
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('テスト用の動画を作るには playwright が必要です（npm ci と npm run test:e2e:install）');
  }
  const require = createRequire(import.meta.url);
  // require の条件で解決すると、ブラウザーで読める build/webm-muxer.js（グローバルの WebMMuxer）になる。
  const muxerScript = require.resolve('webm-muxer');
  mkdirSync(path.dirname(out), { recursive: true });
  const partial = `${out}.partial`;
  let completed = false;
  const browser = await chromium.launch({ channel: 'chromium' });
  let fd;
  try {
    fd = openSync(partial, 'w');
    const page = await browser.newPage();
    // WebCodecs は安全なオリジンでだけ使える。中身の無い https のページを route で返す。
    await page.route('https://test-video.invalid/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>movie-clipper-mock test video</title>',
    }));
    await page.goto('https://test-video.invalid/');
    await page.addScriptTag({ path: muxerScript });
    await page.exposeFunction('__writeChunk', (base64, position) => {
      const buffer = Buffer.from(base64, 'base64');
      writeSync(fd, buffer, 0, buffer.length, position);
    });
    await page.exposeFunction('__progress', (done, total) => onProgress?.(done, total));
    await page.evaluate(encodeInPage, { durationSeconds, ...TEST_VIDEO });
    onProgress?.(durationSeconds, durationSeconds);
    completed = true;
  } finally {
    await browser.close().catch(() => {});
    if (fd !== undefined) closeSync(fd);
    if (!completed) rmSync(partial, { force: true });
  }
  renameSync(partial, out);
  return out;
}

/**
 * カタログに要るテスト用の動画を、無ければ作る。
 * @returns {Promise<string[]>} 新しく作ったファイル
 */
export async function ensureTestVideos(catalog, { log = () => {} } = {}) {
  const created = [];
  for (const durationSeconds of requiredTestVideoDurations(catalog)) {
    if (findTestVideo(durationSeconds)) continue;
    log(`テスト用の動画（${durationSeconds} 秒）を作っています…`);
    const startedAt = Date.now();
    const file = await generateTestVideo({ durationSeconds });
    log(`  ${file}（${((Date.now() - startedAt) / 1000).toFixed(1)} 秒）`);
    created.push(file);
  }
  return created;
}
