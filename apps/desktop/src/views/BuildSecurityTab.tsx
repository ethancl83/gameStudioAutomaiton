// 프로젝트 빌드 보안: Android 서명 키 선택 + SSH 빌드 의존성 목록.
// - SSH 의존성: 빌드 전에 사설 저장소에서 안전하게 가져와 스냅샷의 지정 경로에 배치(서버가 처리).
// - Android 키: 빌드 후 결과물 서명(서버가 처리).
// 자격 증명 자체는 여기서 다루지 않는다(설정 → 빌드 키에서 1회 등록). 비밀은 빌드 스크립트·스냅샷·로그에 남지 않는다.
import { useMemo, useState } from 'react';
import { GitBranch, KeyRound, Plus, Server, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useAction } from '../useAction';
import { Card, Field, Notice, Spinner } from '../components/ui';
import type { AppState, BuildSshDependency, Project } from '../../../../packages/domain';

// 스냅샷 하위 상대 경로만 허용한다(절대 경로·상위 이탈 금지).
function invalidRelativePath(p: string): string | null {
  const t = p.trim();
  if (t === '') return '경로를 입력하세요.';
  if (t.startsWith('/') || /^[A-Za-z]:[\\/]/.test(t)) return '스냅샷 하위 상대 경로여야 합니다(절대 경로 불가).';
  if (t.split(/[\\/]/).some((seg) => seg === '..')) return '상위 경로(..)로 이탈할 수 없습니다.';
  return null;
}

