// 빌드 서명·SSH 키 관리. 설정 화면에 표시한다.
// - SSH 키: 비공개 빌드 의존성(사설 저장소/애드온)을 빌드 전에 안전하게 가져올 때 사용.
// - Android 키스토어: 빌드 후 결과물(AAB/APK) 서명에 사용.
// 비밀 값은 로컬 API로만 전송되고, 화면·응답에는 메타데이터(지문·공개키·버전)만 표시한다.
import { useState } from 'react';
import {
  Fingerprint,
  KeyRound,
  Plus,
  RotateCw,
  Server,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { api } from '../api';
import { formatDateTime } from '../format';
import { useAction } from '../useAction';
import { Badge, Card, Field, Modal, Notice, Spinner } from '../components/ui';
import type { AppState, BuildCredential } from '../../../../packages/domain';

const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB 상한. 외부 업로드 없이 로컬 API로만 전송한다.

function readFileText(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) return Promise.reject(new Error('파일이 1MiB를 초과합니다.'));
  return file.text();
}

async function readFileBase64(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) throw new Error('파일이 1MiB를 초과합니다.');
  const buf = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buf.length; i += 1) binary += String.fromCharCode(buf[i]);
  return btoa(binary);
}

function kindLabel(kind: BuildCredential['kind']): string {
  return kind === 'ssh' ? 'SSH 키' : 'Android 키스토어';
}

