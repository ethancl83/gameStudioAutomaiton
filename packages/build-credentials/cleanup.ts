import { AppError } from '../domain/errors.js';

/** Only public recovery identifiers may cross the API or durable job boundary. */
export function dockerKeyCleanupFailure(error: unknown): {
  code: string; message: string; details: Record<string, string>;
} | undefined {
  if (!(error instanceof AppError) || error.code !== 'DOCKER_KEY_CLEANUP_FAILED') return undefined;
  const raw = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  const details: Record<string, string> = {};
  if (typeof raw.containerId === 'string' && /^[a-f0-9]{64}$/.test(raw.containerId)) details.containerId = raw.containerId;
  if (typeof raw.operationId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(raw.operationId)) details.operationId = raw.operationId;
  const identifiers = Object.entries(details).map(([key, value]) => `${key}=${value}`).join(', ');
  return { code: error.code, details,
    message: 'Docker 키 컨테이너의 정리를 확인하지 못했습니다. Docker 연결을 복구하고 해당 작업만 정리해 주세요.' + (identifiers ? ` (${identifiers})` : '') };
}
