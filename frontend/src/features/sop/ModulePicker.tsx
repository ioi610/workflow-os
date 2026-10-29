import { Check, Link2, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Workflow, WorkflowModule } from "../../types";
import {
  newModule,
  normalizeName,
  readWorkflow,
  resolveModuleLink,
} from "./workflows";
import { bindModuleDetail } from "./detailBindings";

type Props = {
  workflow: Workflow;
  workflows: Workflow[];
  onAdd: (module: WorkflowModule) => void | Promise<void>;
  onClose: () => void;
};

type WorkOption = {
  key: string;
  title: string;
  source: Workflow;
  targetId: string;
  detailId?: string;
  detailName?: string;
};

export function ModulePicker({ workflow, workflows, onAdd, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const options = useMemo(() => {
    const sources = new Map(workflows.map((source) => [source.id, source]));
    sources.set(workflow.id, workflow);
    return Array.from(sources.values()).flatMap((source) => {
      const content = readWorkflow(source.draft);
      const entries = new Map<string, WorkflowModule>();
      for (const module of content.modules)
        if (normalizeName(module.title))
          entries.set(normalizeName(module.title), module);
      for (const detail of content.details) {
        const title = normalizeName(detail.title);
        if (title && !entries.has(title))
          entries.set(title, { kind: "MODULE", id: detail.id, title });
      }
      return Array.from(entries.entries()).map(
        ([title, module]): WorkOption => {
          const match = resolveModuleLink(
            source,
            module,
            Array.from(sources.values()),
          );
          const linkedName =
            match.detail?.title ||
            (typeof module.detailName === "string"
              ? normalizeName(module.detailName)
              : "");
          return {
            key: JSON.stringify([source.id, title]),
            title,
            source,
            targetId:
              match.targetWorkflow?.id || module.detailWorkflowId || source.id,
            ...(match.detail?.id
              ? { detailId: match.detail.id }
              : typeof module.detailId === "string"
                ? { detailId: module.detailId }
                : {}),
            ...(linkedName && normalizeName(linkedName) !== title
              ? { detailName: linkedName }
              : {}),
          };
        },
      );
    });
  }, [workflow, workflows]);
  const selected = options.find((option) => option.key === selectedKey);
  const keyword = search.trim().toLocaleLowerCase();
  const visibleOptions = options.filter((option) =>
    `${option.title} ${option.source.title}`
      .toLocaleLowerCase()
      .includes(keyword),
  );
  const title = mode === "new" ? normalizeName(name) : selected?.title || "";
  const previewModule: WorkflowModule = {
    kind: "MODULE",
    id: "preview",
    title,
    ...(mode === "existing" && selected
      ? { detailWorkflowId: selected.targetId }
      : {}),
    ...(mode === "existing" && selected?.detailId
      ? { detailId: selected.detailId }
      : {}),
    ...(mode === "existing" && selected?.detailName
      ? { detailName: selected.detailName }
      : {}),
  };
  const match = title
    ? resolveModuleLink(workflow, previewModule, workflows)
    : undefined;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (busyRef.current) return;
    setError("");
    if (!title) {
      setError(mode === "new" ? "请填写工作名称。" : "请先选择一项工作。");
      return;
    }
    const modules = readWorkflow(workflow.draft).modules;
    if (modules.length >= 100) {
      setError("一个流程最多添加 100 项工作。");
      return;
    }
    if (modules.some((module) => normalizeName(module.title) === title)) {
      setError(`这个流程里已经有“${title}”了，请换个名称。`);
      return;
    }
    if (match?.status === "AMBIGUOUS") {
      setError("有几份名称相同的做法，请从工作清单里选一份。");
      return;
    }
    if (
      mode === "existing" &&
      selected?.detailId &&
      match?.status !== "MATCHED"
    ) {
      setError("这份做法已经有变化，请重新选择要用的做法。");
      return;
    }
    const module = bindModuleDetail(
      workflow,
      {
        ...newModule(title),
        ...(mode === "existing" && selected
          ? { detailWorkflowId: selected.targetId }
          : {}),
        ...(mode === "existing" && selected?.detailId
          ? { detailId: selected.detailId }
          : {}),
        ...(mode === "existing" && selected?.detailName
          ? { detailName: selected.detailName }
          : {}),
      },
      workflows,
    );
    busyRef.current = true;
    setBusy(true);
    try {
      await onAdd(module);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "添加失败，请重试。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className="module-picker"
      aria-labelledby="module-picker-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busyRef.current) onClose();
      }}
    >
      <form onSubmit={submit}>
        <div className="module-picker-heading">
          <div>
            <h2 id="module-picker-title">添加工作</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭添加工作"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="tabs" role="tablist" aria-label="添加工作方式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "new"}
            className={mode === "new" ? "active" : ""}
            disabled={busy}
            onClick={() => {
              setMode("new");
              setError("");
            }}
          >
            添加新工作
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "existing"}
            className={mode === "existing" ? "active" : ""}
            disabled={busy}
            onClick={() => {
              setMode("existing");
              setError("");
            }}
          >
            从工作清单选择
          </button>
        </div>
        {mode === "new" ? (
          <div className="module-picker-new">
            <label>
              工作名称
              <input
                autoFocus
                maxLength={200}
                value={name}
                disabled={busy}
                placeholder="例如：检查设备"
                onChange={(event) => {
                  setName(event.target.value);
                  setError("");
                }}
              />
            </label>
          </div>
        ) : (
          <div className="module-picker-existing">
            <div className="search">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索可选工作"
                placeholder="搜索工作名称或所属流程…"
                value={search}
                disabled={busy}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setError("");
                }}
              />
            </div>
            <div className="module-picker-options" aria-label="可选工作">
              {visibleOptions.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={option.key === selectedKey}
                  disabled={busy}
                  onClick={() => {
                    setSelectedKey(option.key);
                    setError("");
                  }}
                >
                  <span>
                    <strong>{option.title}</strong>
                    <small>
                      {option.source.title}
                      {option.source.id === workflow.id && " · 当前流程"}
                    </small>
                  </span>
                  {option.key === selectedKey && (
                    <Check size={17} aria-hidden="true" />
                  )}
                </button>
              ))}
              {!visibleOptions.length && (
                <p className="muted">
                  {options.length
                    ? "没有找到这项工作，换个关键词试试。"
                    : "还没有工作可选，可以先添加一项。"}
                </p>
              )}
            </div>
          </div>
        )}
        {match && (
          <div
            className={`module-picker-match${match.status === "MATCHED" ? " matched" : ""}`}
            role="status"
          >
            <Link2 size={16} aria-hidden="true" />
            <p>
              {match.status === "MATCHED"
                ? `会打开这份做法：${match.detail?.title} · ${match.targetWorkflow?.title}`
                : match.status === "AMBIGUOUS"
                  ? "有几份名称相同的做法，请从工作清单里选一份。"
                  : "还没有这项工作的做法，可以以后再写。"}
            </p>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="module-picker-actions">
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="btn"
            disabled={busy || match?.status === "AMBIGUOUS"}
          >
            {busy ? "正在添加…" : "添加到流程图"}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
