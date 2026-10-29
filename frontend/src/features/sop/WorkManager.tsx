import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, List, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { Empty } from "../../components/ui";
import type { Context, Workflow } from "../../types";
import {
  moduleHref,
  readWorkflow,
  resolveModuleLink,
  workflowKey,
} from "./workflows";
import { type WorkItem, workItemsKey } from "./workItems";
import { removeModuleEntries } from "./canvas";
import { DeleteDialog } from "./DeleteDialog";
import "./WorkManager.css";

export function WorkManager(c: Context) {
  const qc = useQueryClient();
  const records = useQuery<WorkItem[]>({
    queryKey: workItemsKey(c.org),
    queryFn: () => api(`/orgs/${c.org}/work-items`),
  });
  const workflows = useQuery<Workflow[]>({
    queryKey: workflowKey(c.org),
    queryFn: () => api(`/orgs/${c.org}/sops`),
  });
  const [search, setSearch] = useState("");
  const [workflowFilter, setWorkflowFilter] = useState("");
  const [target, setTarget] = useState<{
    record: WorkItem;
    workflow: Workflow;
  } | null>(null);
  const deletion = useMutation({
    mutationFn: ({
      record,
      workflow,
    }: {
      record: WorkItem;
      workflow: Workflow;
    }) =>
      api<Workflow>(`/orgs/${c.org}/sops/save`, {
        draftOnly: true,
        id: workflow.id,
        expectedRevision: workflow.revision,
        title: workflow.title,
        category: workflow.category,
        steps: removeModuleEntries(workflow.draft, record.moduleId),
      }),
    onSuccess: async (saved, { record }) => {
      qc.setQueryData<Workflow[]>(workflowKey(c.org), (records) =>
        records?.map((workflow) =>
          workflow.id === saved.id ? saved : workflow,
        ),
      );
      qc.setQueryData<WorkItem[]>(workItemsKey(c.org), (records) =>
        records?.filter((entry) => entry.id !== record.id),
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: workflowKey(c.org) }),
        qc.invalidateQueries({ queryKey: workItemsKey(c.org) }),
      ]);
      setTarget(null);
      c.notify("这项工作已从流程和清单中删除，具体做法保留");
    },
    onError: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: workflowKey(c.org) }),
        qc.invalidateQueries({ queryKey: workItemsKey(c.org) }),
      ]),
  });
  useEffect(() => {
    setSearch("");
    setWorkflowFilter("");
  }, [c.org]);
  useEffect(() => {
    if (
      workflowFilter &&
      workflows.isSuccess &&
      !workflows.data.some((workflow) => workflow.id === workflowFilter)
    )
      setWorkflowFilter("");
  }, [workflowFilter, workflows.data, workflows.isSuccess]);
  const canEdit = c.role !== "EMPLOYEE";

  const rows = useMemo(() => {
    const byId = new Map(
      (workflows.data || []).map((workflow) => [workflow.id, workflow]),
    );
    return (records.data || []).map((record) => {
      const workflow = byId.get(record.workflowId);
      const module =
        workflow &&
        readWorkflow(workflow.draft).modules.find(
          (entry) => entry.id === record.moduleId,
        );
      const match =
        workflow && module
          ? resolveModuleLink(workflow, module, workflows.data || [])
          : undefined;
      return {
        record,
        workflow,
        module,
        match,
        boardHref: `/workflows/${record.workflowId}?module=${encodeURIComponent(record.moduleId)}`,
        methodHref:
          workflow && module
            ? moduleHref(workflow, module, workflows.data || [])
            : undefined,
        searchText: [
          record.name,
          record.id,
          workflow?.title,
          workflow?.category,
        ]
          .join(" ")
          .normalize("NFC")
          .toLocaleLowerCase(),
      };
    });
  }, [records.data, workflows.data]);
  const keyword = search.trim().normalize("NFC").toLocaleLowerCase();
  const filtered = rows.filter(
    (row) =>
      (!workflowFilter || row.record.workflowId === workflowFilter) &&
      row.searchText.includes(keyword),
  );

  return (
    <section
      id="work-processes"
      className="work-manager-list"
      aria-label="工作清单"
    >
      <div className="work-manager-toolbar">
        <div className="work-manager-list-title">
          <List size={18} aria-hidden="true" />
          <h2>工作清单</h2>
          {records.isSuccess && <span>共 {rows.length} 项工作</span>}
        </div>
        <div className="work-manager-filters">
          <div className="search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索工作"
              placeholder="输入工作名称、流程名称或编号…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <select
            aria-label="选择流程"
            value={workflowFilter}
            onChange={(event) => setWorkflowFilter(event.target.value)}
          >
            <option value="">所有流程</option>
            {workflows.data?.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.title}
              </option>
            ))}
          </select>
        </div>
      </div>
      {records.isPending ? (
        <p className="muted work-manager-message" role="status">
          正在打开工作清单…
        </p>
      ) : records.isError ? (
        <div role="alert" className="error work-manager-message">
          工作清单没能打开：{records.error.message}
          <button onClick={() => records.refetch()}>重新打开</button>
        </div>
      ) : !rows.length ? (
        <p className="muted work-manager-message">还没有工作。</p>
      ) : !filtered.length ? (
        <Empty title="没有找到这项工作" body="换个词试试，或显示全部工作。">
          <button
            className="btn secondary"
            onClick={() => {
              setSearch("");
              setWorkflowFilter("");
            }}
          >
            显示全部工作
          </button>
        </Empty>
      ) : (
        <>
          {workflows.isError && (
            <div className="work-manager-link-error" role="alert">
              工作清单已打开，暂时打不开对应流程。
              <button onClick={() => workflows.refetch()}>重试</button>
            </div>
          )}
          <div
            className="work-manager-table-scroll"
            role="region"
            aria-label="工作清单，可以左右滑动"
            tabIndex={0}
          >
            <table className="work-manager-table">
              <caption className="work-manager-sr-only">
                每一行是一项工作，点击名称查看做法
              </caption>
              <thead>
                <tr>
                  <th scope="col">工作名称</th>
                  <th scope="col">编号</th>
                  <th scope="col">所属流程</th>
                  <th scope="col">具体做法</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(
                  ({ record, workflow, boardHref, methodHref, match }) => (
                    <tr key={record.id}>
                      <th scope="row">
                        {methodHref ? (
                          <Link className="work-manager-name" to={methodHref}>
                            <span
                              className="work-manager-module-icon"
                              aria-hidden="true"
                            />
                            <span>{record.name}</span>
                          </Link>
                        ) : (
                          <span className="work-manager-name">
                            <span
                              className="work-manager-module-icon"
                              aria-hidden="true"
                            />
                            <span>{record.name}</span>
                          </span>
                        )}
                      </th>
                      <td className="work-manager-record-id">
                        <span title={record.id}>{record.id.slice(0, 8)}</span>
                      </td>
                      <td>
                        <Link className="work-manager-workflow" to={boardHref}>
                          {workflow?.title ||
                            (workflows.isPending
                              ? "正在打开流程…"
                              : "打开流程")}
                          <ArrowUpRight size={12} aria-hidden="true" />
                        </Link>
                      </td>
                      <td>
                        {methodHref ? (
                          <Link className="work-manager-method" to={methodHref}>
                            {match?.detail
                              ? "查看做法"
                              : match?.status === "AMBIGUOUS"
                                ? "选择要用的做法"
                                : "写具体做法"}
                            <ArrowUpRight size={12} aria-hidden="true" />
                          </Link>
                        ) : (
                          <span className="work-manager-unavailable">
                            {workflows.isPending
                              ? "正在打开做法…"
                              : "暂时打不开"}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="work-manager-row-actions">
                          <Link
                            className="btn secondary work-manager-locate"
                            to={boardHref}
                          >
                            在流程里查看
                            <ArrowUpRight size={12} aria-hidden="true" />
                          </Link>
                          {canEdit && (
                            <button
                              type="button"
                              className="delete-button"
                              aria-label={`删除工作 ${record.name}`}
                              title="删除这项工作，也会从流程图中移除"
                              disabled={deletion.isPending || !workflow}
                              onClick={() => {
                                if (!workflow) return;
                                deletion.reset();
                                setTarget({ record, workflow });
                              }}
                            >
                              <Trash2 size={15} aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          <div className="work-manager-footnote">
            <span>
              共 {rows.length} 项，当前显示 {filtered.length} 项
            </span>
          </div>
        </>
      )}
      {target && (
        <DeleteDialog
          title="删除工作"
          name={target.record.name}
          description="这项工作也会从流程图中移除，连着它的箭头会一起删除，具体做法会保留。"
          busy={deletion.isPending}
          error={deletion.error?.message}
          onCancel={() => setTarget(null)}
          onConfirm={() => {
            if (!deletion.isPending) deletion.mutate(target);
          }}
        />
      )}
    </section>
  );
}
