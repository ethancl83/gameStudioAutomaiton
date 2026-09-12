import { AppError } from '../domain/errors.js';
import type { Provider } from '../domain/index.js';
import type { ProviderRequest } from './types.js';

const ORIGINS: Record<Provider, string[]> = {
  'google-play': ['https://androidpublisher.googleapis.com', 'https://storage.googleapis.com'],
  'app-store': ['https://api.appstoreconnect.apple.com'],
  steam: ['https://partner.steam-api.com', 'https://api.steampowered.com'],
  'google-ads': ['https://googleads.googleapis.com'],
  'applovin-ads': ['https://api.ads.axon.ai', 'https://r.applovin.com'],
  'applovin-max': ['https://o.applovin.com', 'https://r.applovin.com'],
  admob: ['https://admob.googleapis.com'],
  x: ['https://api.x.com'], threads: ['https://graph.threads.net', 'https://graph.threads.com'],
};

export function createTransport(options: {
  provider: Provider; signal: AbortSignal; markDispatched(): void; markRejected?(): boolean | void; fetch?: typeof fetch;
}): <T>(url: string, init?: ProviderRequest) => Promise<T> {
  let dispatched = false;
  let writeAttempts = 0;
  const uploadUrls = new Set<string>();
  const fetcher = options.fetch ?? fetch;
  return async <T>(url: string, init: ProviderRequest = {}): Promise<T> => {
    let target: URL;
    try { target = new URL(url); } catch { throw new AppError('INVALID_PROVIDER_URL', '서비스 요청 주소가 올바르지 않습니다.'); }
    const upload = options.provider === 'app-store' && uploadUrls.has(target.href) && init.method === 'PUT';
    if ((!ORIGINS[options.provider].includes(target.origin) && !upload) || target.username || target.password || target.hash) {
      throw new AppError('INVALID_PROVIDER_URL', '서비스의 공식 API 주소만 호출할 수 있습니다.');
    }
    if (upload && Object.keys(init.headers ?? {}).some(key => /^(authorization|cookie|host|proxy-authorization)$/i.test(key))) {
      throw new AppError('INVALID_UPLOAD_HEADERS', '파일 업로드 주소에는 계정 인증 정보를 전달할 수 없습니다.');
    }
    const method = init.method ?? 'GET';
    if (method !== 'GET') {
      if (typeof init.write !== 'boolean') throw new AppError('EFFECT_CLASSIFICATION_REQUIRED', '외부 요청의 읽기·쓰기 구분이 필요합니다.');
      const readOnlyPost = method === 'POST' && (
        (options.provider === 'google-play' && /\/pricing:convertRegionPrices$/.test(target.pathname)) ||
        (options.provider === 'google-ads' && /\/googleAds:search(?:Stream)?$/.test(target.pathname)) ||
        (options.provider === 'admob' && /\/(?:networkReport|mediationReport):generate$/.test(target.pathname))
      );
      if (!init.write && !readOnlyPost) throw new AppError('INVALID_EFFECT_CLASSIFICATION', '외부 변경 요청을 조회로 처리할 수 없습니다.');
    }
    options.signal.throwIfAborted();
    if (init.write && !dispatched) { options.markDispatched(); dispatched = true; }
    if (init.write) writeAttempts++;
    let response: Response;
    try {
      response = await fetcher(target, {
        method,
        headers: { ...(init.json === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
        body: init.json === undefined ? init.body : JSON.stringify(init.json),
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]),
        redirect: 'error',
      });
    } catch (error) {
      if (options.signal.aborted) throw new AppError('CANCELLED', '작업을 취소했습니다.');
      throw new AppError('TEMPORARY', '서비스 응답을 받지 못했습니다. 연결 상태를 다시 확인합니다.', 503);
    }
    if (!response.ok) {
      // Provider error bodies and request URLs can contain credentials. Never put them in history.
      await response.body?.cancel();
      const error = response.status === 401 ? new AppError('AUTH_REQUIRED', '서비스에서 인증 갱신 또는 연결 확인을 요구했습니다.', 401)
        : response.status === 403 ? new AppError('PERMISSION_REQUIRED', '이 작업에 필요한 서비스 권한이 없습니다.', 403)
        : response.status === 429 || response.status >= 500 ? new AppError('TEMPORARY', `서비스가 일시적으로 요청을 처리하지 못했습니다 (HTTP ${response.status}).`, 503)
        : response.status === 404 ? new AppError('RESOURCE_NOT_FOUND', '서비스에서 앱 또는 리소스를 찾지 못했습니다.', 404)
        : new AppError('PROVIDER_REJECTED', `서비스가 입력 또는 현재 상태를 허용하지 않았습니다 (HTTP ${response.status}). 서비스별 설정을 확인해 주세요.`, 422);
      // A later 4xx cannot undo an earlier successful/unknown mutation. Timeouts
      // (including HTTP 408) and 5xx also retain the durable dispatch fence.
      if (init.write && writeAttempts === 1 && [400,401,403,404,405,409,410,413,415,422,429].includes(response.status)) {
        if(options.markRejected?.() !== false){error.externalWriteRejected = true; dispatched = false;}
      }
      throw error;
    }
    if (response.status === 204) return {} as T;
    const limit = init.format === 'bytes' ? 64 * 1024 * 1024 : 16 * 1024 * 1024;
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > limit) { await response.body?.cancel(); throw new AppError('RESPONSE_TOO_LARGE', '응답이 너무 큽니다. 조회 기간을 줄여 주세요.'); }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > limit) { await reader.cancel(); throw new AppError('RESPONSE_TOO_LARGE', '응답이 너무 큽니다. 조회 기간을 줄여 주세요.'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
    }
    const bytes = Buffer.concat(chunks);
    if (init.format === 'bytes') return bytes as T;
    const result = bytes.toString('utf8');
    if (init.format === 'text') return result as T;
    try {
      const data = result ? JSON.parse(result) : {};
      if (options.provider === 'app-store' && target.origin === 'https://api.appstoreconnect.apple.com') {
        const visit = (value: unknown, depth = 0): void => {
          if (depth > 12 || !value || typeof value !== 'object') return;
          for (const [key, item] of Object.entries(value)) {
            if (key === 'uploadOperations' && Array.isArray(item)) {
              for (const operation of item) {
                if (typeof operation?.url !== 'string') continue;
                const address = new URL(operation.url);
                if (address.protocol === 'https:' && !address.username && !address.password && !address.hash &&
                    /(?:\.apple\.com|\.icloud\.com)$/.test(address.hostname) && (!address.port || address.port === '443') && uploadUrls.size < 4096) {
                  uploadUrls.add(address.href);
                }
              }
            } else visit(item, depth + 1);
          }
        };
        visit(data);
      }
      return data as T;
    }
    catch { throw new AppError('INVALID_PROVIDER_RESPONSE', '서비스 응답을 해석할 수 없습니다.', 502); }
  };
}
