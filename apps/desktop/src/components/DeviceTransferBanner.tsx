// 장비 이전용 백업 뒤 이 장비의 자동화가 멈춰 있음을 모든 화면 위에 알린다.
// 다시 활성화는 새 장비의 자동화를 꺼 두었다는 사용자 확인을 받은 뒤에만 요청한다(두 장비 동시 운영 방지).
import { useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { api } from '../api';
import { formatDateTime } from '../format';
import { Modal, Notice, Spinner } from './ui';

export function DeviceTransferBanner({ transferredAt, refresh }: { transferredAt: string; refresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const close = () => { if (!pending) { setOpen(false); setChecked(false); setError(''); } };
  async function reclaim() {
    setPending(true); setError('');
    const result = await api.reclaimDevice();
    setPending(false);
    if (!result.ok) { setError(result.error.message); return; }
    setOpen(false); setChecked(false);
    await refresh();
  }
  return <>
    <div style={{ marginBottom: 16 }}>
      <Notice tone="warn" title="이 장비의 자동화가 중지되어 있습니다"
        action={<button className="btn btn--sm" onClick={() => setOpen(true)}><MonitorSmartphone size={14} />이 장비 다시 활성화</button>}>
        {formatDateTime(transferredAt)}에 장비 이전용 백업을 만들어 자동 빌드·배포·SNS·성장 운영을 멈췄습니다. 새 장비에서 계속 운영한다면 이 상태로 두세요.
      </Notice>
    </div>
    {open && <Modal title="이 장비 다시 활성화" onClose={close} footer={<>
      <button className="btn" onClick={close} disabled={pending}>취소</button>
      <button className="btn btn--primary" disabled={!checked || pending} onClick={() => void reclaim()}>{pending && <Spinner />}다시 활성화</button>
    </>}>
      <div className="stack">
        <p style={{ margin: 0 }}>두 장비가 같은 계정으로 동시에 자동화를 돌리면 광고 예산 변경·게시·답글이 중복될 수 있습니다.</p>
        <label className="checkbox-row"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />새 장비(백업을 복원한 장비)의 자동화를 꺼 두었거나 복원하지 않았음을 확인했습니다.</label>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Modal>}
  </>;
}
