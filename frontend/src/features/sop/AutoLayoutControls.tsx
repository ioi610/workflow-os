import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LayoutGrid, X } from "lucide-react";
import type { Workflow, WorkflowStep } from "../../types";
import { autoLayoutWorkflow } from "./autoLayout";
import { boardSize, readBoardAxes } from "./boardAxes";
import { arrowPath, canvasArrows, modulePosition, moduleSize } from "./canvas";
import { readWorkflow } from "./workflows";
import "./AutoLayoutControls.css";

export function LayoutPreview({ workflow }: { workflow: Workflow }) {
  const markerId = `layout-arrow-${useId().replaceAll(":", "")}`;
  const { modules } = readWorkflow(workflow.draft);
  const dimensions = boardSize(readBoardAxes(workflow.boardSettings));
  const byId = new Map(
    modules.map((module, index) => [
      module.id,
      {
        module,
        position: modulePosition(module, index, dimensions),
        size: moduleSize(module, dimensions),
      },
    ]),
  );
  return (
    <svg
      className="auto-layout-preview"
      viewBox={`-8 -8 ${dimensions.width + 16} ${dimensions.height + 16}`}
      role="img"
      aria-label="工作位置预览"
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#72916e" />
        </marker>
      </defs>
      <rect
        x="0"
        y="0"
        width={dimensions.width}
        height={dimensions.height}
        rx="10"
        fill="#f7f9f1"
        stroke="#dfe7d4"
      />
      <g
        transform={`scale(${dimensions.width / 1000} ${dimensions.height / 1000})`}
      >
        {canvasArrows(modules).map((edge) => {
          const source = byId.get(edge.sourceId)!,
            target = byId.get(edge.targetId)!;
          return (
            <path
              key={`${edge.sourceId}-${edge.targetId}`}
              d={arrowPath(
                source.position,
                target.position,
                source.size,
                target.size,
                dimensions,
                edge.ports,
              )}
              fill="none"
              stroke="#72916e"
              strokeWidth="2"
              markerEnd={`url(#${markerId})`}
            />
          );
        })}
      </g>
      {[...byId.values()].map(({ module, position, size }) => {
        const x = position.x * dimensions.width,
          y = position.y * dimensions.height,
          width = size.width * dimensions.width,
          height = size.height * dimensions.height;
        const characters = Array.from(module.title);
        const limit = Math.max(2, Math.floor(width / 14));
        const shortName =
          characters.length > limit
            ? characters.slice(0, limit - 1).join("") + "…"
            : module.title;
        return (
          <g key={module.id}>
            <title>{module.title}</title>
            <rect
              x={x}
              y={y}
              width={width}
              height={height}
              rx="8"
              fill="#fffefb"
              stroke="#91a783"
              strokeWidth="1.5"
            />
            <text
              x={x + width / 2}
              y={y + height / 2}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="#355b3d"
              fontSize={Math.max(
                11,
                Math.min(17, width / (Math.max(module.title.length, 1) + 1)),
              )}
            >
              {shortName}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function LayoutDialog({
  workflow,
  workflows,
  current,
  onApply,
  onClose,
}: {
  workflow: Workflow;
  workflows: Workflow[];
  current: Workflow;
  onApply: (snapshot: Workflow, steps: WorkflowStep[]) => void | Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    submitting = useRef(false);
  const [plan] = useState(() => autoLayoutWorkflow(workflow, workflows));
  const [before, setBefore] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const names = new Map(
    readWorkflow(workflow.draft).modules.map((module) => [
      module.id,
      module.title,
    ]),
  );
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  async function apply(event: React.FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (submitting.current || !plan.changed) return;
    if (
      current.id !== workflow.id ||
      current.draft !== workflow.draft ||
      current.boardSettings !== workflow.boardSettings ||
      current.title !== workflow.title ||
      current.category !== workflow.category
    ) {
      setError("工作内容刚有变化，请关闭后重新整理。");
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await onApply(current, plan.steps);
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="auto-layout-dialog"
      aria-label="整理位置"
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting.current) onClose();
      }}
    >
      <form onSubmit={(event) => void apply(event)}>
        <div className="auto-layout-heading">
          <h2>整理位置</h2>
          <button
            type="button"
            aria-label="关闭整理预览"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="auto-layout-body">
          <div
            className="auto-layout-tabs"
            role="group"
            aria-label="比较工作位置"
          >
            <button
              type="button"
              aria-pressed={before}
              disabled={busy}
              onClick={() => setBefore(true)}
            >
              现在的位置
            </button>
            <button
              type="button"
              aria-pressed={!before}
              disabled={busy}
              onClick={() => setBefore(false)}
            >
              整理后
            </button>
          </div>
          <LayoutPreview
            workflow={
              before
                ? workflow
                : { ...workflow, draft: JSON.stringify(plan.steps) }
            }
          />
          <p>
            {plan.changed
              ? `将整理 ${plan.changed} 项工作的位置。`
              : "当前没有可以进一步整理的位置。"}{" "}
            时间、优先级和方框大小保持原样。
          </p>
          {plan.unplaced.length > 0 && (
            <p className="auto-layout-warning">
              这些工作受时间或空间限制，保留原位：
              {plan.unplaced.map((id) => names.get(id) || id).join("、")}
              。可以调整方框大小或安排后，再次整理。
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="auto-layout-actions">
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
            disabled={busy || !plan.changed}
          >
            {busy ? "正在应用…" : "应用整理"}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}

export function AutoLayoutControls({
  workflow,
  workflows,
  disabled,
  onBegin,
  onApply,
}: {
  workflow: Workflow;
  workflows: Workflow[];
  disabled: boolean;
  onBegin?: () => void;
  onApply: (snapshot: Workflow, steps: WorkflowStep[]) => void | Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<Workflow | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn secondary"
        disabled={disabled || readWorkflow(workflow.draft).modules.length < 2}
        onClick={() => {
          onBegin?.();
          setSnapshot(workflow);
        }}
      >
        <LayoutGrid size={14} aria-hidden="true" />
        整理位置
      </button>
      {snapshot && (
        <LayoutDialog
          workflow={snapshot}
          current={workflow}
          workflows={workflows}
          onApply={onApply}
          onClose={() => setSnapshot(null)}
        />
      )}
    </>
  );
}
