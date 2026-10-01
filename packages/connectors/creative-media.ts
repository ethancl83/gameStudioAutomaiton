// 광고 소재 업로드용 프로젝트 이미지 읽기. 제어 서비스가 검증한 artifact(context.artifact)를 다시 읽어
// 크기·sha256이 그대로인지 확인하고, 파일 시그니처로 형식과 픽셀 크기를 판별한다.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { AppError } from '../domain/errors.js';
import type { ConnectorContext } from './types.js';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export interface CreativeImage { bytes: Buffer; mime: ImageMime; width: number; height: number; sha256: string; name: string }

function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    // SOF0–SOF15 (DHT C4, JPG C8, DAC CC 제외)에 프레임 크기가 있다.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

function gifSize(bytes: Buffer): { width: number; height: number } | undefined {
  const head = bytes.toString('ascii', 0, 6);
  if (bytes.length < 10 || (head !== 'GIF87a' && head !== 'GIF89a')) return undefined;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

/**
 * 검증된 이미지 artifact를 읽는다. 허용 형식 밖이거나 크기 상한을 넘으면 읽기 전에 거부한다.
 * 등록 이후 파일이 바뀌었으면(MEDIA_CHANGED) 외부 전송 전에 중단한다.
 */
export async function readCreativeImage(ctx: ConnectorContext, options: { allowed: ImageMime[]; maxBytes: number; label: string }): Promise<CreativeImage> {
  const artifact = ctx.artifact;
  if (!artifact || artifact.kind === 'directory') {
    throw new AppError('ARTIFACT_REQUIRED', `${options.label}에는 프로젝트에 등록한 이미지(mediaAssetId)의 검증된 파일이 필요합니다.`);
  }
  if (artifact.size > options.maxBytes) {
    throw new AppError('INVALID_IMAGE', `${options.label} 이미지는 ${options.maxBytes.toLocaleString('en-US')}바이트 이하여야 합니다. 현재 ${artifact.size.toLocaleString('en-US')}바이트입니다.`);
  }
  const info = await stat(artifact.path);
  if (info.size !== artifact.size) throw new AppError('MEDIA_CHANGED', '등록 이후 이미지가 변경되었습니다. 다시 등록해 주세요.', 409);
  const bytes = await readFile(artifact.path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== artifact.size || sha256 !== artifact.sha256) throw new AppError('MEDIA_CHANGED', '등록 이후 이미지가 변경되었습니다. 다시 등록해 주세요.', 409);
  const detected: Array<[ImageMime, { width: number; height: number } | undefined]> = [
    ['image/png', pngSize(bytes)], ['image/jpeg', jpegSize(bytes)], ['image/gif', gifSize(bytes)],
  ];
  const webp = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  const match = detected.find(([, size]) => size);
  const mime: ImageMime | undefined = match?.[0] ?? (webp ? 'image/webp' : undefined);
  if (!mime || !options.allowed.includes(mime)) {
    throw new AppError('INVALID_IMAGE', `${options.label} 이미지는 ${options.allowed.map(item => item.slice(6).toUpperCase()).join('·')} 형식만 허용합니다.`);
  }
  const size = match?.[1];
  if (!size || size.width <= 0 || size.height <= 0) throw new AppError('INVALID_IMAGE', '이미지 픽셀 크기를 확인할 수 없습니다.');
  return { bytes, mime, width: size.width, height: size.height, sha256, name: artifact.name };
}

export function imageExtension(mime: ImageMime): string {
  return mime === 'image/jpeg' ? 'jpg' : mime.slice(6);
}
