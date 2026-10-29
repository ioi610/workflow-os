import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, X } from "lucide-react";
import {
  boardSize,
  DEFAULT_BOARD_SIZE,
  MIN_BOARD_SIZE,
  MAX_BOARD_SIZE,
  readBoardAxes,
  serializeBoardAxes,
  validateBoardSize,
  type BoardSize,
} from "./boardAxes";

function SizeDialog({
  value,
  onChange,
  onClose,
  minimum,
}: {
  value?: string | null;
  onChange: (value: string) => void | Promise<void>;
  onClose: () => void;
  minimum: BoardSize;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [draft, setDraft] = useState(() => boardSize(readBoardAxes(value)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  async function apply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (submitting.current) return;
    const validation = validateBoardSize(draft);
    setError(validation || "");
    if (validation) return;
    if (draft.width < minimum.width || draft.height < minimum.height) {
      setError(
        `现有工作需要至少 ${minimum.width} × ${minimum.height} 的空间，请加大模版。`,
      );
      return;
    }
    const original = boardSize(readBoardAxes(value));
    if (original.width === draft.width && original.height === draft.height) {
      onClose();
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      await onChange(
        serializeBoardAxes({ ...readBoardAxes(value), canvas: draft }),
      );
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
      className="board-axes-dialog board-size-dialog"
      aria-label="模版大小"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={apply} noValidate>
        <div className="board-axes-dialog-heading">
          <h2>模版大小</h2>
          <button
            type="button"
            aria-label="关闭模版大小设置"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <fieldset disabled={busy}>
          <div className="board-size-inputs">
            <label>
              模版宽度
              <input
                type="number"
                min={minimum.width}
                max={MAX_BOARD_SIZE}
                step={1}
                required
                value={Number.isFinite(draft.width) ? draft.width : ""}
                onChange={(event) =>
                  setDraft({ ...draft, width: event.target.valueAsNumber })
                }
              />
            </label>
            <label>
              模版高度
              <input
                type="number"
                min={minimum.height}
                max={MAX_BOARD_SIZE}
                step={1}
                required
                value={Number.isFinite(draft.height) ? draft.height : ""}
                onChange={(event) =>
                  setDraft({ ...draft, height: event.target.valueAsNumber })
                }
              />
            </label>
          </div>
          <p className="board-axes-explanation muted">
            只调整模版的空白范围，工作方框的大小和位置保持不变。
          </p>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setDraft({ ...DEFAULT_BOARD_SIZE });
              setError("");
            }}
          >
            恢复默认大小
          </button>
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

export function BoardSizeControls({
  value,
  disabled,
  onBegin,
  onChange,
  minimum = { width: MIN_BOARD_SIZE, height: MIN_BOARD_SIZE },
}: {
  value?: string | null;
  disabled: boolean;
  onBegin?: () => void;
  onChange: (value: string) => void | Promise<void>;
  minimum?: BoardSize;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn secondary board-size-settings"
        disabled={disabled}
        onClick={() => {
          onBegin?.();
          setOpen(true);
        }}
      >
        <Maximize2 size={14} aria-hidden="true" />
        模版大小
      </button>
      {open && (
        <SizeDialog
          value={value}
          onChange={onChange}
          onClose={() => setOpen(false)}
          minimum={minimum}
        />
      )}
    </>
  );
}
