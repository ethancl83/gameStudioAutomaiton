// 액션 실행 헬퍼. 로딩/오류/성공 상태를 관리하고, 성공 시 상태를 새로고침한다.
// 외부 쓰기는 idempotencyKey를 사용자 작업 단위로 보존해 응답 유실 재시도 시 이중 반영을 막는다.
import { useCallback, useRef, useState } from 'react';
import type { ApiResult } from './api';
import type { ApiError } from '../../../packages/domain';

interface ActionState<T> {
  pending: boolean;
  error: ApiError | null;
  result: T | null;
}

export function useAction<T>(refresh?: () => Promise<void>) {
  const [s, setS] = useState<ActionState<T>>({ pending: false, error: null, result: null });
  const running = useRef(false);

  const run = useCallback(
    async (fn: () => Promise<ApiResult<T>>): Promise<ApiResult<T> | null> => {
      if (running.current) return null; // 이중 클릭 방지
      running.current = true;
      setS({ pending: true, error: null, result: null });
      const res = await fn();
      if (res.ok) {
        setS({ pending: false, error: null, result: res.data });
        if (refresh) await refresh();
      } else {
        setS({ pending: false, error: res.error, result: null });
      }
      running.current = false;
      return res;
    },
    [refresh],
  );

  const reset = useCallback(() => setS({ pending: false, error: null, result: null }), []);

  return { ...s, run, reset };
}

// crypto.randomUUID는 안전 컨텍스트(Electron/HTTPS/localhost)에서 사용 가능하다. 폴백을 둔다.
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
