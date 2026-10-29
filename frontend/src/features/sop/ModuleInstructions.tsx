import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, Pencil } from "lucide-react";
import { useEffect } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import type { Context, Workflow } from "../../types";
import {
  normalizeName,
  readWorkflow,
  resolveInstructionLink,
  workflowKey,
} from "./workflows";

export function ModuleInstructions(c: Context) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const name = normalizeName(params.get("name") || "");
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [id, name]);
  const q = useQuery<Workflow[]>({
    queryKey: workflowKey(c.org),
    queryFn: () => api(`/orgs/${c.org}/sops`),
  });
  const workflow = q.data?.find((w) => w.id === id);
  if (q.isPending)
    return (
      <main>
        <p className="muted">正在找这项工作的做法…</p>
      </main>
    );
  if (q.isError)
    return (
      <main>
        <p role="alert" className="error">
          {q.error.message}
        </p>
      </main>
    );
  if (!workflow)
    return (
      <main>
        <h1>未找到这个流程</h1>
        <Link to="/" className="btn secondary">
          返回首页
        </Link>
      </main>
    );
  const match = resolveInstructionLink(
    workflow,
    name,
    q.data || [],
    params.get("module"),
    params.get("detailId"),
  );
  const detail = match.detail;
  const detailWorkflow = match.targetWorkflow || workflow;
  const returnWorkflow =
    q.data?.find((entry) => entry.id === params.get("from")) || workflow;
  const selectedModule = readWorkflow(workflow.draft).modules.find(
    (module) =>
      module.id === params.get("module") &&
      normalizeName(module.title) === name,
  );
  const alias =
    typeof selectedModule?.detailName === "string"
      ? normalizeName(selectedModule.detailName)
      : "";
  const instructionName = normalizeName(detail?.title || alias || name);
  const editParams = new URLSearchParams({
    detail: instructionName,
    from: returnWorkflow.id,
    ...(detail ? { detailId: detail.id } : {}),
  });
  const editHref = `/workflows/${detailWorkflow.id}/edit?${editParams}`;
  const missingSource =
    typeof selectedModule?.detailWorkflowId === "string" &&
    selectedModule.detailWorkflowId !== workflow.id &&
    !match.targetWorkflow;
  const fixedDocument =
    params.has("detailId") || selectedModule?.detailId !== undefined;
  if (
    !detail &&
    c.role !== "EMPLOYEE" &&
    instructionName &&
    !missingSource &&
    !fixedDocument
  )
    return <Navigate to={editHref} replace />;
  return (
    <main className="module-instructions">
      <Link className="back-link" to={`/workflows/${returnWorkflow.id}`}>
        <ArrowLeft size={15} />
        {returnWorkflow.title} · 返回流程
      </Link>
      {!detail ? (
        <>
          <div className="page-title">
            <div>
              <span className="tag">具体做法</span>
              <h1>{name || "没有选择工作"}</h1>
            </div>
          </div>
          <div className="instruction-card">
            <p className="muted">
              {missingSource
                ? "这项工作引用的做法暂时无法打开。"
                : match.status === "AMBIGUOUS"
                  ? "有几份名称相同的做法，暂时无法确定这一项。"
                  : fixedDocument
                    ? "原来对应的做法找不到了，请返回流程重新选择。"
                    : "还没有写这项工作的做法。"}
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="page-title">
            <div>
              <span className="tag">具体做法</span>
              <h1>{detail.title}</h1>
            </div>
            {c.role !== "EMPLOYEE" && (
              <Link className="btn secondary" to={editHref}>
                <Pencil size={15} />
                修改具体做法
              </Link>
            )}
          </div>
          <div className="instruction-card">
            <section className="instruction-method">
              <h2>具体步骤</h2>
              {!detail.items.length && <p className="muted">暂无具体步骤。</p>}
              <ol
                className="manual-instructions"
                aria-label={`${detail.title}的具体步骤`}
              >
                {detail.items.map((item, index) => (
                  <li key={item.id || index}>
                    <span aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <p>{item.text}</p>
                  </li>
                ))}
              </ol>
            </section>
            {detail.imageUrl && (
              <figure>
                <img
                  src={detail.imageUrl}
                  alt={`${detail.title}的操作参考图`}
                />
                <figcaption>操作参考图</figcaption>
              </figure>
            )}
            {detail.videoUrl && (
              <a
                className="video-link"
                href={detail.videoUrl}
                target="_blank"
                rel="noreferrer"
              >
                观看操作视频
                <ArrowUpRight size={15} />
              </a>
            )}
          </div>
        </>
      )}
    </main>
  );
}
