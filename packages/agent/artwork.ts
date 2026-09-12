import sharp from 'sharp';
import { AppError, text } from '../domain/errors.js';

export async function renderArtwork(svg: unknown, width: unknown, height: unknown): Promise<Buffer> {
  const source = text(svg, 'SVG 그림', 200_000);
  if (!Number.isInteger(width) || !Number.isInteger(height) || Number(width) < 64 || Number(height) < 64 || Number(width) > 4096 || Number(height) > 4096) {
    throw new AppError('AGENT_IMAGE_SIZE', '이미지 크기는 64–4096 픽셀이어야 합니다.');
  }
  const tags = source.match(/<[^>]+>/g) ?? [];
  const permitted = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath']);
  if (!/^<svg\s/.test(source) || /<!|<\?|\bon\w+\s*=|\b(?:href|src|style)\s*=|@import|&(?:#|\w+;)/i.test(source) || /url\(\s*[^#]/i.test(source) ||
    tags.length > 2000 || tags.some(tag => !permitted.has(tag.match(/^<\/?([\w]+)/)?.[1] ?? ''))) {
    throw new AppError('AGENT_UNSAFE_SVG', '외부 참조·스크립트가 없는 정적인 SVG 도형만 사용할 수 있습니다.');
  }
  try { return await sharp(Buffer.from(source), { limitInputPixels: 4096 * 4096 }).resize(Number(width), Number(height), { fit: 'fill' }).flatten({ background: '#ffffff' }).png().toBuffer(); }
  catch { throw new AppError('AGENT_INVALID_IMAGE', '생성한 그림을 PNG로 변환하지 못했습니다. SVG를 수정해 주세요.'); }
}
