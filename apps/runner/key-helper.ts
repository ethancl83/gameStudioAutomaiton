import { randomUUID } from 'node:crypto';
import { AppError, object } from '../../packages/domain/errors.js';
import { normalizeBuildCredential, validateBuildCredential, validateDependency, type BuildKeyReference } from '../../packages/build-credentials/index.js';
import { prepareSshDependencies, signAndroidArtifact } from '../../packages/build-credentials/build.js';
import { KEY_HELPER_INPUT_LIMIT, KEY_HELPER_OUTPUT_LIMIT, exactKeys, helperErrorCode, keyReference, protocolError, sameReference,
  type KeyHelperRequest, type KeyHelperMetadata } from '../../packages/build-credentials/docker-protocol.js';
import type { BuildCredential } from '../../packages/domain/index.js';

async function readRequest(): Promise<KeyHelperRequest> {
  const chunks: Buffer[] = []; let bytes = 0;
  const timer = setTimeout(() => process.stdin.destroy(new AppError('KEY_TOOL_TIMEOUT', '키 입력 시간이 초과되었습니다.')), 30_000); timer.unref();
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > KEY_HELPER_INPUT_LIMIT) throw new AppError('INVALID_BUILD_CREDENTIAL', '키 입력 크기 한도를 넘었습니다.');
      chunks.push(buffer);
    }
  } finally { clearTimeout(timer); }
  let raw: unknown; try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return protocolError(); }
  const data = object(raw);
  if (!['validate', 'sign', 'fetch'].includes(String(data.operation))) return protocolError();
  const kind = data.operation === 'validate' ? data.kind : data.operation === 'sign' ? 'android-keystore' : 'ssh';
  if (kind !== 'ssh' && kind !== 'android-keystore') return protocolError();
  const rawCredentials = object(data.credentials);
  exactKeys(rawCredentials, kind === 'ssh' ? ['host', 'port', 'username', 'privateKey', 'passphrase', 'knownHosts'] : ['keystoreBase64', 'storePassword', 'keyPassword', 'keyAlias']);
  if (Object.values(rawCredentials).some(value => typeof value !== 'string' || value.length > 1_500_000)) return protocolError();
  const credentials = normalizeBuildCredential(kind, rawCredentials as Record<string, string>);
  if (data.operation === 'validate') {
    exactKeys(data, ['operation', 'kind', 'credentials']);
    return { operation: 'validate', kind, credentials };
  }
  if (data.operation === 'sign') {
    exactKeys(data, ['operation', 'reference', 'format', 'credentials']);
    if (data.format !== 'aab' && data.format !== 'apk') return protocolError();
    return { operation: 'sign', reference: keyReference(data.reference), format: data.format, credentials };
  }
  exactKeys(data, ['operation', 'dependency', 'credentials']);
  const dependency = object(data.dependency); exactKeys(dependency, ['key', 'repositoryUrl', 'revision', 'relativePath']);
  const key = keyReference(dependency.key);
  const normalized = validateDependency(dependency, { id: key.id, details: credentials } as BuildCredential);
  return { operation: 'fetch', credentials, dependency: { key, repositoryUrl: normalized.repositoryUrl, revision: normalized.revision, relativePath: normalized.relativePath } };
}
async function execute(request: KeyHelperRequest, signal: AbortSignal): Promise<KeyHelperMetadata> {
  if (process.platform !== 'linux') throw new AppError('KEY_RUNTIME_UNAVAILABLE', 'Linux 키 헬퍼가 필요합니다.');
  const namespace = randomUUID();
  if (request.operation === 'validate') {
    const validated = await validateBuildCredential(request.kind, request.credentials, namespace);
    // Construct only allowed metadata. Never spread the credential-bearing validation result.
    if (request.kind === 'ssh') return { fingerprint: validated.fingerprint, publicKey: validated.publicKey,
      details: { host: validated.details.host!, port: validated.details.port!, username: validated.details.username!, algorithm: validated.details.algorithm! } };
    return { fingerprint: validated.fingerprint, details: { keyAlias: validated.details.keyAlias!, expiresAt: validated.details.expiresAt!, algorithm: validated.details.algorithm! } };
  }
  const reference = request.operation === 'sign' ? request.reference : request.dependency.key;
  const manager = { credentials: async (selected: BuildKeyReference) => {
    if (!sameReference(selected, reference)) throw new AppError('BUILD_KEY_NOT_FOUND', '요청한 키 버전이 아닙니다.');
    return request.credentials;
  } };
  if (request.operation === 'sign') {
    const signed = await signAndroidArtifact(manager, request.reference, '/work/sign/artifact.' + request.format, namespace, signal);
    return { fingerprint: signed.fingerprint, keyId: signed.keyId, version: signed.version, format: signed.format };
  }
  const [fetched] = await prepareSshDependencies(manager, { sshDependencies: [request.dependency] }, '/work/snapshot', '/work/checkout', namespace, signal);
  if (!fetched) return protocolError();
  return { path: fetched.path, commit: fetched.commit, hash: fetched.hash,
    key: { id: fetched.key.id, version: fetched.key.version, fingerprint: fetched.key.fingerprint } };
}

const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
try {
  const result = await execute(await readRequest(), controller.signal);
  if (controller.signal.aborted) throw new AppError('CANCELLED', '키 사용 작업을 취소했습니다.');
  const output = JSON.stringify({ ok: true, result });
  if (Buffer.byteLength(output) > KEY_HELPER_OUTPUT_LIMIT) protocolError();
  process.stdout.write(output + '\n');
} catch (error) {
  process.exitCode = 1;
  process.stdout.write(JSON.stringify({ ok: false, code: helperErrorCode(error) }) + '\n');
}
