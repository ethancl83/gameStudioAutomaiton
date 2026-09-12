import { AppError } from '../domain/errors.js';
import { parseJsonArray } from './helpers.js';

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
