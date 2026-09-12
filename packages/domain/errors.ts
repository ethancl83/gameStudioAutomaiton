export class AppError extends Error {
  /** The provider rejected the first mutation; no earlier mutation was sent. */
  externalWriteRejected = false;
  constructor(public code: string, message: string, public status = 400, public details?: unknown) {
    super(message); this.name = 'AppError';
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_INPUT', '올바른 입력 형식이 필요합니다.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw new AppError('INVALID_INPUT', `${label} 값을 확인해 주세요.`);
  }
  return value.trim();
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
export function redact(message: string, secrets: string[] = []): string {
  let safe = message.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED KEY]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password)\s*[=:]\s*)[^\s,&"']+/gi, '$1[REDACTED]');
  for (const secret of secrets.filter(value => value.length >= 4).sort((a, b) => b.length - a.length)) safe = safe.split(secret).join('[REDACTED]');
  return safe.slice(0, 16_000);
}
export function prohibitSecrets(value: unknown, depth = 0): void {
  if (depth > 20) throw new AppError('INVALID_INPUT', '입력이 너무 깊게 중첩되어 있습니다.');
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:password|storePassword|keyPassword|passphrase|keystoreBase64|privateKey|private_key|refreshToken|refresh_token|accessToken|access_token|clientSecret|client_secret|serviceAccountJson|apiKey|api_key|reportKey|managementKey|sdkKey)$/i.test(key)) {
      throw new AppError('SECRET_IN_JOB', '인증 정보는 계정 연결 화면에 보관해 주세요. 작업 이력에는 저장하지 않습니다.');
    }
    prohibitSecrets(item, depth + 1);
  }
}
