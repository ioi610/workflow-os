import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, FileText } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useState } from "react";
import { api } from "../../api";
import type { Context, Workflow } from "../../types";
import { detailHref, readWorkflow, workflowKey } from "./workflows";
import { FlowBoard } from "./FlowBoard";
import { TextDiagramControls } from "./TextDiagramControls";

export function WorkflowDetail(c: Context) {
  const { id } = useParams();
  const [showDirectory, setShowDirectory] = useState(false);
  const q = useQuery<Workflow[]>({
    queryKey: workflowKey(c.org),
    queryFn: () => api(`/orgs/${c.org}/sops`),
  });
  const workflow = q.data?.find((w) => w.id === id);
  if (q.isPending)
    return (
      <main>
        <p className="muted">正在打开流程…</p>
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
  const content = readWorkflow(workflow.draft);
  return (
    <main className="module-overview">
      <Link to="/" className="back-link">
        <ArrowLeft size={15} />
        返回首页
      </Link>
      <div className="page-title">
        <div>
          <span className="tag">{workflow.category || "未分类"}</span>
          <h1>{workflow.title}</h1>
        </div>
        <div className="workflow-title-actions">
          <TextDiagramControls
            key={c.org}
            {...c}
            preferredWorkflowId={workflow.id}
          />
          <Link
            className="btn secondary"
            to={`/workflows/${workflow.id}/complete`}
          >
            <FileText size={15} />
            生成完整流程
          </Link>
        </div>
      </div>
      <FlowBoard
        key={workflow.id}
        workflow={workflow}
        org={c.org}
        canEdit={c.role !== "EMPLOYEE"}
      />
      <div className="detail-directory">
        <button
          className="text-button"
          aria-expanded={showDirectory}
          onClick={() => setShowDirectory(!showDirectory)}
        >
          {showDirectory ? "收起做法列表" : "查看做法列表"}
        </button>
        {showDirectory && (
          <nav aria-label="做法列表">
            {content.details.map((detail) => (
              <Link key={detail.id} to={detailHref(workflow.id, detail.title)}>
                {detail.title}
                <ArrowUpRight size={14} />
              </Link>
            ))}
            {!content.details.length && (
              <p className="muted">还没有写具体做法。</p>
            )}
          </nav>
        )}
      </div>
    </main>
  );
}
