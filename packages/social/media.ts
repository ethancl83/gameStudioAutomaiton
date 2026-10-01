import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { AppError } from '../domain/errors.js';
import { parseJsonArray } from './helpers.js';
import type { SocialArtifact } from './types.js';

/**
 * Public HTTPS media URLs for Threads IMAGE/VIDEO/CAROUSEL posts.
 * Official: image_url / video_url must be on a public server (Meta cURLs them).
 * https://developers.facebook.com/docs/threads/posts (2026-09-11)
 *
 * Local files, data URIs, and private hosts are rejected. This module never
 * fetches or executes the URL.
 */

const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

export function assertPublicHttpsUrl(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || value.includes('\0')) {
    throw new AppError('INVALID_INPUT', `${label} URL을 확인해 주세요.`);
  }
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new AppError('INVALID_INPUT', `${label}는 올바른 https URL이어야 합니다.`); }
  if (url.protocol !== 'https:') throw new AppError('INVALID_INPUT', `${label}는 https URL만 허용합니다.`);
  if (url.username || url.password || url.hash) throw new AppError('INVALID_INPUT', `${label}에 인증 정보나 fragment를 넣을 수 없습니다.`);
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new AppError('INVALID_INPUT', `${label}는 공개 서버의 https URL이어야 합니다.`);
  }
  if (/^(10\.|192\.168\.|169\.254\.|127\.)/.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
    throw new AppError('INVALID_INPUT', `${label}는 사설 네트워크 주소일 수 없습니다.`);
  }
  return url.toString();
}

export function parseCarouselItems(value: unknown): Array<{ url: string; kind: 'IMAGE' | 'VIDEO' }> {
  if (value === undefined || value === null || value === '') {
    throw new AppError('INVALID_INPUT', '캐러셀 미디어 URL JSON 배열이 필요합니다.');
  }
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); }
    catch { throw new AppError('INVALID_INPUT', '캐러셀은 JSON 배열이어야 합니다. 예: ["https://cdn.example.com/a.jpg","https://cdn.example.com/b.jpg"]'); }
  }
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 20) {
    throw new AppError('INVALID_INPUT', '캐러셀은 공개 https URL 2–20개가 필요합니다.');
  }
  return parsed.map((item, index) => {
    if (typeof item === 'string') {
      const url = assertPublicHttpsUrl(item, `캐러셀 URL ${index + 1}`);
      return { url, kind: /\.(mp4|mov|m4v)(?:$|\?)/i.test(url) ? 'VIDEO' : 'IMAGE' };
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const row = item as Record<string, unknown>;
      const url = assertPublicHttpsUrl(String(row.url ?? row.imageUrl ?? row.videoUrl ?? ''), `캐러셀 URL ${index + 1}`);
      const kind = String(row.mediaType ?? row.media_type ?? (/\.(mp4|mov|m4v)(?:$|\?)/i.test(url) ? 'VIDEO' : 'IMAGE')).toUpperCase();
      if (kind !== 'IMAGE' && kind !== 'VIDEO') throw new AppError('INVALID_INPUT', '캐러셀 항목 mediaType은 IMAGE 또는 VIDEO 여야 합니다.');
      return { url, kind };
    }
    throw new AppError('INVALID_INPUT', '캐러셀 항목은 URL 문자열 또는 {url,mediaType} 객체여야 합니다.');
  });
}

/** @deprecated use parseCarouselItems */
export function parseCarouselUrls(value: unknown): string[] {
  return parseCarouselItems(value).map(item => item.url);
}

export type ThreadsMediaKind = 'TEXT' | 'IMAGE' | 'VIDEO' | 'CAROUSEL';

export function threadsMediaKind(value: unknown): ThreadsMediaKind {
  if (value === undefined || value === null || value === '') return 'TEXT';
  const kind = String(value).toUpperCase();
  if (kind === 'TEXT' || kind === 'IMAGE' || kind === 'VIDEO' || kind === 'CAROUSEL') return kind;
  throw new AppError('INVALID_INPUT', 'mediaType은 TEXT, IMAGE, VIDEO, CAROUSEL 중 하나여야 합니다.');
}

// ---------------------------------------------------------------------------
// X media (API v2). Official, verified 2026-09-24:
//   https://docs.x.com/x-api/media/upload-media            (one-shot POST /2/media/upload)
//   https://docs.x.com/x-api/media/quickstart/media-upload-chunked
//   https://docs.x.com/x-api/media/quickstart/best-practices
// Images: JPG/PNG/GIF/WEBP, 5 MB; animated GIF 15 MB; videos must use the
// chunked flow; one post carries up to 4 photos OR 1 GIF OR 1 video; APPEND
// chunks are at most 5 MB and segment_index is 0–999.
// The bytes come only from the controller-verified artifact (context.artifact);
// URLs are never fetched.

