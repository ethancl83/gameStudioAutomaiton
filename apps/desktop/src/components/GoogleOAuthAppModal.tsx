import { useState } from 'react';
import { ExternalLink, KeyRound } from 'lucide-react';
import { api } from '../api';
import { useAction } from '../useAction';
import { Field, Modal, Notice, Spinner } from './ui';

export function GoogleOAuthAppModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const [client, setClient] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useAction<{ registered: true }>();

  async function importClient(file?: File) {
    setClient(null);
    setError(null);
    if (!file) return;
    try {
      if (file.size > 64 * 1024) throw new Error('클라이언트 JSON 파일이 너무 큽니다.');
      const parsed = JSON.parse(await file.text());
      if (!parsed?.installed || typeof parsed.installed.client_id !== 'string' || parsed.web || parsed.type) {
        throw new Error('Google Cloud에서 받은 데스크톱 앱 클라이언트 JSON을 선택하세요.');
      }
      setClient(parsed);
    } catch (error) {
      setError(error instanceof SyntaxError ? '올바른 JSON 파일을 선택하세요.' : error instanceof Error ? error.message : 'JSON 파일을 읽지 못했습니다.');
    }
  }

  async function submit() {
    const result = await save.run(() => api.registerGoogleOAuthApp(client));
    if (result?.ok) { await onSaved(); onClose(); }
  }

  return <Modal title="Google OAuth 앱 등록" onClose={onClose} footer={<>
    <button className="btn" onClick={onClose} disabled={save.pending}>닫기</button>
    <button className="btn btn--primary" onClick={() => void submit()} disabled={!client || save.pending}>
      {save.pending ? <Spinner /> : <KeyRound size={15} />} 공통 앱으로 저장
    </button>
  </>}>
    <div className="stack">
      <p className="muted small">한 번 등록하면 Google Play·Google Ads·AdMob 연결에서 함께 사용합니다. 실제 Google 계정 로그인은 각 서비스의 계정 연결에서 진행합니다.</p>
      <div>
        <div className="section-title">1. Google Cloud에서 앱 등록</div>
        <p className="small muted">클라이언트 유형을 ‘데스크톱 앱’으로 만들고 JSON을 다운로드하세요. 이미 받았다면 바로 가져오면 됩니다.</p>
        <button className="btn" onClick={async () => {
          const result = await api.openExternal('https://console.cloud.google.com/auth/clients');
          if (!result.ok) setError(result.error ?? '등록 화면을 열지 못했습니다.');
        }}><ExternalLink size={15} /> Google 등록 화면 열기</button>
      </div>
      <Field label="2. 클라이언트 JSON 가져오기" htmlFor="google-app-json" hint="클라이언트 ID와 시크릿은 OS 보관함으로 보호해 저장합니다.">
        <input id="google-app-json" type="file" accept=".json,application/json" disabled={save.pending} onChange={e => void importClient(e.target.files?.[0])} />
      </Field>
      {client !== null && <Notice tone="info">파일을 읽었습니다. ‘공통 앱으로 저장’을 누르면 등록됩니다.</Notice>}
      <p className="small muted">다른 앱으로 교체해도 기존 계정의 인증 정보는 유지됩니다. 새 계정을 연결할 때 새 설정을 사용합니다.</p>
      {error && <Notice tone="error">{error}</Notice>}
      {save.error && <Notice tone="error">{save.error.message}</Notice>}
    </div>
  </Modal>;
}
