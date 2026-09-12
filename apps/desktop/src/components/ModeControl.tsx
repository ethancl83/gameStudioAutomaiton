// 실행 모드 전환(데모 ↔ 실제) 컨트롤. 머리말에 항상 보인다.
// 권한 경계:
// - 네이티브(Electron): 실행 모드 권한은 main이 소유·영속한다. 실제(live) 전환은 main 소유의 단 하나의
//   확인창을 통과해야만 반영된다(renderer 확인창을 두지 않는다 — 이중 프롬프트·재로그인 없음). 데모
//   전환은 파괴적이지 않으므로 추가 확인 없이 즉시 반영한다. 전환은 api.requestModeSwitch가 main에
//   위임하고, 성공 시 전체 새로고침으로 새(불변) 클라이언트 인스턴스를 만들어 적용한다.
// - 브라우저(미리보기 폴백): 기존 UX 그대로 renderer 확인창을 띄운 뒤 선호를 저장하고 새로고침한다.
import { useState } from 'react';
import { FlaskConical, Radio } from 'lucide-react';
import { api, type RuntimeMode } from '../api';
import { Modal, Notice } from './ui';

export function ModeControl({
  mode,
  serverMode,
  setSwitching,
}: {
  mode: RuntimeMode;
  // 서버가 보고한 실제 응답 모드. 선호 모드와 일치해야 한다(전환 직후 잠시 어긋날 수 있음).
  serverMode?: 'demo' | 'live';
  setSwitching: (v: boolean) => void;
}) {
  // 브라우저 폴백 전용 확인창 상태. 네이티브는 main이 확인을 소유하므로 여기서 쓰지 않는다.
  const [confirm, setConfirm] = useState<RuntimeMode | null>(null);
  const demo = mode === 'demo';

  async function apply(next: RuntimeMode) {
    // 확인(네이티브는 main 소유 확인창)까지 통과한 뒤에만 오버레이를 켜고 새로고침한다. 취소·거부면
    // 아무 것도 바꾸지 않는다(재로그인·이중 프롬프트 없음).
    const r = await api.requestModeSwitch(next);
    if (!r.ok) return;
    setSwitching(true);
    // 실제 적용은 전체 새로고침으로 새 인스턴스를 만들어 수행한다(불변 클라이언트 + reload로 stale 차단).
    if (typeof window !== 'undefined') window.location.reload();
  }

  function choose(next: RuntimeMode) {
    if (next === mode) return;
    if (api.isElectron) {
      // 네이티브: 확인은 main이 소유한다(실제 전환 시 단 하나의 확인창). renderer 확인창을 띄우지 않는다.
      void apply(next);
    } else {
      // 브라우저 폴백: 기존 UX대로 renderer 확인창을 띄운다.
      setConfirm(next);
    }
  }

  return (
    <>
      <div
        className={`mode-switch ${demo ? 'mode-switch--demo' : 'mode-switch--live'}`}
        role="group"
        aria-label="실행 모드"
        title={demo ? '데모 데이터로 실행 중' : '실제 계정 모드로 실행 중'}
      >
        <span className="mode-switch__marker">
          {demo ? <FlaskConical size={13} aria-hidden /> : <Radio size={13} aria-hidden />}
          {demo ? '데모' : '실제'}
        </span>
        <div className="mode-switch__toggle">
          <button type="button" aria-pressed={demo} className={demo ? 'is-active' : ''} onClick={() => choose('demo')}>
            데모
          </button>
          <button type="button" aria-pressed={!demo} className={!demo ? 'is-active' : ''} onClick={() => choose('live')}>
            실제
          </button>
        </div>
        {serverMode && serverMode !== mode && <span className="mode-switch__sync" title="모드 전환 적용 중">…</span>}
      </div>

      {confirm && (
        <Modal
          title={confirm === 'live' ? '실제 계정 모드로 전환' : '데모 모드로 전환'}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(null)}>취소</button>
              <button
                className="btn btn--primary"
                onClick={() => {
                  const next = confirm;
                  setConfirm(null);
                  void apply(next);
                }}
              >
                {confirm === 'live' ? '실제 모드로 전환' : '데모 모드로 전환'}
              </button>
            </>
          }
        >
          <div className="stack" style={{ gap: 12 }}>
            {confirm === 'live' ? (
              <Notice tone="warn" title="실제 계정 모드">
                실제 모드에서는 연결된 실제 계정과 저장된 권한·정책·검증된 빌드만 사용합니다. 같은 화면·작업 흐름을
                그대로 쓰되, 게시·업로드·캠페인 등 외부 쓰기는 실제 공급자에 반영될 수 있습니다. 데모의 실행·자원은
                실제 계정으로 복사되지 않습니다.
              </Notice>
            ) : (
              <Notice tone="info" title="데모 모드">
                데모는 시드된 연결·프로젝트·지표를 별도 저장공간에서 제공하며 외부 공급자에 전송하지 않습니다. 실제
                모드의 데이터와 완전히 분리되어 있습니다.
              </Notice>
            )}
            <p className="small muted" style={{ margin: 0 }}>
              전환하면 작성 중인 입력창을 닫고 새 모드로 다시 시작합니다. 저장된 작업과 이력은 원래 모드에 유지됩니다.
            </p>
          </div>
        </Modal>
      )}
    </>
  );
}
