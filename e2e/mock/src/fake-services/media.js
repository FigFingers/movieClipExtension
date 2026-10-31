// 動画ファイルを Range 付きで返す。シークできるよう、ブラウザーの部分要求（206）に応える。
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/**
 * 終わりを指定しない部分要求（bytes=N-）に返す最大の長さ。ブラウザーは足りない分を続けて要求する。
 * ハーネスの route は応答を丸ごとメモリに載せるため、大きなファイルでも 1 回の応答を小さく保つ。
 */
export const MAX_OPEN_RANGE_BYTES = 4 * 1024 * 1024;

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    // 末尾から N バイト
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? Math.min(size - 1, start + MAX_OPEN_RANGE_BYTES - 1) : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return { invalid: true };
  return { start, end };
}

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
export async function sendMediaFile(req, res, file, contentType) {
  let size;
  try {
    size = (await stat(file)).size;
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('media file not found');
    return;
  }
  const base = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const range = req.headers.range ? parseRange(req.headers.range, size) : null;
  if (range?.invalid) {
    res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` }).end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const headers = {
    ...base,
    'Content-Length': String(end - start + 1),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  };
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
