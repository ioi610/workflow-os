import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  boardSize,
  moveTimelineTick,
  serializeBoardAxes,
  timelineIntervals,
  timelineOffset,
  timelineTicks,
  type BoardAxesSettings,
} from "./boardAxes";

export function compactTimelineLabels(settings: BoardAxesSettings) {
  const ticks = timelineTicks(settings);
  return ticks.some(
    (tick, index) =>
      index > 0 &&
      (tick.position - ticks[index - 1].position) * boardSize(settings).width <
        42,
  );
}

type Gesture = {
  element: HTMLButtonElement;
  pointerId: number | null;
  settings: BoardAxesSettings;
  offset: number;
  start: number;
  scale: number;
  delta: number;
  pending?: string;
};

export function TimelineAxis({
  settings,
  disabled,
  onBegin,
  onPreview,
  onCommit,
  onError,
}: {
  settings: BoardAxesSettings;
  disabled: boolean;
  onBegin?: () => void;
  onPreview: (settings: string | null) => void;
  onCommit: (settings: string) => void | Promise<void>;
  onError: (error: string) => void;
}) {
  const axis = settings.timeline.axis || "x";
  const horizontal = axis === "x";
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const callbacks = useRef({ onPreview, onCommit, onError });
  callbacks.current = { onPreview, onCommit, onError };
  const [active, setActive] = useState<number | null>(null);
  const ticks = timelineTicks(settings);
  const intervals = timelineIntervals(settings);
  const length = boardSize(settings)[horizontal ? "width" : "height"];

  function release(current: Gesture) {
    if (
      current.pointerId !== null &&
      current.element.hasPointerCapture(current.pointerId)
    )
      current.element.releasePointerCapture(current.pointerId);
  }
  function cancel() {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    setActive(null);
    release(current);
    callbacks.current.onPreview(null);
  }
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current) {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", cancel);
      const current = gesture.current;
      gesture.current = null;
      if (current) release(current);
    };
  }, []);

  function preview(delta: number) {
    const current = gesture.current;
    if (!current) return;
    try {
      const next = moveTimelineTick(current.settings, current.offset, delta);
      const serialized = serializeBoardAxes(next);
      callbacks.current.onPreview(serialized);
      current.pending = serialized;
      callbacks.current.onError("");
    } catch (failure) {
      callbacks.current.onError((failure as Error).message);
    }
  }
  async function finish() {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    setActive(null);
    release(current);
    try {
      if (
        current.pending &&
        current.pending !== serializeBoardAxes(current.settings)
      )
        await callbacks.current.onCommit(current.pending);
    } catch (failure) {
      callbacks.current.onError((failure as Error).message);
    } finally {
      callbacks.current.onPreview(null);
    }
  }
  function beginPointer(
    event: PointerEvent<HTMLButtonElement>,
    offset: number,
  ) {
    if (disabled || gesture.current || event.button !== 0 || !event.isPrimary)
      return;
    const bounds = root.current!.getBoundingClientRect();
    const scale = (horizontal ? bounds.width : bounds.height) / length;
    if (!Number.isFinite(scale) || scale <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    onBegin?.();
    callbacks.current.onError("");
    gesture.current = {
      element: event.currentTarget,
      pointerId: event.pointerId,
      settings,
      offset,
      start: horizontal ? event.clientX : event.clientY,
      scale,
      delta: 0,
    };
    setActive(offset);
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>, offset: number) {
    if (disabled) return;
    const direction = horizontal
      ? event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowLeft"
          ? -1
          : 0
      : event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowUp"
          ? -1
          : 0;
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    if (!gesture.current) {
      onBegin?.();
      gesture.current = {
        element: event.currentTarget,
        pointerId: null,
        settings,
        offset,
        start: 0,
        scale: 1,
        delta: 0,
      };
      setActive(offset);
    }
    const current = gesture.current;
    if (current.pointerId !== null || current.offset !== offset) return;
    current.delta += direction * (event.shiftKey ? 1 : 8);
    preview(current.delta);
  }
  return (
    <div
      ref={root}
      className={`flow-board-axis flow-time-axis is-${horizontal ? "horizontal" : "vertical"}${horizontal && compactTimelineLabels(settings) ? " has-compact-time-labels" : ""}${active !== null ? " is-adjusting-time" : ""}`}
      role="region"
      aria-label="时间线"
      data-axis={axis}
    >
      <span className="flow-axis-title">时间 {horizontal ? "→" : "↓"}</span>
      {ticks.map((tick) => {
        const offset = Math.round(timelineOffset(tick.position, settings));
        const previous = intervals.find(
          (interval) => interval.endOffset === offset,
        );
        const next = intervals.find(
          (interval) => interval.startOffset === offset,
        );
        const value = tick.position * length;
        const minimum = previous ? value - previous.length + 24 : value;
        const maximum = next ? value + next.length - 24 : 2400;
        return (
          <span
            key={offset}
            className={`flow-axis-tick flow-time-tick${tick.position === 0 ? " is-start" : ""}${tick.position === 1 ? " is-end" : ""}`}
            data-time-offset={offset}
            style={
              horizontal
                ? { left: `${tick.position * 100}%` }
                : { top: `${tick.position * 100}%` }
            }
          >
            <span className="flow-time-tick-label">{tick.label}</span>
            {offset > 0 && (
              <button
                type="button"
                role="slider"
                className={`flow-time-tick-handle${active === offset ? " is-active" : ""}`}
                aria-label={`调整 ${tick.label} 刻度`}
                aria-orientation={horizontal ? "horizontal" : "vertical"}
                aria-valuemin={Math.floor(Math.min(value, minimum))}
                aria-valuemax={Math.ceil(Math.max(value, maximum))}
                aria-valuenow={Math.round(value)}
                aria-valuetext={`${tick.label}，前一段长度 ${Math.round(previous?.length || 0)} 像素`}
                disabled={disabled}
                onPointerDown={(event) => beginPointer(event, offset)}
                onPointerMove={(event) => {
                  const current = gesture.current;
                  if (current?.pointerId === event.pointerId)
                    preview(
                      ((horizontal ? event.clientX : event.clientY) -
                        current.start) /
                        current.scale,
                    );
                }}
                onPointerUp={(event) => {
                  if (gesture.current?.pointerId === event.pointerId) {
                    event.preventDefault();
                    void finish();
                  }
                }}
                onPointerCancel={cancel}
                onLostPointerCapture={() => {
                  if (gesture.current?.pointerId !== null) cancel();
                }}
                onKeyDown={(event) => keyDown(event, offset)}
                onKeyUp={(event) => {
                  if (
                    event.key.startsWith("Arrow") &&
                    gesture.current?.pointerId === null
                  ) {
                    event.preventDefault();
                    void finish();
                  }
                }}
                onBlur={() => {
                  if (gesture.current?.pointerId === null) cancel();
                }}
              />
            )}
          </span>
        );
      })}
    </div>
  );
}