export function BuildKeysSection({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [registerOpen, setRegisterOpen] = useState(false);
  const [rotate, setRotate] = useState<BuildCredential | null>(null);
  const creds = state.buildCredentials ?? [];

  return (
    <Card title="빌드 서명·SSH 키" icon={ShieldCheck}>
      <Notice tone="info">
        <div className="stack" style={{ gap: 4 }}>
          <span className="small">
            <strong>SSH 키</strong>는 비공개 빌드 의존성(사설 저장소·유료 애드온)을 빌드 <em>전에</em> 안전하게 내려받을
            때 씁니다. <strong>Android 키스토어</strong>는 빌드 <em>후</em> 결과물(AAB/APK) 서명에 씁니다. 두 용도는 서로
            다릅니다.
          </span>
          <span className="small">
            한 번 등록하면 여러 프로젝트·빌드에서 재사용하며 매번 로그인·키 입력을 요구하지 않습니다. 비밀 값은 안전
            보관함에 저장되고 화면·로그·빌드 스크립트·스냅샷에 남지 않으며, 지문·공개키·버전만 표시됩니다.
          </span>
        </div>
      </Notice>

      <div className="row row--between" style={{ marginTop: 14 }}>
        <span className="small muted">{creds.length}개 등록됨</span>
        <button
          className="btn btn--sm btn--primary"
          onClick={() => setRegisterOpen(true)}
          disabled={!state.vault.available}
          title={!state.vault.available ? '안전한 보관함이 준비되어야 등록할 수 있습니다.' : undefined}
        >
          <Plus size={14} /> 빌드 키 등록
        </button>
      </div>

      {!state.vault.available && (
        <div style={{ marginTop: 10 }}>
          <Notice tone="warn">
            안전한 OS 보관함을 사용할 수 없어 빌드 키를 저장할 수 없습니다. 보관함을 준비한 뒤 등록하세요.
          </Notice>
        </div>
      )}

      {creds.length === 0 ? (
        <p className="small muted" style={{ marginTop: 12 }}>
          아직 등록된 빌드 키가 없습니다. SSH 키 또는 Android 키스토어를 등록하면 프로젝트 빌드 보안에서 선택할 수
          있습니다.
        </p>
      ) : (
        <div className="stack" style={{ gap: 10, marginTop: 12 }}>
          {creds.map((c) => (
            <BuildCredentialCard key={c.id} cred={c} refresh={refresh} onRotate={() => setRotate(c)} />
          ))}
        </div>
      )}

      {registerOpen && <RegisterBuildCredentialModal refresh={refresh} onClose={() => setRegisterOpen(false)} />}
      {rotate && <RotateBuildCredentialModal cred={rotate} refresh={refresh} onClose={() => setRotate(null)} />}
    </Card>
  );
}

function BuildCredentialCard({
  cred,
  refresh,
  onRotate,
}: {
  cred: BuildCredential;
  refresh: () => Promise<void>;
  onRotate: () => void;
}) {
  const del = useAction<{ deleted: true }>(refresh);
  const [confirm, setConfirm] = useState(false);

  return (
    <div className="card" style={{ boxShadow: 'none' }}>
      <div className="card__body">
        <div className="row row--between">
          <span className="row" style={{ gap: 8 }}>
            {cred.kind === 'ssh' ? <Server size={15} aria-hidden /> : <KeyRound size={15} aria-hidden />}
            <strong>{cred.label}</strong>
            <Badge tone="neutral">{kindLabel(cred.kind)}</Badge>
          </span>
          <span className="small muted">v{cred.version}</span>
        </div>
        <dl className="dl" style={{ gridTemplateColumns: '110px 1fr', marginTop: 10 }}>
          <dt>
            <span className="row" style={{ gap: 5 }}>
              <Fingerprint size={12} /> 지문
            </span>
          </dt>
          <dd className="mono small" style={{ wordBreak: 'break-all' }}>{cred.fingerprint}</dd>
          {cred.kind === 'ssh' && (
            <>
              <dt>호스트</dt>
              <dd className="mono small">
                {(cred.details.username || 'git')}@{cred.details.host}
                {cred.details.port && cred.details.port !== '22' ? `:${cred.details.port}` : ''}
              </dd>
            </>
          )}
          {cred.kind === 'android-keystore' && cred.details.keyAlias && (
            <>
              <dt>키 별칭</dt>
              <dd className="mono small">{cred.details.keyAlias}</dd>
            </>
          )}
          {cred.publicKey && (
            <>
              <dt>공개키</dt>
              <dd className="mono small" style={{ wordBreak: 'break-all' }}>{cred.publicKey}</dd>
            </>
          )}
          <dt>수정</dt>
          <dd className="small">{formatDateTime(cred.updatedAt)}</dd>
        </dl>
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <button className="btn btn--sm" onClick={onRotate}>
            <RotateCw size={13} /> 수정·회전
          </button>
          <button className="btn btn--sm btn--danger" onClick={() => setConfirm(true)}>
            <Trash2 size={13} /> 삭제
          </button>
        </div>
        {del.error && (
          <div style={{ marginTop: 8 }}>
            <Notice tone="error">{del.error.message}</Notice>
          </div>
        )}
      </div>

      {confirm && (
        <Modal
          title="빌드 키 삭제"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(false)}>
                취소
              </button>
              <button
                className="btn btn--danger"
                disabled={del.pending}
                onClick={async () => {
                  const res = await del.run(() => api.deleteBuildCredential(cred.id));
                  if (res?.ok) setConfirm(false);
                }}
              >
                {del.pending ? <Spinner /> : <Trash2 size={15} />} 삭제
              </button>
            </>
          }
        >
          <Notice tone="warn">
            <strong>{cred.label}</strong> 키를 삭제하면 보관된 비밀이 제거됩니다. 프로젝트 빌드 보안에서 사용 중이면
            서버가 삭제를 거부합니다. 먼저 해당 프로젝트에서 이 키를 해제하세요.
          </Notice>
          {del.error && (
            <div style={{ marginTop: 10 }}>
              <Notice tone="error">{del.error.message}</Notice>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

// 파일 또는 텍스트 입력(비밀). 파일은 1MiB 이하로 읽어 값에 채운다.
function SecretFileOrText({
  label,
  required,
  hint,
  value,
  onChange,
  accept,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  accept?: string;
}) {
  const [fileError, setFileError] = useState('');
  const [fileName, setFileName] = useState('');
  return (
    <Field label={label} required={required} hint={hint}>
      <textarea
        className="textarea mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder="파일에서 불러오거나 여기에 붙여넣기"
        rows={4}
      />
      <div className="row" style={{ gap: 8, marginTop: 6, alignItems: 'center' }}>
        <label className="btn btn--sm" style={{ cursor: 'pointer' }}>
          <Upload size={13} /> 파일 선택
          <input
            type="file"
            accept={accept}
            style={{ display: 'none' }}
            onChange={async (e) => {
              setFileError('');
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const text = await readFileText(f);
                onChange(text);
                setFileName(f.name);
              } catch (err) {
                setFileError(err instanceof Error ? err.message : '파일을 읽지 못했습니다.');
              } finally {
                e.target.value = '';
              }
            }}
          />
        </label>
        {fileName && <span className="small muted">{fileName}</span>}
      </div>
      {fileError && <span className="field__hint" style={{ color: 'var(--error)' }}>{fileError}</span>}
    </Field>
  );
}

type Kind = BuildCredential['kind'];

function RegisterBuildCredentialModal({ refresh, onClose }: { refresh: () => Promise<void>; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>('ssh');
  const [label, setLabel] = useState('');
  const add = useAction<BuildCredential>(refresh);

  // SSH
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [username, setUsername] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [knownHosts, setKnownHosts] = useState('');
  // Android
  const [keystoreBase64, setKeystoreBase64] = useState('');
  const [keystoreName, setKeystoreName] = useState('');
  const [keystoreError, setKeystoreError] = useState('');
  const [storePassword, setStorePassword] = useState('');
  const [keyAlias, setKeyAlias] = useState('');
  const [keyPassword, setKeyPassword] = useState('');

  // 데모: 실제 비밀을 받지 않는다. 라벨+종류만 받아 루트가 합성 자격 증명을 생성한다.
  const demo = api.isDemo();
  const sshMissing = !host.trim() || !privateKey.trim() || !knownHosts.trim();
  const androidMissing = !keystoreBase64 || !storePassword.trim() || !keyAlias.trim();
  const blocked = !label.trim() || (demo ? false : kind === 'ssh' ? sshMissing : androidMissing);

  function buildCredentials(): Record<string, string> {
    if (demo) return {}; // 데모: 비밀 없음. 루트가 합성 키를 생성한다.
    if (kind === 'ssh') {
      const c: Record<string, string> = { host: host.trim(), privateKey, knownHosts };
      if (port.trim()) c.port = port.trim();
      if (username.trim()) c.username = username.trim();
      if (passphrase) c.passphrase = passphrase;
      return c;
    }
    const c: Record<string, string> = { keystoreBase64, storePassword, keyAlias: keyAlias.trim() };
    if (keyPassword) c.keyPassword = keyPassword;
    return c;
  }

  async function submit() {
    if (blocked) return;
    const res = await add.run(() => api.addBuildCredential({ kind, label: label.trim(), credentials: buildCredentials() }));
    if (res?.ok) onClose();
  }

  return (
    <Modal
      title="빌드 키 등록"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn btn--primary" onClick={() => void submit()} disabled={blocked || add.pending}>
            {add.pending ? <Spinner /> : <ShieldCheck size={15} />} 등록
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <div className="pill-group" role="tablist" aria-label="키 종류">
          <button role="tab" aria-pressed={kind === 'ssh'} onClick={() => setKind('ssh')}>
            SSH 키 (의존성 가져오기)
          </button>
          <button role="tab" aria-pressed={kind === 'android-keystore'} onClick={() => setKind('android-keystore')}>
            Android 키스토어 (서명)
          </button>
        </div>

        <Field label="키 이름" required hint="이 키를 구분할 이름.">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === 'ssh' ? '사설 애드온 SSH' : '출시 서명 키'} />
        </Field>

        {demo ? (
          <Notice tone="info" title="데모 키 등록">
            데모에서는 라벨과 종류만 입력합니다. 실제 비밀(비공개 키·키스토어·암호)은 받지 않으며, 루트가 합성
            자격 증명을 생성해 화면과 흐름을 실제와 동일하게 보여줍니다. 실제 모드에서는 정식 비밀 입력 폼이 표시됩니다.
          </Notice>
        ) : kind === 'ssh' ? (
          <>
            <p className="small muted" style={{ margin: 0 }}>
              사설 저장소에서 빌드 의존성을 가져오는 데 쓰는 배포용 SSH 키입니다. 알려진 호스트(known_hosts)를 고정해
              중간자 공격을 막습니다.
            </p>
            <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
              <div style={{ flex: 2, minWidth: 200 }}>
                <Field label="호스트" required htmlFor="bk-host" hint="예: github.com, gitlab.example.com">
                  <input id="bk-host" className="input mono" value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} />
                </Field>
              </div>
              <div style={{ flex: 1, minWidth: 90 }}>
                <Field label="포트" htmlFor="bk-port" hint="기본 22">
                  <input id="bk-port" className="input" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" placeholder="22" />
                </Field>
              </div>
              <div style={{ flex: 1, minWidth: 120 }}>
                <Field label="사용자" htmlFor="bk-user" hint="기본 git">
                  <input id="bk-user" className="input mono" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="git" spellCheck={false} />
                </Field>
              </div>
            </div>
            <SecretFileOrText
              label="비공개 키 (privateKey)"
              required
              hint="OpenSSH 형식 비공개 키. 파일에서 불러오거나 붙여넣기. 저장 후 표시되지 않습니다."
              value={privateKey}
              onChange={setPrivateKey}
              accept=".pem,.key,text/plain"
            />
            <Field label="패스프레이즈" hint="키에 암호가 걸려 있으면 입력(선택).">
              <input className="input" type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </Field>
            <SecretFileOrText
              label="known_hosts (고정)"
              required
              hint="이 호스트의 고정된 known_hosts 항목. 서버가 호스트 키를 이 값으로만 신뢰합니다."
              value={knownHosts}
              onChange={setKnownHosts}
              accept=".txt,text/plain"
            />
          </>
        ) : (
          <>
            <p className="small muted" style={{ margin: 0 }}>
              빌드 후 Android 결과물(AAB/APK) 서명에 쓰는 키스토어입니다. 키스토어 파일과 암호는 보관함에 저장되고 빌드
              스크립트·로그에 남지 않습니다.
            </p>
            <Field label="키스토어 파일 (.jks/.keystore)" required hint="1MiB 이하. 파일 바이트를 base64로 로컬 API에만 전송합니다.">
              <label className="btn" style={{ cursor: 'pointer', width: 'fit-content' }}>
                <Upload size={14} /> 키스토어 선택
                <input
                  type="file"
                  accept=".jks,.keystore,application/octet-stream"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    setKeystoreError('');
                    const f = e.target.files?.[0];
                    if (!f) return;
                    try {
                      const b64 = await readFileBase64(f);
                      setKeystoreBase64(b64);
                      setKeystoreName(`${f.name} (${Math.ceil(f.size / 1024)} KiB)`);
                    } catch (err) {
                      setKeystoreError(err instanceof Error ? err.message : '파일을 읽지 못했습니다.');
                      setKeystoreBase64('');
                      setKeystoreName('');
                    } finally {
                      e.target.value = '';
                    }
                  }}
                />
              </label>
              {keystoreName && <span className="field__hint">{keystoreName}</span>}
              {keystoreError && <span className="field__hint" style={{ color: 'var(--error)' }}>{keystoreError}</span>}
            </Field>
            <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <Field label="키스토어 암호" required htmlFor="bk-storepw">
                  <input id="bk-storepw" className="input" type="password" autoComplete="off" value={storePassword} onChange={(e) => setStorePassword(e.target.value)} />
                </Field>
              </div>
              <div style={{ flex: 1, minWidth: 160 }}>
                <Field label="키 별칭 (keyAlias)" required htmlFor="bk-alias">
                  <input id="bk-alias" className="input mono" value={keyAlias} onChange={(e) => setKeyAlias(e.target.value)} spellCheck={false} />
                </Field>
              </div>
            </div>
            <Field label="키 암호" hint="비우면 키스토어 암호를 사용합니다(선택).">
              <input className="input" type="password" autoComplete="off" value={keyPassword} onChange={(e) => setKeyPassword(e.target.value)} />
            </Field>
          </>
        )}

        {add.error && <Notice tone="error" title="등록 실패">{add.error.message}</Notice>}
      </div>
    </Modal>
  );
}

function RotateBuildCredentialModal({
  cred,
  refresh,
  onClose,
}: {
  cred: BuildCredential;
  refresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(cred.label);
  const upd = useAction<BuildCredential>(refresh);

  // SSH rotate
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [knownHosts, setKnownHosts] = useState('');
  // Android rotate
  const [keystoreBase64, setKeystoreBase64] = useState('');
  const [keystoreName, setKeystoreName] = useState('');
  const [keystoreError, setKeystoreError] = useState('');
  const [storePassword, setStorePassword] = useState('');
  const [keyPassword, setKeyPassword] = useState('');

  function credentials(): Record<string, string> {
    const c: Record<string, string> = {};
    if (cred.kind === 'ssh') {
      if (privateKey.trim()) c.privateKey = privateKey;
      if (passphrase) c.passphrase = passphrase;
      if (knownHosts.trim()) c.knownHosts = knownHosts;
    } else {
      if (keystoreBase64) c.keystoreBase64 = keystoreBase64;
      if (storePassword.trim()) c.storePassword = storePassword;
      if (keyPassword) c.keyPassword = keyPassword;
    }
    return c;
  }

  const demo = api.isDemo();
  const creds = credentials();
  const labelChanged = label.trim() !== cred.label && label.trim() !== '';
  // 데모: 비밀 없이 합성 회전(버전 증가)을 허용한다. 실제: 라벨 변경 또는 새 비밀이 있어야 한다.
  const nothingToDo = demo ? false : Object.keys(creds).length === 0 && !labelChanged;

  async function submit() {
    if (nothingToDo) return;
    // 서버는 credentials(객체)를 항상 요구한다. 라벨만 변경해도 빈 객체를 보내며,
    // 서버는 저장된 비밀을 재사용해 재검증하고 버전을 올린다.
    const body: { label?: string; credentials: Record<string, string> } = { credentials: creds };
    if (labelChanged) body.label = label.trim();
    const res = await upd.run(() => api.updateBuildCredential(cred.id, body));
    if (res?.ok) onClose();
  }

  return (
    <Modal
      title="빌드 키 수정·회전"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn btn--primary" onClick={() => void submit()} disabled={nothingToDo || upd.pending}>
            {upd.pending ? <Spinner /> : <RotateCw size={15} />} 저장
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <Notice tone="info">
          입력한 항목만 회전(교체)됩니다. 비운 항목은 그대로 유지되고, 저장된 기존 비밀은 화면에 표시되지 않습니다.
          회전하면 버전이 올라갑니다(현재 v{cred.version}).
        </Notice>
        <Field label="키 이름">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {demo ? (
          <Notice tone="info">
            데모 키는 라벨만 수정하거나, 비밀 입력 없이 합성 회전을 실행할 수 있습니다(버전 증가). 실제 비밀은 받지 않습니다.
          </Notice>
        ) : cred.kind === 'ssh' ? (
          <>
            <SecretFileOrText label="새 비공개 키" hint="회전할 때만 입력." value={privateKey} onChange={setPrivateKey} accept=".pem,.key,text/plain" />
            <Field label="패스프레이즈" hint="새 키에 암호가 있으면 입력.">
              <input className="input" type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </Field>
            <SecretFileOrText label="known_hosts 갱신" hint="핀 갱신이 필요할 때만 입력." value={knownHosts} onChange={setKnownHosts} accept=".txt,text/plain" />
          </>
        ) : (
          <>
            <Field label="새 키스토어 파일" hint="회전할 때만 선택(1MiB 이하).">
              <label className="btn btn--sm" style={{ cursor: 'pointer', width: 'fit-content' }}>
                <Upload size={13} /> 파일 선택
                <input
                  type="file"
                  accept=".jks,.keystore,application/octet-stream"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    setKeystoreError('');
                    const f = e.target.files?.[0];
                    if (!f) return;
                    try {
                      setKeystoreBase64(await readFileBase64(f));
                      setKeystoreName(`${f.name} (${Math.ceil(f.size / 1024)} KiB)`);
                    } catch (err) {
                      setKeystoreError(err instanceof Error ? err.message : '파일을 읽지 못했습니다.');
                    } finally {
                      e.target.value = '';
                    }
                  }}
                />
              </label>
              {keystoreName && <span className="field__hint">{keystoreName}</span>}
              {keystoreError && <span className="field__hint" style={{ color: 'var(--error)' }}>{keystoreError}</span>}
            </Field>
            <Field label="새 키스토어 암호" hint="회전할 때만 입력.">
              <input className="input" type="password" autoComplete="off" value={storePassword} onChange={(e) => setStorePassword(e.target.value)} />
            </Field>
            <Field label="새 키 암호" hint="회전할 때만 입력.">
              <input className="input" type="password" autoComplete="off" value={keyPassword} onChange={(e) => setKeyPassword(e.target.value)} />
            </Field>
          </>
        )}
        {upd.error && <Notice tone="error" title="저장 실패">{upd.error.message}</Notice>}
      </div>
    </Modal>
  );
}