export type XMediaCategory = 'tweet_image' | 'tweet_gif' | 'tweet_video';
export interface XMediaSpec { mimeType: string; category: XMediaCategory; chunked: boolean; maxBytes: number }

/** 4 MiB keeps each APPEND under the documented 5 MB chunk ceiling. */
export const X_CHUNK_BYTES = 4 * 1024 * 1024;
const X_MAX_SEGMENTS = 1000;
// Decimal megabytes: the stricter reading of the documented "5 MB"/"15 MB".
const X_IMAGE_MAX_BYTES = 5_000_000;
const X_GIF_MAX_BYTES = 15_000_000;
// Documented 8 GB for tweet_video, further bounded by 1000 segments × chunk size.
const X_VIDEO_MAX_BYTES = Math.min(8_000_000_000, X_MAX_SEGMENTS * X_CHUNK_BYTES);

/** Detects the format from file signature bytes (never from the file name). */
export function xMediaSpec(head: Buffer, size: number): XMediaSpec {
  let spec: XMediaSpec | undefined;
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) spec = { mimeType: 'image/png', category: 'tweet_image', chunked: false, maxBytes: X_IMAGE_MAX_BYTES };
  else if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) spec = { mimeType: 'image/jpeg', category: 'tweet_image', chunked: false, maxBytes: X_IMAGE_MAX_BYTES };
  else if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') spec = { mimeType: 'image/webp', category: 'tweet_image', chunked: false, maxBytes: X_IMAGE_MAX_BYTES };
  else if (head.length >= 6 && ['GIF87a', 'GIF89a'].includes(head.toString('ascii', 0, 6))) spec = { mimeType: 'image/gif', category: 'tweet_gif', chunked: true, maxBytes: X_GIF_MAX_BYTES };
  else if (head.length >= 12 && head.toString('ascii', 4, 8) === 'ftyp') {
    spec = { mimeType: head.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4', category: 'tweet_video', chunked: true, maxBytes: X_VIDEO_MAX_BYTES };
  }
  if (!spec) throw new AppError('INVALID_INPUT', 'X 첨부 미디어는 JPEG·PNG·WebP 이미지, GIF, MP4·MOV 동영상만 지원합니다.');
  if (size <= 0 || size > spec.maxBytes) {
    throw new AppError('INVALID_INPUT', `X ${spec.category === 'tweet_image' ? '이미지' : spec.category === 'tweet_gif' ? 'GIF' : '동영상'}는 ${spec.maxBytes.toLocaleString('en-US')}바이트 이하여야 합니다. 현재 ${size.toLocaleString('en-US')}바이트입니다.`);
  }
  return spec;
}

export interface XMediaSource {
  spec: XMediaSpec;
  name: string;
  size: number;
  /** Reads a byte range from the already-opened file. */
  read(offset: number, length: number): Promise<Buffer>;
  /** Confirms the bytes read so far hash to the registered sha256. */
  verify(hash: string): void;
  close(): Promise<void>;
}

/**
 * Opens the verified artifact once (no symlinks), checks size and signature,
 * and exposes ranged reads. Callers hash what they upload and call verify()
 * before the upload is committed, so a file swapped after registration never
 * reaches X as a finished media object.
 */
export async function openXMedia(artifact: SocialArtifact | undefined): Promise<XMediaSource> {
  if (!artifact || artifact.kind === 'directory') {
    throw new AppError('ARTIFACT_REQUIRED', 'X 미디어 첨부에는 프로젝트에 등록한 미디어(mediaAssetId)의 검증된 파일이 필요합니다.');
  }
  const handle = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== artifact.size) throw new AppError('MEDIA_CHANGED', '등록 이후 미디어 파일이 변경되었습니다. 다시 등록해 주세요.', 409);
    const read = async (offset: number, length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, artifact.size - offset)));
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, offset + filled);
        if (bytesRead === 0) throw new AppError('MEDIA_CHANGED', '등록 이후 미디어 파일이 변경되었습니다. 다시 등록해 주세요.', 409);
        filled += bytesRead;
      }
      return buffer;
    };
    const spec = xMediaSpec(await read(0, 16), artifact.size);
    return {
      spec, name: artifact.name, size: artifact.size, read,
      verify: hash => { if (hash !== artifact.sha256) throw new AppError('MEDIA_CHANGED', '등록 이후 미디어 파일이 변경되었습니다. 다시 등록해 주세요.', 409); },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
