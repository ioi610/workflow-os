import { Minus, Plus } from "lucide-react";
import { MAX_BOARD_SCALE, MIN_BOARD_SCALE, stepBoardScale } from "./boardZoom";

export function BoardZoomControls({
  scale,
  disabled,
  onScaleChange,
}: {
  scale: number;
  disabled: boolean;
  onScaleChange: (scale: number) => void;
}) {
  return (
    <div className="board-zoom-controls" role="group" aria-label="流程图缩放">
      <button
        type="button"
        className="btn secondary board-zoom-step"
        aria-label="缩小"
        disabled={disabled || scale <= MIN_BOARD_SCALE}
        onClick={() => onScaleChange(stepBoardScale(scale, -10))}
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="btn secondary board-zoom-step"
        aria-label="放大"
        disabled={disabled || scale >= MAX_BOARD_SCALE}
        onClick={() => onScaleChange(stepBoardScale(scale, 10))}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
