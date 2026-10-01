// 가져온 개발 작업의 상태 표시·진행 단계 규칙. 목록·상세·이슈/PR 행이 같은 상태 이름을 쓴다.
import type { DevelopmentTask } from "../../../../../packages/development/types";

type Tone = "ok" | "warn" | "error" | "info" | "neutral" | "progress";
export type Status = DevelopmentTask["status"];
// 작업 상세의 실행·승인·정리 버튼이 보내는 개발 action.
export type TaskAction =
  | "implement"
  | "analyze"
  | "verify"
  | "cancel"
  | "commit"
  | "push"
  | "pr"
  | "reconcile-push"
  | "preview-check"
  | "cleanup";

export const statusInfo: Record<Status, [string, Tone]> = {
  imported: ["가져옴", "neutral"],
  analyzing: ["분석 중", "progress"],
  planned: ["계획 준비됨", "info"],
  implementing: ["구현 중", "progress"],
  reviewing: ["리뷰 중", "progress"],
  verifying: ["검증 중", "progress"],
  ready: ["반영 승인 대기", "warn"],
  committed: ["커밋됨", "ok"],
  pushed: ["푸시됨", "ok"],
  failed: ["실패", "error"],
  cancelled: ["중지됨", "neutral"],
  action_required: ["확인 필요", "warn"],
};
export const RUNNING: Status[] = ["analyzing", "implementing", "reviewing", "verifying"];
export const FINAL: Status[] = ["committed", "pushed"];
export const STEPS = ["가져옴", "분석", "계획", "구현·리뷰", "검증", "커밋", "푸시", "PR"];
export const DOCS = [
  ["source", "원본"],
  ["plan.md", "계획"],
  ["context.md", "맥락"],
  ["tasks.md", "작업 목록"],
  ["review.json", "리뷰"],
  ["diff", "변경사항"],
] as const;
export type DocName = (typeof DOCS)[number][0];
export interface TaskDocument {
  taskId: string;
  name: DocName;
  text: string;
}

export function nextStep(task: DevelopmentTask, testCommand: string): string {
  switch (task.status) {
    case "imported":
    case "analyzing":
      return "AI가 원본 자료를 분석해 계획·맥락·작업 문서를 만들고 있습니다.";
    case "planned":
      return "계획 문서를 확인한 뒤 구현을 시작하세요.";
    case "implementing":
    case "reviewing":
      return "AI가 구현하고 독립 리뷰를 진행합니다. 끝나면 자동으로 검증합니다.";
    case "verifying":
      return `격리된 환경에서 검증 명령(${testCommand || "미설정"})을 실행하고 있습니다.`;
    case "ready":
      return "검증을 통과했습니다. 변경사항을 확인하고 커밋을 승인하세요.";
    case "committed":
      return "커밋했습니다. 원격 저장소 반영을 승인하세요.";
    case "pushed":
      return task.prUrl ? "PR이 등록되었습니다." : "푸시했습니다. PR 등록을 승인하세요.";
    case "failed":
      return "터미널과 문서를 확인한 뒤 필요한 단계를 다시 실행하세요.";
    case "cancelled":
      return "작업을 중지했습니다. 작업 파일은 보존되어 있어 다시 실행할 수 있습니다.";
    case "action_required":
      return "이전 실행이 중단되었거나 원격 결과 확인이 필요합니다. 상태를 확인한 뒤 다시 실행하세요.";
  }
}

export function stepProgress(task: DevelopmentTask): { done: number; current: number } {
  const at: Partial<Record<Status, number>> = {
    imported: 1,
    analyzing: 1,
    planned: 3,
    implementing: 3,
    reviewing: 3,
    verifying: 4,
    ready: 5,
    committed: 6,
    pushed: task.prUrl ? 8 : 7,
  };
  const reached =
    at[task.status] ?? (task.commitSha ? 6 : task.verifiedFingerprint ? 5 : 1);
  return { done: reached, current: reached };
}
