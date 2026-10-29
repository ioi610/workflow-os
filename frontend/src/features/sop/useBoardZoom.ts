import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import type { Size } from "./canvas";
import {
  boardZoomStorageKey,
  clampBoardScale,
  readBoardZoom,
  serializeBoardZoom,
  stepBoardScale,
  type BoardZoomPreference,
} from "./boardZoom";

function load(workflowId: string): BoardZoomPreference {
  try {
    return readBoardZoom(localStorage.getItem(boardZoomStorageKey(workflowId)));
  } catch {
    return readBoardZoom();
  }
}

type Gesture = {
  workflowId: string;
  pointer: number;
  element: HTMLButtonElement;
  x: number;
  y: number;
  size: Size;
  scale: number;
};

export function useBoardZoom({
  workflowId,
  logicalSize,
  disabled,
}: {
  workflowId: string;
  logicalSize: Size;
  disabled: boolean;
}) {
  const loaded = useMemo(() => load(workflowId), [workflowId]);
  const [saved, setSaved] = useState(() => ({
    workflowId,
    preference: loaded,
  }));
  const [preview, setPreview] = useState<{
    workflowId: string;
    scale: number;
  } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const preference =
    saved.workflowId === workflowId ? saved.preference : loaded;
  const scale = clampBoardScale(
    preview?.workflowId === workflowId ? preview.scale : preference.scale,
  );
  const context = useRef({ workflowId, logicalSize, disabled, scale });
  context.current = { workflowId, logicalSize, disabled, scale };

  function cancel(update = true) {
    const current = gesture.current;
    gesture.current = null;
    if (current?.element.hasPointerCapture(current.pointer))
      current.element.releasePointerCapture(current.pointer);
    if (update) setPreview(null);
  }
  function commit(next: BoardZoomPreference) {
    const id = context.current.workflowId;
    setSaved({ workflowId: id, preference: next });
    try {
      localStorage.setItem(boardZoomStorageKey(id), serializeBoardZoom(next));
    } catch {}
  }
  function requested(event: PointerEvent<HTMLButtonElement>, current: Gesture) {
    const { width, height } = current.size;
    const denominator = width * width + height * height;
    const change =
      denominator > 0 && Number.isFinite(denominator)
        ? ((event.clientX - current.x) * width +
            (event.clientY - current.y) * height) /
          denominator
        : 0;
    return clampBoardScale(current.scale + change);
  }
  function setScale(value: number) {
    if (context.current.disabled || gesture.current) return;
    commit({ version: 1, mode: "manual", scale: clampBoardScale(value) });
  }
  useEffect(() => {
    cancel();
    setSaved({ workflowId, preference: loaded });
  }, [workflowId, loaded]);
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled]);
  useEffect(() => {
    cancel();
  }, [logicalSize.width, logicalSize.height]);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current) {
        event.preventDefault();
        cancel();
      }
    };
    const blur = () => cancel();
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", blur);
      cancel(false);
    };
  }, []);

  return {
    scale,
    setScale,
    isActive: () => gesture.current?.workflowId === context.current.workflowId,
    resizing: preview?.workflowId === workflowId,
    handleProps: {
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        const latest = context.current;
        if (
          latest.disabled ||
          gesture.current ||
          !event.isPrimary ||
          event.button !== 0
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        gesture.current = {
          workflowId: latest.workflowId,
          pointer: event.pointerId,
          element: event.currentTarget,
          x: event.clientX,
          y: event.clientY,
          size: { ...latest.logicalSize },
          scale: latest.scale,
        };
        event.currentTarget.focus({ preventScroll: true });
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
          setPreview({ workflowId: latest.workflowId, scale: latest.scale });
        } catch {
          cancel();
        }
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const current = gesture.current;
        if (
          !current ||
          current.pointer !== event.pointerId ||
          current.workflowId !== context.current.workflowId
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (context.current.disabled) {
          cancel();
          return;
        }
        setPreview({
          workflowId: current.workflowId,
          scale: requested(event, current),
        });
      },
      onPointerUp(event: PointerEvent<HTMLButtonElement>) {
        const current = gesture.current;
        if (!current || current.pointer !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const valid =
          !context.current.disabled &&
          current.workflowId === context.current.workflowId;
        const next = requested(event, current);
        cancel();
        if (valid && Math.abs(next - current.scale) > 1e-9)
          commit({ version: 1, mode: "manual", scale: next });
      },
      onPointerCancel(event: PointerEvent<HTMLButtonElement>) {
        if (gesture.current?.pointer === event.pointerId) cancel();
      },
      onLostPointerCapture(event: PointerEvent<HTMLButtonElement>) {
        if (gesture.current?.pointer === event.pointerId) cancel();
      },
      onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        if (
          !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
            event.key,
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (context.current.disabled || gesture.current) return;
        setScale(
          stepBoardScale(
            context.current.scale,
            event.key === "ArrowLeft" || event.key === "ArrowUp" ? -10 : 10,
          ),
        );
      },
      onClick(event: MouseEvent<HTMLButtonElement>) {
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
