import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ImagePlus,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, upload } from "../../api";
import { Button } from "../../components/ui";
import { WorkflowCanvas } from "./FlowBoard";
import {
  connectModuleEntries,
  disconnectModuleEntries,
  moveModuleEntries,
  removeModuleEntries,
  resizeModuleEntries,
} from "./canvas";
import { workItemsKey } from "./workItems";
import { boardSettingsChange } from "./boardSettingsChange";
import { renameModuleEntries } from "./renameModule";
import { boardSize, readBoardAxes } from "./boardAxes";
import { prepareDetailEditorScope } from "./detailEditorScope";
import type { Context, Workflow, WorkflowDetailDocument } from "../../types";
import {
  exampleWorkflow,
  newDetail,
  normalizeName,
  readWorkflow,
  serializeWorkflow,
  validateContent,
  workflowKey,
} from "./workflows";
import {
  editableContent,
  editorBackupKey,
  useWorkflowAutosave,
  type EditorDraft,
} from "./useWorkflowAutosave";

import {
  readEditorBackupForEditor,
  type EditorBackupRecord,
} from "./editorBackups";
import { bindContentDetails } from "./detailBindings";

export function WorkflowEditor(c: Context) {
  const { id } = useParams();
  return <WorkflowEditorForm {...c} key={`${c.org}:${id || "new"}`} />;
}

