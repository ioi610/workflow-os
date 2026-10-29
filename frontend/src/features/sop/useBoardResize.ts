import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
} from "react";
import { clampBoardSize, type BoardSize } from "./boardAxes";

export function useBoardResize({
  size,
  scale,
  disabled,
  minimum,
  onBegin,
  onResize,
}: {
  size: BoardSize;
  scale: number;
  disabled: boolean;
  minimum?: BoardSize;
  onBegin: () => void;
  onResize: (size: BoardSize) => void;
}) {
  const constrain = (value: BoardSize) =>
    clampBoardSize({
      width: Math.max(value.width, minimum?.width || 320),
      height: Math.max(value.height, minimum?.height || 320),
    });
  const [preview, setPreview] = useState<BoardSize | null>(null);
  const gesture = useRef<{
    pointer: number;
    element: HTMLButtonElement;
    x: number;
    y: number;
    size: BoardSize;
    scale: number;
  } | null>(null);
  function cancel() {
    const current = gesture.current;
    gesture.current = null;
    if (current?.element.hasPointerCapture(current.pointer))
      current.element.releasePointerCapture(current.pointer);
    setPreview(null);
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
      cancel();
    };
  }, []);
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled]);
  function requested(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current!;
    return constrain({
      width: current.size.width + (event.clientX - current.x) / current.scale,
      height: current.size.height + (event.clientY - current.y) / current.scale,
    });
  }
  const changed = (value: BoardSize, original: BoardSize) =>
    value.width !== original.width || value.height !== original.height;
  return {
    preview,
    resizing: preview !== null,
    isActive: () => gesture.current !== null,
    handleProps: {
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (
          disabled ||
          gesture.current ||
          !event.isPrimary ||
          event.button !== 0
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        gesture.current = {
          pointer: event.pointerId,
          element: event.currentTarget,
          x: event.clientX,
          y: event.clientY,
          size,
          scale: scale > 0 ? scale : 1,
        };
        setPreview(size);
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        onBegin();
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        if (gesture.current?.pointer !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        setPreview(requested(event));
      },
      onPointerUp(event: PointerEvent<HTMLButtonElement>) {
        const current = gesture.current;
        if (!current || current.pointer !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        if (disabled) {
          cancel();
          return;
        }
        const next = requested(event);
        cancel();
        if (changed(next, current.size)) onResize(next);
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
        if (disabled || gesture.current) return;
        const step = event.shiftKey ? 100 : 20;
        const next = constrain({
          width:
            size.width +
            (event.key === "ArrowRight"
              ? step
              : event.key === "ArrowLeft"
                ? -step
                : 0),
          height:
            size.height +
            (event.key === "ArrowDown"
              ? step
              : event.key === "ArrowUp"
                ? -step
                : 0),
        });
        if (changed(next, size)) {
          onBegin();
          onResize(next);
        }
      },
      onClick(event: React.MouseEvent<HTMLButtonElement>) {
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