export function BuildSecurityTab({
  project,
  state,
  refresh,
}: {
  project: Project;
  state: AppState;
  refresh: () => Promise<void>;
}) {
  const creds = state.buildCredentials ?? [];
  const androidCreds = useMemo(() => creds.filter((c) => c.kind === 'android-keystore'), [creds]);
  const sshCreds = useMemo(() => creds.filter((c) => c.kind === 'ssh'), [creds]);

  const [androidKeystoreId, setAndroidKeystoreId] = useState(project.buildSecurity?.androidKeystoreId ?? '');
  const [deps, setDeps] = useState<BuildSshDependency[]>(project.buildSecurity?.sshDependencies ?? []);
  const save = useAction<Project>(refresh);

  const isAndroid = project.targets.includes('android') || project.engine === 'android';

  function updateDep(i: number, patch: Partial<BuildSshDependency>) {
    setDeps((d) => d.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function addDep() {
    setDeps((d) => [...d, { credentialId: '', repositoryUrl: '', revision: '', relativePath: '' }]);
  }
  function removeDep(i: number) {
    setDeps((d) => d.filter((_, idx) => idx !== i));
  }

  // 유효성: 각 의존성의 필수값과 상대 경로.
  const depErrors = deps.map((d) => {
    if (!d.credentialId) return 'SSH 키를 선택하세요.';
    if (!d.repositoryUrl.trim()) return '저장소 URL을 입력하세요.';
    if (!d.revision.trim()) return '브랜치/태그 등 리비전을 입력하세요.';
    return invalidRelativePath(d.relativePath);
  });
  const hasError = depErrors.some((e) => e !== null);
  const androidMissing = androidKeystoreId !== '' && !androidCreds.some((c) => c.id === androidKeystoreId);

  async function submit() {
    if (hasError) return;
    await save.run(() =>
      api.setBuildSecurity(project.id, {
        androidKeystoreId: androidKeystoreId || undefined,
        sshDependencies: deps.map((d) => ({
          credentialId: d.credentialId,
          repositoryUrl: d.repositoryUrl.trim(),
          revision: d.revision.trim(),
          relativePath: d.relativePath.trim(),
        })),
      }),
    );
  }

  const noCreds = creds.length === 0;

  return (
    <div className="stack">
      <Notice tone="info">
        <div className="stack" style={{ gap: 4 }}>
          <span className="small">
            <strong>SSH 의존성</strong>은 빌드 <em>전에</em> 사설 저장소에서 안전하게 내려받아 스냅샷의 지정한 상대 경로에
            배치됩니다(예: <span className="mono">addons/private_sdk</span>). <strong>Android 서명 키</strong>는 빌드
            <em> 후</em> 결과물 서명에 쓰입니다.
          </span>
          <span className="small">
            자격 증명은 서버가 안전하게 사용하며 빌드 스크립트·스냅샷·로그에는 절대 들어가지 않습니다. 한 번 등록한 키를
            여러 빌드에서 재사용하고 매번 로그인을 요구하지 않습니다.
          </span>
        </div>
      </Notice>

      {noCreds && (
        <Notice tone="warn">
          등록된 빌드 키가 없습니다. 먼저 <strong>환경·정책 → 빌드 서명·SSH 키</strong>에서 SSH 키나 Android 키스토어를
          등록하세요.
        </Notice>
      )}

      <Card title="Android 서명 키" icon={KeyRound}>
        {!isAndroid && (
          <p className="small muted" style={{ marginTop: 0 }}>
            이 프로젝트에서 Android 타깃을 탐지하지 못했습니다. Android 빌드를 하지 않으면 비워 두어도 됩니다.
          </p>
        )}
        <Field label="서명에 사용할 키스토어" htmlFor="bs-android" hint="빌드된 AAB/APK 서명에 사용합니다. 실제 서명은 서버가 수행합니다.">
          <select id="bs-android" className="select" value={androidKeystoreId} onChange={(e) => setAndroidKeystoreId(e.target.value)} disabled={androidCreds.length === 0}>
            <option value="">사용 안 함</option>
            {androidCreds.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} · {c.fingerprint.slice(0, 24)}…
              </option>
            ))}
          </select>
        </Field>
        {androidCreds.length === 0 && <p className="small muted">등록된 Android 키스토어가 없습니다.</p>}
        {androidMissing && (
          <Notice tone="warn">이전에 선택한 키스토어를 더 이상 찾을 수 없습니다(삭제되었을 수 있음). 다시 선택하세요.</Notice>
        )}
      </Card>

      <Card
        title="SSH 빌드 의존성"
        icon={Server}
        actions={
          <button className="btn btn--sm" onClick={addDep} disabled={sshCreds.length === 0}>
            <Plus size={13} /> 의존성 추가
          </button>
        }
      >
        {sshCreds.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>등록된 SSH 키가 없습니다. 설정에서 먼저 SSH 키를 등록하세요.</p>
        ) : deps.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>
            사설 저장소 의존성이 없습니다. “의존성 추가”로 SSH 키·저장소·리비전·배치 경로를 지정하세요.
          </p>
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            {deps.map((d, i) => (
              <div key={i} className="card" style={{ boxShadow: 'none' }}>
                <div className="card__body">
                  <div className="row row--between">
                    <span className="small muted row" style={{ gap: 5 }}>
                      <GitBranch size={13} /> 의존성 #{i + 1}
                    </span>
                    <button className="btn btn--ghost btn--sm" onClick={() => removeDep(i)} aria-label="의존성 제거">
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <Field label="SSH 키" required>
                        <select className="select" value={d.credentialId} onChange={(e) => updateDep(i, { credentialId: e.target.value })}>
                          <option value="">키 선택</option>
                          {sshCreds.map((c) => (
                            <option key={c.id} value={c.id}>{c.label}</option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <div style={{ flex: 2, minWidth: 220 }}>
                      <Field label="저장소 URL" required hint="예: ssh://git@github.com/org/private-sdk.git">
                        <input className="input mono" value={d.repositoryUrl} onChange={(e) => updateDep(i, { repositoryUrl: e.target.value })} placeholder="ssh://git@…" spellCheck={false} />
                      </Field>
                    </div>
                  </div>
                  <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <Field label="리비전(브랜치/태그)" required hint="고정 태그·커밋 권장">
                        <input className="input mono" value={d.revision} onChange={(e) => updateDep(i, { revision: e.target.value })} placeholder="v1.2.0 또는 main" spellCheck={false} />
                      </Field>
                    </div>
                    <div style={{ flex: 2, minWidth: 220 }}>
                      <Field label="배치 경로(스냅샷 하위 상대 경로)" required hint="예: addons/private_sdk">
                        <input className="input mono" value={d.relativePath} onChange={(e) => updateDep(i, { relativePath: e.target.value })} placeholder="addons/private_sdk" spellCheck={false} />
                      </Field>
                    </div>
                  </div>
                  {depErrors[i] && <Notice tone="error">{depErrors[i]}</Notice>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {save.error && <Notice tone="error" title="빌드 보안 저장 실패">{save.error.message}</Notice>}
      <div className="row" style={{ gap: 10 }}>
        <button className="btn btn--primary" onClick={() => void submit()} disabled={save.pending || hasError || noCreds}>
          {save.pending ? <Spinner /> : <ShieldCheck size={15} />} 빌드 보안 저장
        </button>
        {save.result && <span className="small" style={{ color: 'var(--ok)' }}>저장되었습니다.</span>}
      </div>
    </div>
  );
}
