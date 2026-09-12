// Client-side text length guards for X and Threads.
//
// These are conservative pre-flight checks: they never *replace* the provider's
// own validation, they only stop us from dispatching a write the provider is
// certain to reject. When in doubt they over-count (reject earlier), never
// under-count. See docs/social-operations.md for the sourced rules.

import { AppError } from '../domain/errors.js';

// --- X (twitter-text v3 weighted length) --------------------------------------
// https://docs.x.com/resources/fundamentals/counting-characters
// Weighted length config v3: scale 100, defaultWeight 200, and the ranges below
// weigh 100 (i.e. 1 unit). maxWeightedTweetLength = 280. A URL is transformed to
// a fixed length of 23 regardless of its real length.
const X_MAX_WEIGHTED = 280;
const X_URL_WEIGHT = 23;
// Ranges (inclusive) that count as a single unit; everything else counts as two.
const X_LIGHT_RANGES: Array<[number, number]> = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

const URL_WITH_SCHEME = /https?:\/\/[^\s]+/gi;
// Scheme-less domains X still auto-links (and counts as 23). A bounded common
// TLD set keeps this deterministic; unmatched tokens fall through to per-char
// weighting, which is conservative for anything longer than 23 characters.
const BARE_DOMAIN =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|gg|tv|me|app|dev|ai|xyz|info|link|social|game|games|store|news|blog)\b(?:\/[^\s]*)?/gi;

// Forbidden control characters: NUL and other C0/C1 controls; tab (0x09) and
// newline (0x0A) are allowed. Built from an escape string so no raw control
// bytes appear in this source file.
const CONTROL_CHARS = new RegExp('[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]');

function assertPlainText(value: string, label: string, maximumChars: number): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('INVALID_INPUT', label + ' 내용이 비어 있습니다.');
  }
  if (value.length > maximumChars * 8) {
    // Guard against pathological input before we iterate code points.
    throw new AppError('TEXT_TOO_LONG', label + '이(가) 허용 길이를 초과했습니다.');
  }
  if (CONTROL_CHARS.test(value)) {
    throw new AppError('INVALID_INPUT', label + '에 허용되지 않는 제어 문자가 포함되어 있습니다.');
  }
}

/** Weighted length of a post using X's documented v3 configuration. */
export function weightedTweetLength(text: string): number {
  let urlCount = 0;
  const stripped = text
    .replace(URL_WITH_SCHEME, () => {
      urlCount += 1;
      return '';
    })
    .replace(BARE_DOMAIN, () => {
      urlCount += 1;
      return '';
    });
  let weight = urlCount * X_URL_WEIGHT;
  for (const char of stripped) {
    const code = char.codePointAt(0) ?? 0;
    const light = X_LIGHT_RANGES.some(([low, high]) => code >= low && code <= high);
    weight += light ? 1 : 2;
  }
  return weight;
}

/**
 * Validate plain text for an X post. We restrict to plain UTF-8 text (no media,
 * polls, or attachment references are supported by this module) and enforce the
 * documented 280 weighted-length cap. Returns the normalized text.
 */
export function assertXText(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('INVALID_INPUT', '게시글 text가 필요합니다.');
  const text = value.replace(/\r\n/g, '\n');
  assertPlainText(text, '게시글', X_MAX_WEIGHTED);
  const length = weightedTweetLength(text);
  if (length > X_MAX_WEIGHTED) {
    throw new AppError('TEXT_TOO_LONG', '게시글이 X 가중 길이 제한(' + X_MAX_WEIGHTED + ')을 초과했습니다 (약 ' + length + ').');
  }
  return text;
}

// --- Threads ------------------------------------------------------------------
// https://developers.facebook.com/docs/threads/posts - "Text posts are limited
// to 500 characters" and "Emojis are counted as the number of UTF-8 bytes."
const THREADS_MAX = 500;

function isEmojiCodePoint(code: number): boolean {
  return (
    code >= 0x1f000 || // astral symbols & emoji
    (code >= 0x2190 && code <= 0x2bff) || // arrows, misc symbols, dingbats
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    code === 0x200d || // zero-width joiner
    code === 0x20e3 // combining enclosing keycap
  );
}

/** Threads length: 1 per character, but each emoji counts as its UTF-8 bytes. */
export function threadsTextLength(text: string): number {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    length += isEmojiCodePoint(code) ? Buffer.byteLength(char, 'utf8') : 1;
  }
  return length;
}

/** Validate plain text for a Threads TEXT post; returns the normalized text. */
export function assertThreadsText(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('INVALID_INPUT', '게시글 text가 필요합니다.');
  const text = value.replace(/\r\n/g, '\n');
  assertPlainText(text, '게시글', THREADS_MAX);
  const length = threadsTextLength(text);
  if (length > THREADS_MAX) {
    throw new AppError('TEXT_TOO_LONG', '게시글이 Threads 길이 제한(' + THREADS_MAX + ')을 초과했습니다 (약 ' + length + ').');
  }
  return text;
}
