import { useEffect, useId, useRef } from "react";
import "./DeleteDialog.css";

export function DeleteDialog({
  title,
  name,
  description,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  name: string;
  description: string;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="delete-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      <p className="delete-dialog-name">{name}</p>
      <p id={descriptionId}>{description}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="delete-dialog-actions">
        <button
          className="btn secondary"
          autoFocus
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </button>
        <button className="btn danger" disabled={busy} onClick={onConfirm}>
          {busy ? "正在删除…" : "删除"}
        </button>
      </div>
    </dialog>
  );
}
