import { command, requireTool } from "./process.js";
import { repository } from "./git.js";
import type { GithubItem } from "./types.js";
import { AppError } from "../domain/errors.js";
export async function github<T>(
  endpoint: string,
  args: string[] = [],
): Promise<T> {
  return JSON.parse(
    await command(await requireTool("github"), ["api", endpoint, ...args], {
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      timeout: 60000,
    }),
  );
}
export async function repositories() {
  return github<
    Array<{
      id: number;
      full_name: string;
      clone_url: string;
      private: boolean;
    }>
  >("user/repos?per_page=100&sort=updated");
}
export async function listItems(
  repo: string,
  kind: "issue" | "pr",
  state = "open",
  page = 1,
) {
  if (
    !["open", "closed", "all"].includes(state) ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 1000
  )
    throw new AppError("INVALID_QUERY", "조회 조건을 확인하세요.");
  const items = await github<GithubItem[]>(
    `repos/${repository(repo)}/${kind === "pr" ? "pulls" : "issues"}?state=${state}&per_page=50&page=${page}`,
  );
  return {
    items: kind === "issue" ? items.filter((i) => !i.pull_request) : items,
    hasMore: items.length === 50,
    page,
  };
}
export async function sourceItem(
  repo: string,
  kind: "issue" | "pr",
  number: number,
  api: typeof github = github,
) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new AppError("INVALID_ITEM", "이슈 번호를 확인하세요.");
  const prefix = `repos/${repository(repo)}`;
  const item = await api<
    GithubItem & {
      head?: { sha: string; ref: string; repo: { full_name: string } | null };
      base?: { sha: string; ref: string };
    }
  >(`${prefix}/${kind === "pr" ? "pulls" : "issues"}/${number}`);
  const pages = async (endpoint: string): Promise<unknown[]> =>
    (await api<unknown[][]>(endpoint, ["--paginate", "--slurp"])).flat();
  const [comments, reviewComments, reviews, files, checks] = await Promise.all([
    pages(`${prefix}/issues/${number}/comments?per_page=100`),
    kind === "pr"
      ? pages(`${prefix}/pulls/${number}/comments?per_page=100`)
      : [],
    kind === "pr"
      ? pages(`${prefix}/pulls/${number}/reviews?per_page=100`)
      : [],
    kind === "pr"
      ? pages(`${prefix}/pulls/${number}/files?per_page=100`)
      : [],
    kind === "pr" && item.head?.sha
      ? Promise.all([
          api<{check_runs: unknown[]}[]>(`${prefix}/commits/${item.head.sha}/check-runs?per_page=100`, ['--paginate', '--slurp']).then(pages => pages.flatMap(page => page.check_runs)),
          api<unknown>(`${prefix}/commits/${item.head.sha}/status`),
        ])
      : [],
  ]);
  return {
    item,
    comments,
    reviewComments,
    reviews,
    files,
    checks,
    importedAt: new Date().toISOString(),
  };
}
