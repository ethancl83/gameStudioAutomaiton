import { useRef, useState } from "react";
import { api, type DevelopmentAction, type DevelopmentResponses } from "../../api";

export type DevelopmentRequests = ReturnType<typeof useDevelopmentRequests>;

// 선택한 개발 프로젝트와, 그 프로젝트를 대상으로 보낸 개발 요청의 진행·오류·안내 상태.
export function useDevelopmentRequests(initialProjectId: string) {
  const [projectId, setProjectId] = useState(initialProjectId);
  // 비동기 응답은 요청을 보낸 프로젝트가 아직 선택되어 있을 때만 화면 상태에 반영한다.
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const pendingSeq = useRef(0);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [pending, setPending] = useState("");

  // scoped 동작의 응답은 프로젝트가 바뀐 뒤 도착하면 버린다. 저장소 목록·Clone처럼 프로젝트와 무관한
  // 동작은 scoped=false로 호출해 완료 결과를 잃지 않는다.
  async function act<A extends DevelopmentAction>(
    action: A,
    input: Record<string, unknown> = {},
    scoped = true,
  ): Promise<DevelopmentResponses[A] | undefined> {
    const requested = projectId;
    const token = ++pendingSeq.current;
    setPending(action);
    setError("");
    setInfo("");
    try {
      const r = await api.studio(action, { projectId: requested, ...input });
      if (scoped && projectRef.current !== requested) return;
      if (!r.ok) {
        setError(r.error.message);
        return;
      }
      return r.data;
    } finally {
      if (pendingSeq.current === token) setPending("");
    }
  }
  function clearNotices() {
    setError("");
    setInfo("");
  }
  function selectProject(next: string) {
    projectRef.current = next;
    setProjectId(next);
    // 이전 프로젝트의 안내·오류는 새 프로젝트에 남기지 않는다(호출한 쪽이 새 안내를 이어서 설정할 수 있다).
    clearNotices();
  }

  return { projectId, projectRef, selectProject, act, pending, error, info, setError, setInfo, clearNotices };
}
