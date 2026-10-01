// GitHub 이슈·PR 목록 조회와 작업 가져오기 진입점.
import { useEffect, useRef, useState } from "react";
import { ExternalLink, GitPullRequest, ListTodo, Play, RefreshCw } from "lucide-react";
import type { DevelopmentTask, GitState, GithubItem } from "../../../../../packages/development/types";
import { api } from "../../api";
import { formatRelative } from "../../format";
import { Badge, Card, EmptyState, Notice, Spinner } from "../../components/ui";
import { statusInfo } from "./taskStatus";
import type { DevelopmentRequests } from "./useDevelopmentRequests";

export type ItemKind = "issue" | "pr";
export type GithubItems = ReturnType<typeof useGithubItems>;
interface ItemList {
  projectId: string;
  kind: ItemKind;
  state: string;
  page: number;
  hasMore: boolean;
  items: GithubItem[];
}

// 목록 응답은 요청 순번이 최신일 때만 반영한다. 탭·상태 필터·프로젝트가 바뀌면 순번을 올려
// 진행 중인 응답이 다른 탭(이슈↔PR)이나 다른 프로젝트에 표시되지 않게 한다.
export function useGithubItems({ projectId, act }: DevelopmentRequests) {
  const [list, setList] = useState<ItemList | null>(null);
  const seq = useRef(0);
  const [filter, setFilter] = useState("");
  const [itemState, setItemState] = useState("open");

  useEffect(() => {
    seq.current++;
    setList(null);
  }, [projectId]);

  async function load(kind: ItemKind, page = 1) {
    const token = ++seq.current;
    const result = await act("items", { kind, state: itemState, page });
    if (!result || token !== seq.current) return;
    setList({ projectId, kind, state: itemState, page, hasMore: result.hasMore, items: result.items });
  }
  function changeState(next: string) {
    seq.current++;
    setItemState(next);
    setList(null);
  }
  return {
    visible: (kind: ItemKind) => (list && list.projectId === projectId && list.kind === kind ? list : null),
    load,
    invalidate: () => void seq.current++,
    itemState,
    changeState,
    filter,
    setFilter,
  };
}

export function ItemsTab({
  kind,
  items,
  requests,
  tasks,
  git,
  demo,
  onGitTab,
  onOpenTask,
  onImport,
}: {
  kind: ItemKind;
  items: GithubItems;
  requests: DevelopmentRequests;
  tasks: DevelopmentTask[];
  git: GitState | null;
  demo: boolean;
  onGitTab: () => void;
  onOpenTask: (id: string) => void;
  onImport: (number: number, kind: ItemKind) => Promise<void>;
}) {
  const { pending } = requests;
  const { filter } = items;
  const listVisible = items.visible(kind);
  return (
    <Card title={kind === "pr" ? "프로젝트 PR" : "프로젝트 이슈"} icon={kind === "pr" ? GitPullRequest : ListTodo}>
      {!demo && git && !git.repository && (
        <Notice
          tone="warn"
          title="GitHub 저장소 연결이 필요합니다"
          action={
            <button className="btn btn--sm" onClick={onGitTab}>
              Git 탭에서 연결
            </button>
          }
        >
          이 프로젝트의 origin이 GitHub 저장소가 아닙니다.
        </Notice>
      )}
      <div className="row" style={{ marginTop: 4 }}>
        <select
          className="select"
          aria-label="상태"
          value={items.itemState}
          onChange={(e) => items.changeState(e.target.value)}
          style={{ width: 110 }}
        >
          <option value="open">열림</option>
          <option value="closed">닫힘</option>
          <option value="all">전체</option>
        </select>
        <input
          className="input"
          aria-label="제목 검색"
          placeholder="불러온 목록에서 제목 검색"
          value={filter}
          onChange={(e) => items.setFilter(e.target.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <button
          className="btn btn--primary"
          disabled={!!pending || demo || !git?.repository}
          onClick={() => void items.load(kind)}
        >
          {pending === "items" ? <Spinner /> : <RefreshCw size={13} aria-hidden />}
          {kind === "pr" ? "PR 불러오기" : "이슈 불러오기"}
        </button>
      </div>
      <p className="small muted">
        가져오면 전용 작업 브랜치와 worktree를 만들고 원본을 문서로 저장한 뒤, 분석용 AI가 계획·맥락·작업
        문서를 작성합니다. 원본 저장소 파일은 바꾸지 않습니다.
      </p>
      {!listVisible ? (
        <p className="muted small">{pending === "items" ? "불러오는 중…" : "목록을 불러오면 여기에 표시됩니다."}</p>
      ) : listVisible.items.length === 0 ? (
        <EmptyState icon={kind === "pr" ? GitPullRequest : ListTodo} title={kind === "pr" ? "PR이 없습니다" : "이슈가 없습니다"} />
      ) : (
        <div className="item-list">
          {listVisible.items
            .filter((i) => i.title.toLowerCase().includes(filter.toLowerCase()))
            .map((item) => {
              const existing = tasks.find((t) => t.kind === listVisible.kind && t.number === item.number);
              return (
                <div key={item.number} className="item-row">
                  <div className="item-row__main">
                    <div className="item-row__title">
                      #{item.number} {item.title}
                    </div>
                    <div className="item-row__meta">
                      <Badge tone={item.state === "open" ? "ok" : "neutral"}>{item.state === "open" ? "열림" : "닫힘"}</Badge>
                      {item.user?.login && <span>{item.user.login}</span>}
                      <span>갱신 {formatRelative(item.updated_at)}</span>
                    </div>
                    {item.body && (
                      <details>
                        <summary>본문 보기</summary>
                        <pre>{item.body}</pre>
                      </details>
                    )}
                  </div>
                  <div className="item-row__actions">
                    <button className="btn btn--sm btn--ghost" onClick={() => void api.openExternal(item.url)}>
                      <ExternalLink size={12} aria-hidden />
                      GitHub
                    </button>
                    {existing ? (
                      <button className="btn btn--sm" onClick={() => onOpenTask(existing.id)}>
                        작업 보기 · {statusInfo[existing.status][0]}
                      </button>
                    ) : (
                      <button
                        className="btn btn--sm btn--primary"
                        disabled={!!pending || demo}
                        onClick={() => void onImport(item.number, listVisible.kind)}
                      >
                        {pending === "import" ? <Spinner /> : <Play size={12} aria-hidden />}
                        가져와서 분석
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
        </div>
      )}
      {listVisible && (listVisible.page > 1 || listVisible.hasMore) && (
        <div className="row" style={{ marginTop: 12, justifyContent: "center" }}>
          <button
            className="btn btn--sm"
            disabled={listVisible.page <= 1 || !!pending}
            onClick={() => void items.load(listVisible.kind, listVisible.page - 1)}
          >
            이전
          </button>
          <span className="small muted">{listVisible.page}쪽</span>
          <button
            className="btn btn--sm"
            disabled={!listVisible.hasMore || !!pending}
            onClick={() => void items.load(listVisible.kind, listVisible.page + 1)}
          >
            다음
          </button>
        </div>
      )}
    </Card>
  );
}
