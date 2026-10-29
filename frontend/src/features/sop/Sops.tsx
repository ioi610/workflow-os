import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import type { Context, Workflow } from "../../types";
import { readWorkflow, workflowKey } from "./workflows";
import { WorkManager } from "./WorkManager";
import { workItemsKey } from "./workItems";
import { DeleteDialog } from "./DeleteDialog";
import { TextDiagramControls } from "./TextDiagramControls";

export function Sops({
  workspaceSelector,
  ...c
}: Context & { workspaceSelector?: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery<Workflow[]>({
    queryKey: workflowKey(c.org),
    queryFn: () => api(`/orgs/${c.org}/sops`),
  });
  const [category, setCategory] = useState("全部流程");
  const [target, setTarget] = useState<Workflow | null>(null);
  const deletion = useMutation({
    mutationFn: (workflow: Workflow) =>
      api(
        `/orgs/${c.org}/sops/${workflow.id}`,
        { expectedRevision: workflow.revision },
        "DELETE",
      ),
    onSuccess: async (_, workflow) => {
      qc.setQueryData<Workflow[]>(workflowKey(c.org), (records) =>
        records?.filter((record) => record.id !== workflow.id),
      );
      setCategory("全部流程");
      await Promise.all([
        qc.invalidateQueries({ queryKey: workflowKey(c.org) }),
        qc.invalidateQueries({ queryKey: workItemsKey(c.org) }),
      ]);
      setTarget(null);
      c.notify("流程已删除");
    },
    onError: () => qc.invalidateQueries({ queryKey: workflowKey(c.org) }),
  });
  const canEdit = c.role !== "EMPLOYEE";
  const categories = [
    "全部流程",
    ...new Set(q.data?.map((w) => w.category).filter(Boolean) || []),
  ];
  const filtered = q.data?.filter(
    (w) => category === "全部流程" || w.category === category,
  );
  return (
    <main className="workflow-library">
      <div className="library-controls">
        <div className="tabs" aria-label="流程分类">
          {categories.map((cat) => (
            <button
              key={cat}
              className={category === cat ? "active" : ""}
              onClick={() => setCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
        <div className="library-extra-tools">
          <TextDiagramControls key={c.org} {...c} />
          {workspaceSelector}
        </div>
      </div>
      {q.isPending ? (
        <p className="muted">正在读取工作流程…</p>
      ) : q.isError ? (
        <div role="alert" className="error">
          {q.error.message}
          <button onClick={() => q.refetch()}>重新打开</button>
        </div>
      ) : (
        <>
          {!filtered?.length && !!q.data?.length && (
            <div className="library-no-results">
              <h2>没有找到相符的流程</h2>
              <button
                className="text-button"
                onClick={() => setCategory("全部流程")}
              >
                查看全部流程
              </button>
            </div>
          )}
          <div
            className="workflow-grid"
            role="region"
            aria-label="工作流程列表"
          >
            {filtered?.map((w) => {
              const steps = readWorkflow(w.draft).modules;
              return (
                <article
                  className="workflow-card"
                  data-workflow-id={w.id}
                  key={w.id}
                >
                  <Link
                    className="workflow-card-link"
                    to={`/workflows/${w.id}`}
                  >
                    <div className="workflow-card-top">
                      <span className="sop-icon">
                        <BookOpen size={23} />
                      </span>
                      <span className="tag">{w.category || "未分类"}</span>
                    </div>
                    <h2>{w.title}</h2>
                    <div className="workflow-outline">
                      {steps.slice(0, 3).map((s, index) => (
                        <div key={index}>
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          <p>{s.title}</p>
                        </div>
                      ))}
                      {steps.length > 3 && (
                        <p className="outline-more">
                          +{steps.length - 3} 项工作
                        </p>
                      )}
                    </div>
                    <div className="workflow-card-bottom">
                      <span>{steps.length} 项工作</span>
                      <ArrowRight size={17} />
                    </div>
                  </Link>
                  {canEdit && (
                    <button
                      type="button"
                      className="delete-button workflow-card-delete"
                      aria-label={`删除流程 ${w.title}`}
                      title="删除流程"
                      disabled={deletion.isPending}
                      onClick={() => {
                        deletion.reset();
                        setTarget(w);
                      }}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  )}
                </article>
              );
            })}
            {canEdit && (
              <Link
                className="workflow-create-tile"
                to="/workflows/new"
                aria-label="添加流程"
              >
                <span className="workflow-create-content">
                  <Plus size={34} strokeWidth={1.4} aria-hidden="true" />
                  <span>添加流程</span>
                </span>
              </Link>
            )}
          </div>
          {!q.data?.length && !canEdit && (
            <p className="muted">暂无工作流程。</p>
          )}
        </>
      )}
      <WorkManager {...c} />
      {target && (
        <DeleteDialog
          title="删除流程"
          name={target.title}
          description="这个流程里的工作和做法也会一起删除，删掉后无法恢复。"
          busy={deletion.isPending}
          error={deletion.error?.message}
          onCancel={() => setTarget(null)}
          onConfirm={() => {
            if (!deletion.isPending) deletion.mutate(target);
          }}
        />
      )}
    </main>
  );
}
