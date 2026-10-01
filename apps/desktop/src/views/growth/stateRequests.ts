// 성장 화면의 선택 프로젝트 상태 조회 순서. 폴링은 앞 요청이 끝난 뒤에만 다음 요청을 예약해 느린 응답에도
// 요청이 쌓이지 않는다. 결과는 선택 프로젝트가 같고 더 나중에 시작한 요청의 결과가 아직 반영되지 않았을 때만 쓴다.
import type { ApiResult } from '../../../../../packages/domain';
import type { GrowthState } from '../../../../../packages/growth/types';

export function growthStateRequests(load: (projectId: string) => Promise<ApiResult<GrowthState>>, apply: (result: ApiResult<GrowthState>) => void, interval: number) {
  let project = '';
  let started = 0;
  let applied = 0;
  let stopPolling = () => {};

  /** 현재 선택 프로젝트를 조회한다. 작업 뒤 새로고침은 진행 중 폴링보다 나중에 시작하므로 그 폴링 결과가 덮어쓰지 못한다. */
  async function reload(): Promise<void> {
    const target = project;
    if (!target) return;
    const token = ++started;
    let result: ApiResult<GrowthState>;
    try { result = await load(target); } catch (error) { result = { ok: false, error: { code: 'request_failed', message: error instanceof Error ? error.message : String(error) } }; }
    if (token < applied || target !== project) return;
    applied = token;
    apply(result);
  }

  return {
    reload,
    /** 프로젝트를 선택해 즉시 조회하고 폴링한다. 빈 값은 중지(화면 해제)이며 이후 도착한 결과는 버린다. */
    select(projectId: string) {
      stopPolling();
      project = projectId;
      if (!projectId) return;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = () => { void reload().then(() => { if (!stopped) timer = setTimeout(poll, interval); }); };
      stopPolling = () => { stopped = true; clearTimeout(timer); };
      poll();
    },
  };
}
