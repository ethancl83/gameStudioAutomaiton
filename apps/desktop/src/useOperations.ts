// 준비된 원격 러너 목록을 GET /operations 에서 한 번 읽어오는 훅.
// 빌드·출시 폼에서 러너 선택기에 쓴다. 실패·로딩은 조용히 처리하고(선택 사항), 비우면 로컬 빌드다.
import { useEffect, useState } from 'react';
import { api } from './api';
import type { RunnerRegistration } from '../../../packages/domain';

export function useReadyRunners(): { runners: RunnerRegistration[]; loading: boolean } {
  const [runners, setRunners] = useState<RunnerRegistration[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void api.getOperations().then((res) => {
      if (!alive) return;
      if (res.ok) setRunners(res.data.runners.filter((r) => r.status === 'ready' && r.id !== 'local'));
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { runners, loading };
}
