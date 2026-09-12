// 실행 모드 전환(데모 ↔ 실제). 머리말에 항상 보이는 컨트롤이다.
// 데모는 시드 데이터·격리 저장공간이며 실제 공급자에 전송하지 않음을 분명히 표시한다.
// 전환 시 확인을 받고(실수 방지), appState가 상태를 비우고 화면을 다시 마운트한다.
import { useState } from 'react';
import { FlaskConical, Radio } from 'lucide-react';
import type { RuntimeMode } from '../api';
import { Modal, Notice } from './ui';

export function ModeSwitch({
  mode,
  serverMode,
  onSwitch,
}: {
  mode: RuntimeMode;
  // 서버가 보고한 실제 응답 모드. 선호 모드와 일치해야 한다(전환 직후 잠시 어긋날 수 있음).
  serverMode?: 'demo' | 'live';
  onSwitch: (mode: RuntimeMode) => void;
}) {
  const [confirm, setConfirm] = useState<RuntimeMode | null>(null);
  const demo = mode === 'demo';

  function choose(next: RuntimeMode) {
    if (next === mode) return;
    setConfirm(next);
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
          <button
            type="button"
            aria-pressed={demo}
            className={demo ? 'is-active' : ''}
            onClick={() => choose('demo')}
          >
            데모
          </button>
          <button
            type="button"
            aria-pressed={!demo}
            className={!demo ? 'is-active' : ''}
            onClick={() => choose('live')}
          >
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
                  onSwitch(confirm);
                  setConfirm(null);
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