function WorkflowEditorForm(c: Context) {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const targetName =
    params.has("detail") || params.has("detailId")
      ? normalizeName(params.get("detail") || "")
      : null;
  const targetDetailId = params.get("detailId");
  const targetScopeKey =
    targetName === null ? null : JSON.stringify([targetName, targetDetailId]);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery<Workflow[]>({
    queryKey: workflowKey(c.org),
    queryFn: () => api(`/orgs/${c.org}/sops`),
  });
  const [restoredBackup, setRestoredBackup] =
    useState<EditorBackupRecord | null>(() =>
      !id && !params.has("example") && c.role !== "EMPLOYEE"
        ? readEditorBackupForEditor(
            editorBackupKey(String(c.user.id), c.org, "new"),
          )
        : null,
    );
  const [draft, setDraft] = useState<EditorDraft | null>(() =>
    id
      ? null
      : (restoredBackup?.backup.draft ??
        (params.has("example")
          ? structuredClone(exampleWorkflow)
          : {
              title: "",
              category: "日常工作",
              modules: [],
              details: [],
            })),
  );
  const [tab, setTab] = useState<"modules" | "details">(
    targetName !== null ? "details" : "modules",
  );
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  const [composing, setComposing] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [initial, setInitial] = useState<Workflow | null>(null);
  const [restoredRevision, setRestoredRevision] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [scope, setScope] = useState<{
    key: string | null;
    name: string;
    status: "OPENING" | "MATCHED" | "AMBIGUOUS" | "INVALID";
    id?: string;
  } | null>(null);
  const [pendingDetail, setPendingDetail] =
    useState<WorkflowDetailDocument | null>(null);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const pendingDetailRef = useRef(pendingDetail);
  pendingDetailRef.current = pendingDetail;
  const appliedScope = useRef<string | null>(null);
  const scopeRequest = useRef(0);
  useEffect(
    () => () => {
      scopeRequest.current++;
    },
    [],
  );
  const autosave = useWorkflowAutosave({
    id,
    org: c.org,
    user: String(c.user.id),
    draft,
    initial,
    restoredRevision,
    restoredBackup,
    enabled: c.role !== "EMPLOYEE",
    paused: composing,
  });
  const [focusDetailId, setFocusDetailId] = useState<string | null>(null);
  useEffect(() => {
    if (tab === "details" && focusDetailId)
      document
        .getElementById(`detail-editor-${focusDetailId}`)
        ?.scrollIntoView({ block: "start" });
  }, [tab, focusDetailId, draft?.details.length]);
  useEffect(() => {
    if (!id || !q.data || draft) return;
    const record = q.data.find((w) => w.id === id);
    if (!record) return;
    const backupRecord =
      c.role !== "EMPLOYEE"
        ? readEditorBackupForEditor(
            editorBackupKey(String(c.user.id), c.org, record.id),
          )
        : null;
    const backup = backupRecord?.backup;
    setRestoredBackup(backupRecord);
    const content = backup?.draft || editableContent(record);
    if (targetName !== null) {
      const selected = prepareDetailEditorScope(
        content.details,
        targetName,
        targetDetailId,
      );
      appliedScope.current = targetScopeKey;
      setScope({
        key: targetScopeKey,
        name: targetName,
        status: selected.status,
        id: selected.detail?.id,
      });
      setPendingDetail(selected.pending ? selected.detail : null);
      setFocusDetailId(selected.detail?.id || null);
    }
    setDraft({
      ...content,
      title: backup?.draft.title ?? record.title,
      category: backup?.draft.category ?? record.category ?? "",
      revision: record.revision,
      boardSettings:
        backup?.draft.boardSettings ?? record.boardSettings ?? null,
    });
    setInitial(record);
    setRestoredRevision(backup?.revision ?? null);
  }, [
    id,
    q.data,
    draft,
    targetName,
    targetDetailId,
    targetScopeKey,
    c.org,
    c.role,
    c.user.id,
  ]);
  useEffect(() => {
    if (!draft || appliedScope.current === targetScopeKey) return;
    const request = ++scopeRequest.current;
    if (targetScopeKey === null) {
      appliedScope.current = null;
      setScope(null);
      setPendingDetail(null);
      setFocusDetailId(null);
      setTab("modules");
      void autosave.flush();
      return;
    }
    const selectedId =
      scope?.id === targetDetailId && scope.name !== targetName
        ? null
        : targetDetailId;
    setScope({
      key: targetScopeKey,
      name: targetName || "",
      status: "OPENING",
    });
    void (async () => {
      await autosave.flush();
      if (request !== scopeRequest.current || !latestDraft.current) return;
      const selected = prepareDetailEditorScope(
        latestDraft.current.details,
        targetName || "",
        selectedId,
      );
      appliedScope.current = targetScopeKey;
      setScope({
        key: targetScopeKey,
        name: targetName || "",
        status: selected.status,
        id: selected.detail?.id,
      });
      setPendingDetail(selected.pending ? selected.detail : null);
      setFocusDetailId(selected.detail?.id || null);
      setTab("details");
    })();
    return () => {
      scopeRequest.current++;
    };
  }, [targetScopeKey, !!draft, autosave.flush]);
  useEffect(() => {
    if (
      !id ||
      !scope?.id ||
      scope.status !== "MATCHED" ||
      scope.key !== targetScopeKey
    )
      return;
    const selected =
      draft?.details.find((detail) => detail.id === scope.id) ||
      (pendingDetail?.id === scope.id ? pendingDetail : null);
    if (!selected) return;
    const name = normalizeName(selected.title);
    if (targetName === name && targetDetailId === selected.id) return;
    const nextParams = new URLSearchParams(params);
    nextParams.set("detail", name);
    nextParams.set("detailId", selected.id);
    const key = JSON.stringify([name, selected.id]);
    appliedScope.current = key;
    setScope({ ...scope, key, name });
    setParams(nextParams, { replace: true });
  }, [
    id,
    scope,
    draft,
    pendingDetail,
    targetScopeKey,
    targetName,
    targetDetailId,
    params,
    setParams,
  ]);
  if (c.role === "EMPLOYEE")
    return (
      <main>
        <h1>这里的内容只能查看</h1>
        <p>需要修改时，请联系能编辑这些内容的人。</p>
        <Link className="btn secondary" to="/">
          返回首页
        </Link>
      </main>
    );
  if (!draft)
    return (
      <main>
        {q.isPending ? (
          <p className="muted">正在打开流程…</p>
        ) : q.isError ? (
          <p role="alert" className="error">
            {q.error.message}
          </p>
        ) : (
          <>
            <h1>未找到这个流程</h1>
            <Link className="btn secondary" to="/">
              返回首页
            </Link>
          </>
        )}
      </main>
    );
  const current = draft;
  const activeScope =
    targetScopeKey !== null && scope?.key !== targetScopeKey
      ? {
          key: targetScopeKey,
          name: targetName || "",
          status: "OPENING" as const,
          id: undefined,
        }
      : scope;
  const singleDetail = activeScope !== null;
  const displayedDetails = singleDetail
    ? [
        current.details.find((detail) => detail.id === activeScope.id) ||
          (pendingDetail?.id === activeScope.id ? pendingDetail : undefined),
      ].filter((detail): detail is WorkflowDetailDocument => !!detail)
    : current.details;
  const returnHref = id
    ? `/workflows/${encodeURIComponent(params.get("from") || id)}`
    : "/";
  function applyCanvasSteps(steps: unknown[]) {
    const content = readWorkflow(JSON.stringify(steps));
    setDraft({ ...current, ...content });
  }
  function updateDetail(
    detailId: string,
    patch: Partial<WorkflowDetailDocument>,
  ) {
    const pending = pendingDetailRef.current;
    if (pending?.id === detailId) {
      const edited = { ...pending, ...patch };
      if (JSON.stringify(edited) === JSON.stringify(pending)) return;
      setDraft((d) => {
        if (!d) return d;
        const prepared = bindContentDetails(
          { ...d, details: [...d.details, pending] },
          id,
          q.data || [],
        );
        return bindContentDetails(
          {
            ...prepared,
            details: prepared.details.map((detail) =>
              detail.id === pending.id ? edited : detail,
            ),
          },
          id,
          q.data || [],
        );
      });
      pendingDetailRef.current = null;
      setPendingDetail(null);
      return;
    }
    setDraft(
      (d) =>
        d &&
        (() => {
          const bound = bindContentDetails(d, id, q.data || []);
          return bindContentDetails(
            {
              ...bound,
              details: bound.details.map((detail) =>
                detail.id === detailId ? { ...detail, ...patch } : detail,
              ),
            },
            id,
            q.data || [],
          );
        })(),
    );
  }
  async function authorDetail(name = "") {
    const request = ++scopeRequest.current;
    if (!normalizeName(name)) {
      const created = newDetail();
      setDraft((d) => d && { ...d, details: [...d.details, created] });
      setScope(null);
      setPendingDetail(null);
      setFocusDetailId(created.id);
      setTab("details");
      setError("");
      return;
    }
    if (id) await autosave.flush();
    if (request !== scopeRequest.current || !latestDraft.current) return;
    const selected = prepareDetailEditorScope(
      latestDraft.current.details,
      name,
    );
    const canonicalName = normalizeName(selected.detail?.title || name);
    let key: string | null = null;
    if (id) {
      const nextParams = new URLSearchParams(params);
      nextParams.set("detail", canonicalName);
      if (selected.detail) nextParams.set("detailId", selected.detail.id);
      else nextParams.delete("detailId");
      key = JSON.stringify([canonicalName, selected.detail?.id || null]);
      appliedScope.current = key;
      setParams(nextParams, { replace: true });
    }
    setScope({
      key,
      name: canonicalName,
      status: selected.status,
      id: selected.detail?.id,
    });
    setPendingDetail(selected.pending ? selected.detail : null);
    setFocusDetailId(selected.detail?.id || null);
    setTab("details");
    setError("");
  }
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (id) {
      await autosave.flush();
      return;
    }
    if (creating.current) return;
    const validation = validateContent(current);
    setError(validation || "");
    if (validation) return;
    creating.current = true;
    setBusy(true);
    try {
      const saved = await api<Workflow>(`/orgs/${c.org}/sops/save`, {
        ...(id ? { id, expectedRevision: current.revision } : {}),
        title: current.title.trim(),
        category: current.category.trim(),
        steps: serializeWorkflow(current),
        boardSettings: current.boardSettings ?? null,
      });
      qc.setQueryData<Workflow[]>(workflowKey(c.org), (old) => [
        ...(old || []).filter((w) => w.id !== saved.id),
        saved,
      ]);
      await qc.invalidateQueries({ queryKey: workflowKey(c.org) });
      await qc.invalidateQueries({ queryKey: workItemsKey(c.org) });
      autosave.clearSavedBackup();
      navigate(`/workflows/${saved.id}`);
      c.notify("已保存。点击流程里的工作，就能打开名称相同的做法。");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      creating.current = false;
      setBusy(false);
    }
  }
  return (
    <main
      className="workflow-editor modular-editor"
      aria-label={id ? "流程编辑" : "添加流程"}
    >
      <div className={id ? "editor-topline" : undefined}>
        <Link
          className="back-link"
          to={returnHref}
          onClick={async (event) => {
            if (
              !id ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            if (leaving) return;
            setLeaving(true);
            const saved = await autosave.flush();
            if (!saved)
              c.notify("还有内容未同步，草稿已留在本机；再次修改时会恢复。");
            navigate(returnHref);
          }}
        >
          <ArrowLeft size={15} />
          {id ? "返回流程" : "返回首页"}
        </Link>
        {id ||
        restoredBackup ||
        current.title ||
        current.modules.length ||
        current.details.length ? (
          <span
            className="editor-save-status muted"
            role="status"
            aria-label="自动保存状态"
            aria-live="polite"
          >
            {autosave.status}
          </span>
        ) : null}
      </div>
      {!id && (
        <div className="page-title">
          <div>
            <h1>添加流程</h1>
          </div>
          <button
            className="btn"
            type="submit"
            form="workflow-editor-form"
            disabled={busy || uploading !== null}
          >
            <Plus size={16} />
            {busy ? "正在添加…" : "添加流程"}
          </button>
        </div>
      )}
      {(error || autosave.error) && (
        <p role="alert" className="error editor-error">
          {error || autosave.error}
          {autosave.canRetry && (
            <button
              type="button"
              className="text-button"
              onClick={autosave.retry}
            >
              重试
            </button>
          )}
        </p>
      )}
      <form
        id="workflow-editor-form"
        onSubmit={save}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      >
        <fieldset disabled={busy || uploading !== null}>
          {(!id || !singleDetail) && (
            <section className="panel workflow-basics">
              <h2>流程信息</h2>
              <div className="form-grid">
                <label>
                  流程名称
                  <input
                    required
                    maxLength={200}
                    value={current.title}
                    placeholder="例如：开店准备流程"
                    onChange={(e) =>
                      setDraft({ ...current, title: e.target.value })
                    }
                  />
                </label>
                <label>
                  分类
                  <input
                    maxLength={100}
                    list="workflow-categories"
                    value={current.category}
                    onChange={(e) =>
                      setDraft({ ...current, category: e.target.value })
                    }
                  />
                  <datalist id="workflow-categories">
                    {[
                      ...new Set(
                        q.data?.map((w) => w.category).filter(Boolean) || [],
                      ),
                    ].map((category) => (
                      <option key={category} value={category} />
                    ))}
                  </datalist>
                </label>
              </div>
            </section>
          )}
          {!singleDetail && (
            <div
              className="tabs module-editor-tabs"
              role="tablist"
              aria-label="流程编辑内容"
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab === "modules"}
                className={tab === "modules" ? "active" : ""}
                onClick={() => setTab("modules")}
              >
                安排工作
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "details"}
                className={tab === "details" ? "active" : ""}
                onClick={() => setTab("details")}
              >
                写具体做法
              </button>
            </div>
          )}
          {singleDetail && !id && (
            <Button
              secondary
              onClick={() => {
                scopeRequest.current++;
                const nextParams = new URLSearchParams(params);
                nextParams.delete("detail");
                nextParams.delete("detailId");
                appliedScope.current = null;
                setParams(nextParams, { replace: true });
                setScope(null);
                setPendingDetail(null);
                setFocusDetailId(null);
                setTab("modules");
              }}
            >
              <ArrowLeft size={15} />
              返回安排工作
            </Button>
          )}
          {!singleDetail && tab === "modules" ? (
            <section role="tabpanel" aria-label="安排工作">
              <WorkflowCanvas
                workflow={{
                  id: id || "draft-template",
                  title: current.title || "当前流程",
                  category: current.category,
                  revision: current.revision || 0,
                  draft: JSON.stringify(serializeWorkflow(current)),
                  boardSettings: current.boardSettings,
                }}
                workflows={q.data || []}
                canEdit
                busy={busy || uploading !== null}
                onBoardSettingsChange={(boardSettings) => {
                  const change = boardSettingsChange(
                    JSON.stringify(serializeWorkflow(current)),
                    current.boardSettings,
                    boardSettings,
                  );
                  setDraft({
                    ...current,
                    ...readWorkflow(JSON.stringify(change.steps)),
                    boardSettings: change.boardSettings,
                  });
                }}
                onAdd={(module) => {
                  if (module.detailWorkflowId === "draft-template")
                    delete module.detailWorkflowId;
                  setDraft({
                    ...current,
                    modules: [...current.modules, module],
                  });
                }}
                onArrange={(_snapshot, steps) => applyCanvasSteps(steps)}
                onMove={(moduleId, position) =>
                  applyCanvasSteps(
                    moveModuleEntries(
                      JSON.stringify(serializeWorkflow(current)),
                      moduleId,
                      position,
                      boardSize(readBoardAxes(current.boardSettings)),
                    ),
                  )
                }
                onResize={(moduleId, size) =>
                  applyCanvasSteps(
                    resizeModuleEntries(
                      JSON.stringify(serializeWorkflow(current)),
                      moduleId,
                      size,
                      boardSize(readBoardAxes(current.boardSettings)),
                    ),
                  )
                }
                onConnect={(sourceId, targetId, ports) =>
                  applyCanvasSteps(
                    connectModuleEntries(
                      JSON.stringify(serializeWorkflow(current)),
                      sourceId,
                      targetId,
                      ports,
                    ),
                  )
                }
                onDisconnect={(sourceId, targetId) =>
                  applyCanvasSteps(
                    disconnectModuleEntries(
                      JSON.stringify(serializeWorkflow(current)),
                      sourceId,
                      targetId,
                    ),
                  )
                }
                onRemove={(moduleId) =>
                  applyCanvasSteps(
                    removeModuleEntries(
                      JSON.stringify(serializeWorkflow(current)),
                      moduleId,
                    ),
                  )
                }
                onRename={(moduleId, name) =>
                  applyCanvasSteps(
                    renameModuleEntries(
                      {
                        id: id || "draft-template",
                        title: current.title,
                        category: current.category,
                        revision: current.revision || 0,
                        draft: JSON.stringify(serializeWorkflow(current)),
                        boardSettings: current.boardSettings,
                      },
                      moduleId,
                      name,
                      q.data || [],
                    ),
                  )
                }
                onAuthorDetail={authorDetail}
              />
            </section>
          ) : (
            <section role="tabpanel" aria-label="写具体做法">
              <div className="editor-section-heading">
                <div>
                  <h2>具体做法</h2>
                </div>
                {!singleDetail && (
                  <Button secondary onClick={() => authorDetail()}>
                    <Plus size={15} />
                    添加一份做法
                  </Button>
                )}
              </div>
              {activeScope && activeScope.status !== "MATCHED" && (
                <div className="panel empty">
                  <h3>{activeScope.name || "具体做法"}</h3>
                  <p role="status">
                    {activeScope.status === "OPENING"
                      ? "正在打开这项工作的做法…"
                      : activeScope.status === "AMBIGUOUS"
                        ? "有多份做法使用这个名称，暂时无法确定要打开哪一份。请先区分这些做法的名称。"
                        : "还没有确定要编辑哪项工作的做法。请返回流程重新选择。"}
                  </p>
                </div>
              )}
              {displayedDetails.map((detail) => {
                const foundIndex = current.details.findIndex(
                  (entry) => entry.id === detail.id,
                );
                const detailIndex =
                  foundIndex < 0 ? current.details.length : foundIndex;
                return (
                  <section
                    className="panel detail-editor"
                    id={`detail-editor-${detail.id}`}
                    key={detail.id}
                    aria-label={`具体做法 ${detailIndex + 1}`}
                  >
                    <div className="step-editor-heading">
                      <span className="instruction-number">
                        {String(detailIndex + 1).padStart(2, "0")}
                      </span>
                      <h3>{detail.title || "还没填写工作名称"}</h3>
                      {!singleDetail && (
                        <div className="step-editor-actions">
                          <button
                            type="button"
                            aria-label={`删除具体做法 ${detailIndex + 1}`}
                            onClick={() =>
                              setDraft({
                                ...current,
                                details: current.details.filter(
                                  (d) => d.id !== detail.id,
                                ),
                              })
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      )}
                    </div>
                    <label>
                      对应的工作名称
                      <input
                        maxLength={200}
                        placeholder="填写这份做法对应的工作名称"
                        value={detail.title}
                        onChange={(e) =>
                          updateDetail(detail.id, { title: e.target.value })
                        }
                      />
                    </label>
                    {!singleDetail && (
                      <p className="detail-name-note">
                        {normalizeName(detail.title) &&
                        current.modules.some(
                          (m) =>
                            normalizeName(m.title) ===
                            normalizeName(detail.title),
                        )
                          ? "名称一样，点击流程里的这项工作就能打开这份做法。"
                          : "流程里还没有这个名称的工作。可以添加这项工作，或在这里填写已有工作的名称。"}
                      </p>
                    )}
                    <div className="manual-step-list">
                      <h3>一步一步怎么做</h3>
                      {detail.items.map((item, itemIndex) => (
                        <div className="manual-step-editor" key={item.id}>
                          <span className="manual-step-index">
                            {itemIndex + 1}
                          </span>
                          <label>
                            步骤 {itemIndex + 1}
                            <textarea
                              rows={3}
                              value={item.text}
                              placeholder="手动填写这一步的具体做法…"
                              onChange={(e) =>
                                updateDetail(detail.id, {
                                  items: detail.items.map((existing) =>
                                    existing.id === item.id
                                      ? { ...existing, text: e.target.value }
                                      : existing,
                                  ),
                                })
                              }
                            />
                          </label>
                          <div className="step-editor-actions">
                            <button
                              type="button"
                              aria-label={`上移步骤 ${itemIndex + 1}`}
                              disabled={itemIndex === 0}
                              onClick={() => {
                                const items = [...detail.items];
                                [items[itemIndex - 1], items[itemIndex]] = [
                                  items[itemIndex],
                                  items[itemIndex - 1],
                                ];
                                updateDetail(detail.id, { items });
                              }}
                            >
                              <ArrowUp size={14} />
                            </button>
                            <button
                              type="button"
                              aria-label={`下移步骤 ${itemIndex + 1}`}
                              disabled={itemIndex === detail.items.length - 1}
                              onClick={() => {
                                const items = [...detail.items];
                                [items[itemIndex + 1], items[itemIndex]] = [
                                  items[itemIndex],
                                  items[itemIndex + 1],
                                ];
                                updateDetail(detail.id, { items });
                              }}
                            >
                              <ArrowDown size={14} />
                            </button>
                            <button
                              type="button"
                              aria-label={`删除步骤 ${itemIndex + 1}`}
                              onClick={() =>
                                updateDetail(detail.id, {
                                  items: detail.items.filter(
                                    (existing) => existing.id !== item.id,
                                  ),
                                })
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      ))}
                      <Button
                        secondary
                        onClick={() =>
                          updateDetail(detail.id, {
                            items: [
                              ...detail.items,
                              { id: crypto.randomUUID(), text: "" },
                            ],
                          })
                        }
                      >
                        <Plus size={14} />
                        添加步骤
                      </Button>
                    </div>
                    <details className="step-media">
                      <summary>
                        <ImagePlus size={15} />
                        添加参考图片或视频{" "}
                        <span className="optional">选填</span>
                      </summary>
                      <div className="form-grid">
                        <div>
                          <label>
                            参考图片
                            <input
                              type="file"
                              accept="image/png,image/jpeg"
                              onChange={async (e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                setError("");
                                if (file.size > 5 * 1024 * 1024) {
                                  setError("图片不能超过 5 MB。");
                                  return;
                                }
                                setUploading(detail.id);
                                try {
                                  updateDetail(detail.id, {
                                    imageUrl: await upload(c.org, file),
                                  });
                                } catch (err) {
                                  setError((err as Error).message);
                                } finally {
                                  setUploading(null);
                                }
                              }}
                            />
                          </label>
                          {uploading === detail.id && (
                            <p className="muted">正在上传…</p>
                          )}
                          {detail.imageUrl && (
                            <div className="editor-image">
                              <img
                                src={detail.imageUrl}
                                alt={`${detail.title || "具体做法"}的参考图片`}
                              />
                              <button
                                type="button"
                                aria-label={`移除具体做法 ${detailIndex + 1} 的图片`}
                                onClick={() =>
                                  updateDetail(detail.id, { imageUrl: "" })
                                }
                              >
                                <X size={14} />
                                移除图片
                              </button>
                            </div>
                          )}
                        </div>
                        <label>
                          操作视频链接
                          <input
                            type="url"
                            pattern="https://.*"
                            placeholder="https://…"
                            value={detail.videoUrl || ""}
                            onChange={(e) =>
                              updateDetail(detail.id, {
                                videoUrl: e.target.value,
                              })
                            }
                          />
                        </label>
                      </div>
                    </details>
                  </section>
                );
              })}
              {!singleDetail && !current.details.length && (
                <div className="panel empty">
                  <p>还没有写具体做法。</p>
                </div>
              )}
            </section>
          )}
          {!singleDetail && (
            <div className="editor-footer">
              <p className="muted">
                工作和做法的名称要一样；英文字母的大小写也要一致，两头的空格不影响。
              </p>
            </div>
          )}
        </fieldset>
      </form>
    </main>
  );
}
