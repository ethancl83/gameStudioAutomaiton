// 프로젝트별 개발 자동화 설정(자동 구현·커밋·푸시·PR·Preview 조회와 검증 명령).
import { useCallback, useEffect, useState } from "react";
import type { DevelopmentPolicy } from "../../../../../packages/development/types";
import { api } from "../../api";
import { Spinner } from "../../components/ui";
import type { DevelopmentRequests } from "./useDevelopmentRequests";

// 편집 중인 정책은 불러온 프로젝트(policyFor)를 함께 기억해, 다른 프로젝트의 늦은 응답이나 편집 내용이
// 현재 프로젝트에 표시·저장되지 않게 한다.
export function useDevelopmentPolicy({ projectId, projectRef, act, setInfo }: DevelopmentRequests) {
  const [policy, setPolicy] = useState<DevelopmentPolicy | null>(null);
  const [savedPolicy, setSavedPolicy] = useState<DevelopmentPolicy | null>(null);
  const [policyFor, setPolicyFor] = useState("");
  const dirty = !!policy && !!savedPolicy && JSON.stringify(policy) !== JSON.stringify(savedPolicy);

  const load = useCallback(async () => {
    if (!projectId) return;
    const r = await api.studio("policy", { projectId });
    if (projectRef.current !== projectId || !r.ok) return;
    setPolicy(r.data);
    setSavedPolicy(r.data);
    setPolicyFor(projectId);
  }, [projectId, projectRef]);
  useEffect(() => {
    setPolicy(null);
    setSavedPolicy(null);
    setPolicyFor("");
    void load();
  }, [load]);

  async function save() {
    // 불러온 프로젝트와 현재 프로젝트가 같을 때만 저장한다(다른 프로젝트 정책 덮어쓰기 방지).
    if (!policy || policyFor !== projectId) return;
    const r = await act("policy-save", { policy });
    if (r) {
      setPolicy(r);
      setSavedPolicy(r);
      setInfo("자동화 설정을 저장했습니다.");
    }
  }
  return {
    policy: policyFor === projectId ? policy : null,
    saved: savedPolicy,
    dirty,
    load,
    change: setPolicy,
    reset: () => setPolicy(savedPolicy),
    save,
  };
}

export function PolicyCard({
  policy,
  dirty,
  pending,
  onChange,
  onReset,
  onSave,
}: {
  policy: DevelopmentPolicy | null;
  dirty: boolean;
  pending: string;
  onChange: (p: DevelopmentPolicy) => void;
  onReset: () => void;
  onSave: () => void;
}) {
  const options = [
    ["autoImplement", "분석 후 자동 구현", "계획 문서가 만들어지면 바로 구현·리뷰·검증을 진행합니다."],
    ["autoCommit", "검증 통과 시 자동 커밋", "검증 설정·테스트 파일이 바뀐 경우에는 멈추고 승인을 요청합니다."],
    ["autoPush", "자동 커밋 후 자동 푸시", "Git 배포 연동이 켜진 저장소는 푸시가 Preview 빌드를 시작할 수 있습니다."],
    ["autoPr", "푸시 후 자동 PR 등록", ""],
    [
      "autoPreview",
      "푸시 후 Git 연동 Preview 결과 조회",
      "GitHub에 기록된 Netlify·Vercel Git 연동 Preview의 상태와 URL만 읽어 옵니다. 이 앱이 따로 배포하지는 않습니다.",
    ],
  ] as const;
  return (
    <details className="card">
      <summary className="card__head" style={{ cursor: "pointer" }}>
        <h2 className="card__title">프로젝트 자동화 설정</h2>
        {policy && (
          <span className="small muted" style={{ marginLeft: "auto" }}>
            {dirty
              ? "저장하지 않은 변경"
              : options.filter(([k]) => policy[k]).length
                ? `자동 ${options.filter(([k]) => policy[k]).length}단계 켜짐`
                : "모든 단계 승인 필요"}
          </span>
        )}
      </summary>
      <div className="card__body">
        {!policy ? (
          <Spinner />
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {options.map(([key, label, hint]) => {
              const blocked = key === "autoPush" && !policy.autoCommit;
              return (
                <label className="checkbox-row" key={key} style={{ opacity: blocked ? 0.6 : 1 }}>
                  <input
                    type="checkbox"
                    checked={policy[key]}
                    disabled={blocked}
                    onChange={(e) =>
                      onChange({
                        ...policy,
                        [key]: e.target.checked,
                        ...(key === "autoCommit" && !e.target.checked ? { autoPush: false } : {}),
                      })
                    }
                  />
                  <span>
                    {label}
                    {(hint || blocked) && (
                      <span className="small muted" style={{ display: "block" }}>
                        {blocked ? "자동 커밋을 켜야 사용할 수 있습니다." : hint}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
            <label className="field" style={{ marginTop: 6 }}>
              <span className="field__label">검증 명령</span>
              <input
                className="input"
                value={policy.testCommand}
                placeholder="예: npm test (가져올 때 package.json에서 자동으로 채웁니다)"
                onChange={(e) => onChange({ ...policy, testCommand: e.target.value })}
              />
              <span className="field__hint">인증 정보가 없는 격리 환경의 작업 worktree에서 실행합니다.</span>
            </label>
            <div className="row">
              <button className="btn btn--primary" disabled={!dirty || !!pending || api.isDemo()} onClick={onSave}>
                자동화 설정 저장
              </button>
              {dirty && (
                <button className="btn btn--ghost" onClick={onReset}>
                  되돌리기
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
