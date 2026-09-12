import { AppError } from '../domain/errors.js';
import type { SocialProvider, SocialRequest } from './types.js';

/**
 * Pinned API origins per provider. Only origins that appear in the providers'
 * current official documentation (verified 2026-09-11) are allowed; see
 * docs/social-operations.md for the exact source per origin. Meta's Threads
 * docs currently reference both graph.threads.net (Posts/Long-Lived Token
 * guides) and graph.threads.com (Get Access Tokens guide) during their domain
 * transition, so both are pinned. No hypothetical or legacy hosts are added.
 */
export const SOCIAL_ORIGINS: Record<SocialProvider, string[]> = {
  x: ['https://api.x.com'],
  threads: ['https://graph.threads.net', 'https://graph.threads.com'],
  steam: ['https://api.steampowered.com'],
};

function encodeForm(form: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) params.set(key, value);
  return params.toString();
}

/**
 * Builds a pinned-origin fetch used by adapters. It:
 *  - rejects any URL outside the provider's allowlist (and any embedded creds);
 *  - forces every non-GET request to declare read vs. write, and journals the
 *    first classified write via markDispatched() BEFORE it reaches the network;
 *  - maps HTTP failures to typed, secret-free AppErrors so provider error
 *    bodies (which can echo tokens) never enter history or logs.
 */
export function createSocialTransport(options: {
  provider: SocialProvider;
  signal: AbortSignal;
  markDispatched(): void;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): <T>(url: string, init?: SocialRequest) => Promise<T> {
  let dispatched = false;
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return async <T>(url: string, init: SocialRequest = {}): Promise<T> => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new AppError('INVALID_PROVIDER_URL', '서비스 요청 주소가 올바르지 않습니다.');
    }
    if (
      !SOCIAL_ORIGINS[options.provider].includes(target.origin) ||
      target.username ||
      target.password ||
      target.hash
    ) {
      throw new AppError('INVALID_PROVIDER_URL', '서비스의 공식 API 주소만 호출할 수 있습니다.');
    }
    const method = init.method ?? 'GET';
    if (method !== 'GET') {
      if (typeof init.write !== 'boolean') {
        throw new AppError('EFFECT_CLASSIFICATION_REQUIRED', '외부 요청의 읽기·쓰기 구분이 필요합니다.');
      }
      if (!init.write) {
        throw new AppError('INVALID_EFFECT_CLASSIFICATION', '외부 변경 요청을 조회로 처리할 수 없습니다.');
      }
    }
    options.signal.throwIfAborted();
    // Journal intent before the first external write leaves the process.
    if (init.write && !dispatched) {
      options.markDispatched();
      dispatched = true;
    }
    const headers: Record<string, string> = { ...init.headers };
    let body: BodyInit | undefined = init.body;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = encodeForm(init.form);
    }
    let response: Response;
    try {
      response = await fetcher(target, {
        method,
        headers,
        body,
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]),
        redirect: 'error',
      });
    } catch (error) {
      if (options.signal.aborted) throw new AppError('CANCELLED', '작업을 취소했습니다.');
      // A write that timed out here has an UNKNOWN outcome. The adapter that set
      // write:true is responsible for surfacing it as unresolved; we never
      // silently swallow or auto-retry it.
      throw new AppError('TEMPORARY', '서비스 응답을 받지 못했습니다. 연결 상태를 다시 확인합니다.', 503);
    }
    if (!response.ok) {
      // Provider error bodies and request URLs can contain credentials. Never
      // surface them; map to stable codes instead.
      await response.body?.cancel();
      if (response.status === 401) throw new AppError('AUTH_REQUIRED', '서비스에서 인증 갱신 또는 연결 확인을 요구했습니다.', 401);
      if (response.status === 403) throw new AppError('PERMISSION_REQUIRED', '이 작업에 필요한 서비스 권한이 없습니다.', 403);
      if (response.status === 429 || response.status >= 500) {
        throw new AppError('TEMPORARY', `서비스가 일시적으로 요청을 처리하지 못했습니다 (HTTP ${response.status}).`, 503);
      }
      if (response.status === 404) throw new AppError('RESOURCE_NOT_FOUND', '서비스에서 계정 또는 리소스를 찾지 못했습니다.', 404);
      throw new AppError('PROVIDER_REJECTED', `서비스가 입력 또는 현재 상태를 허용하지 않았습니다 (HTTP ${response.status}).`, 422);
    }
    if (response.status === 204) return {} as T;
    const limit = 8 * 1024 * 1024;
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > limit) {
      await response.body?.cancel();
      throw new AppError('RESPONSE_TOO_LARGE', '응답이 너무 큽니다. 조회 범위를 줄여 주세요.');
    }
    const text = await response.text();
    if (text.length > limit) throw new AppError('RESPONSE_TOO_LARGE', '응답이 너무 큽니다. 조회 범위를 줄여 주세요.');
    if (init.format === 'text') return text as T;
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new AppError('INVALID_PROVIDER_RESPONSE', '서비스 응답을 해석할 수 없습니다.', 502);
    }
  };
}
