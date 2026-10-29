import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal, X } from "lucide-react";
import {
  DEFAULT_BOARD_AXES,
  readBoardAxes,
  serializeBoardAxes,
  timelineIntervals,
  withTimelineIntervalLength,
  validateBoardAxes,
  type BoardAxesSettings,
  type BoardAxis,
} from "./boardAxes";

const clockInput = (value: number) =>
  Number.isFinite(value)
    ? `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`
    : "";
const inputMinute = (value: string) =>
  /^\d{2}:\d{2}$/.test(value)
    ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
    : NaN;

function AxesDialog({
  value,
  onChange,
  onClose,
}: {
  value?: string | null;
  onChange: (value: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [draft, setDraft] = useState<BoardAxesSettings>(() =>
    readBoardAxes(value),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const timeAxis = draft.timeline.axis || "x";
  const priorityAxis = draft.priority.axis || "y";
  const [lengthDraft, setLengthDraft] = useState<{
    index: number;
    value: string;
  } | null>(null);
  const intervals = validateBoardAxes(draft) ? [] : timelineIntervals(draft);
  function pendingLength() {
    if (!lengthDraft) return draft;
    if (!lengthDraft.value.trim()) throw new Error("请填写这段时间的长度。");
    return withTimelineIntervalLength(
      draft,
      lengthDraft.index,
      Number(lengthDraft.value),
    );
  }
  function commitLength() {
    if (!lengthDraft) return;
    try {
      setDraft(pendingLength());
      setLengthDraft(null);
      setError("");
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  function chooseAxis(kind: "timeline" | "priority", axis: BoardAxis) {
    setLengthDraft(null);
    const other = axis === "x" ? "y" : "x";
    setDraft((current) => ({
      ...current,
      timeline: {
        ...current.timeline,
        axis: kind === "timeline" ? axis : other,
      },
      priority: {
        ...current.priority,
        axis: kind === "priority" ? axis : other,
      },
    }));
  }
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  async function apply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (submitting.current) return;
    let pending: BoardAxesSettings;
    try {
      pending = pendingLength();
    } catch (failure) {
      setError((failure as Error).message);
      return;
    }
    const settings =
      !pending.timeline.enabled && validateBoardAxes(pending)
        ? {
            ...pending,
            timeline: {
              ...DEFAULT_BOARD_AXES.timeline,
              enabled: false,
              axis: timeAxis,
            },
          }
        : pending;
    const validation = validateBoardAxes(settings);
    setError(validation || "");
    if (validation) return;
    const serialized = serializeBoardAxes(settings);
    if (serialized === serializeBoardAxes(readBoardAxes(value))) {
      onClose();
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      await onChange(serialized);
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
      className="board-axes-dialog"
      aria-label="时间和优先级"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={apply} noValidate>
        <div className="board-axes-dialog-heading">
          <h2>时间和优先级</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭时间和优先级设置"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <fieldset disabled={busy}>
          <label className="board-axes-toggle">
            <input
              type="checkbox"
              checked={draft.timeline.enabled}
              onChange={(event) => {
                setLengthDraft(null);
                setDraft({
                  ...draft,
                  timeline: {
                    ...draft.timeline,
                    enabled: event.target.checked,
                    axis:
                      event.target.checked &&
                      draft.priority.enabled &&
                      timeAxis === priorityAxis
                        ? priorityAxis === "x"
                          ? "y"
                          : "x"
                        : timeAxis,
                  },
                });
              }}
            />
            显示时间线
          </label>
          {draft.timeline.enabled && (
            <div className="board-axes-time-inputs">
              <label className="board-axes-direction">
                时间线方向
                <select
                  value={timeAxis}
                  onChange={(event) =>
                    chooseAxis("timeline", event.target.value as BoardAxis)
                  }
                >
                  <option value="x">横轴（从左到右）</option>
                  <option value="y">纵轴（从上到下）</option>
                </select>
              </label>
              <label>
                开始时间
                <input
                  type="time"
                  required
                  value={clockInput(draft.timeline.startMinute)}
                  onChange={(event) => {
                    setLengthDraft(null);
                    setDraft({
                      ...draft,
                      timeline: {
                        ...draft.timeline,
                        startMinute: inputMinute(event.target.value),
                        focus: null,
                        segments: null,
                      },
                    });
                  }}
                />
              </label>
              <label>
                结束时间
                <input
                  type="time"
                  required
                  value={clockInput(draft.timeline.endMinute)}
                  onChange={(event) => {
                    setLengthDraft(null);
                    setDraft({
                      ...draft,
                      timeline: {
                        ...draft.timeline,
                        endMinute: inputMinute(event.target.value),
                        focus: null,
                        segments: null,
                      },
                    });
                  }}
                />
              </label>
              {draft.timeline.endMinute < draft.timeline.startMinute && (
                <p className="muted">结束时间在第二天。</p>
              )}
              {intervals.length > 0 && (
                <details className="board-time-lengths" open>
                  <summary>每段时间的长度</summary>
                  <p className="muted">
                    直接拖动时间刻度，也可以在这里输入长度。
                  </p>
                  <div className="board-time-length-list">
                    {intervals.map((interval, index) => {
                      const name = `${interval.startLabel}–${interval.endLabel}`;
                      return (
                        <label
                          key={`${interval.startOffset}-${interval.endOffset}`}
                        >
                          <span>{name}</span>
                          <input
                            type="number"
                            aria-label={`${name} 的长度`}
                            min={24}
                            max={2400}
                            step={1}
                            required
                            value={
                              lengthDraft?.index === index
                                ? lengthDraft.value
                                : Math.round(interval.length)
                            }
                            onChange={(event) => {
                              setLengthDraft({
                                index,
                                value: event.target.value,
                              });
                              setError("");
                            }}
                            onBlur={() => commitLength()}
                          />
                          <span aria-hidden="true">像素</span>
                        </label>
                      );
                    })}
                  </div>
                  <p className="muted">
                    只加长一段时，模版会跟着变长，其他时段长度不变。整条时间线的长度为
                    320–2400 像素。
                  </p>
                </details>
              )}
            </div>
          )}
          <label className="board-axes-toggle">
            <input
              type="checkbox"
              checked={draft.priority.enabled}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  priority: {
                    ...draft.priority,
                    enabled: event.target.checked,
                    axis:
                      event.target.checked &&
                      draft.timeline.enabled &&
                      priorityAxis === timeAxis
                        ? timeAxis === "x"
                          ? "y"
                          : "x"
                        : priorityAxis,
                  },
                })
              }
            />
            显示优先级
          </label>
          {draft.priority.enabled && (
            <>
              <label className="board-axes-priority-direction">
                优先级方向
                <select
                  value={priorityAxis}
                  onChange={(event) =>
                    chooseAxis("priority", event.target.value as BoardAxis)
                  }
                >
                  <option value="x">横轴（从左到右）</option>
                  <option value="y">纵轴（从上到下）</option>
                </select>
              </label>
              <div
                className={`board-axes-priority-preview${priorityAxis === "x" ? " is-horizontal" : ""}`}
                aria-label={
                  priorityAxis === "x" ? "优先级从左到右" : "优先级从上到下"
                }
              >
                <span>优先做</span>
                <span>正常安排</span>
                <span>可以稍后</span>
              </div>
            </>
          )}
          <p className="board-axes-explanation muted">
            时间和优先级按方框可移动的范围计算。移到最左或最上是开始时间、优先做；移到最右或最下是结束时间、可以稍后。调整方框大小后会重新计算。
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="board-axes-dialog-actions">
            <button type="button" className="btn secondary" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn">
              {busy ? "正在应用…" : "应用"}
            </button>
          </div>
        </fieldset>
      </form>
    </dialog>,
    document.body,
  );
}

export function BoardAxesControls({
  value,
  disabled,
  onChange,
  onBegin,
}: {
  value?: string | null;
  disabled: boolean;
  onChange: (value: string) => void | Promise<void>;
  onBegin?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const settings = readBoardAxes(value);
  return (
    <>
      <button
        type="button"
        className={`btn secondary board-axes-settings${settings.timeline.enabled || settings.priority.enabled ? " is-active" : ""}`}
        disabled={disabled}
        onClick={() => {
          onBegin?.();
          setOpen(true);
        }}
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
        时间和优先级
      </button>
      {open && (
        <AxesDialog
          value={value}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
