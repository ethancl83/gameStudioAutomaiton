// 작업 문서·Git 변경사항 표시. 서버가 준 문서 원문을 종류별로 읽기 쉽게 보여 준다.
import type { ReactNode } from "react";
import { Badge, Notice } from "../../components/ui";
import type { TaskDocument } from "./taskStatus";

export function TaskDocumentView({ doc }: { doc: TaskDocument }) {
  if (doc.name === "diff") return <DiffView text={doc.text || "기준 커밋 대비 변경이 없습니다."} />;
  if (doc.name === "review.json") return <ReviewView text={doc.text} />;
  if (doc.name === "source") return <SourceView text={doc.text} />;
  return <pre className="doc-view">{doc.text}</pre>;
}

export function DiffView({ text }: { text: string }) {
  return (
    <pre className="doc-view doc-view--code">
      {text.split("\n").map((line, i) => {
        const cls = line.startsWith("diff --git")
          ? "diff-file"
          : line.startsWith("@@")
            ? "diff-hunk"
            : line.startsWith("+") && !line.startsWith("+++")
              ? "diff-add"
              : line.startsWith("-") && !line.startsWith("---")
                ? "diff-del"
                : undefined;
        return cls ? (
          <span key={i} className={cls}>
            {line}
          </span>
        ) : (
          <span key={i}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

function ReviewView({ text }: { text: string }) {
  let review: { passed?: unknown; findings?: unknown } | null = null;
  try {
    review = JSON.parse(text);
  } catch {
    review = null;
  }
  if (!review || typeof review !== "object")
    return (
      <Notice tone="warn" title="리뷰 결과 형식을 읽지 못했습니다">
        <pre className="doc-view">{text}</pre>
      </Notice>
    );
  const findings = Array.isArray(review.findings) ? review.findings.map(String) : [];
  const passed = review.passed === true && findings.length === 0;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div>
        <Badge tone={passed ? "ok" : "error"}>{passed ? "리뷰 통과" : "보완 필요"}</Badge>
      </div>
      {findings.length > 0 ? (
        <div>
          {findings.map((f, i) => (
            <div key={i} className="finding">
              <span className="finding__body finding__msg">{f}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="small muted">차단 문제가 없습니다.</p>
      )}
    </div>
  );
}

// 원본 문서의 GitHub API 첨부(JSON)는 요약해서 보여 준다.
function SourceView({ text }: { text: string }) {
  const marker = "\n## 댓글·리뷰·변경 파일";
  const at = text.indexOf(marker);
  const head = at >= 0 ? text.slice(0, at) : text;
  const match = at >= 0 ? /```json\n([\s\S]*)\n```/.exec(text.slice(at)) : null;
  let data: { comments?: unknown; reviews?: unknown; files?: unknown } | null = null;
  try {
    data = match ? JSON.parse(match[1]!) : null;
  } catch {
    data = null;
  }
  const flat = (v: unknown): Array<Record<string, unknown>> =>
    Array.isArray(v) ? v.flatMap((x) => (Array.isArray(x) ? x : [x])).filter((x) => x && typeof x === "object") : [];
  const comments = flat(data?.comments);
  const reviews = flat(data?.reviews);
  const files = flat(data?.files);
  const who = (c: Record<string, unknown>) =>
    String((c.user as { login?: string } | undefined)?.login ?? "알 수 없음");
  return (
    <div className="stack" style={{ gap: 12 }}>
      <pre className="doc-view">{head.trim()}</pre>
      {data ? (
        <>
          {files.length > 0 && (
            <Section title={`변경 파일 ${files.length}개`}>
              {files.map((f, i) => (
                <div key={i} className="git-file">
                  <span className="git-file__path">{String(f.filename ?? "")}</span>
                  <span className="small" style={{ color: "var(--ok)" }}>+{String(f.additions ?? 0)}</span>
                  <span className="small" style={{ color: "var(--error)" }}>-{String(f.deletions ?? 0)}</span>
                </div>
              ))}
            </Section>
          )}
          <Section title={`댓글 ${comments.length}개`}>
            {comments.map((c, i) => (
              <div key={i} className="finding">
                <div className="finding__body">
                  <div className="finding__meta">{who(c)}</div>
                  <div className="small" style={{ whiteSpace: "pre-wrap" }}>{String(c.body ?? "")}</div>
                </div>
              </div>
            ))}
          </Section>
          {reviews.length > 0 && (
            <Section title={`코드 리뷰 댓글 ${reviews.length}개`}>
              {reviews.map((c, i) => (
                <div key={i} className="finding">
                  <div className="finding__body">
                    <div className="finding__meta">
                      {who(c)}
                      {c.path ? ` · ${String(c.path)}` : ""}
                    </div>
                    <div className="small" style={{ whiteSpace: "pre-wrap" }}>{String(c.body ?? "")}</div>
                  </div>
                </div>
              ))}
            </Section>
          )}
        </>
      ) : (
        at >= 0 && (
          <details>
            <summary className="small">첨부 자료 원문</summary>
            <pre className="doc-view doc-view--code">{text.slice(at)}</pre>
          </details>
        )
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="section-title">{title}</div>
      {children}
    </div>
  );
}
