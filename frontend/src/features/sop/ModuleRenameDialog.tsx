import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { Workflow, WorkflowModule } from "../../types";
import { normalizeName } from "./workflows";
import { renameModuleEntries } from "./renameModule";

export function ModuleRenameDialog({
  module,
  workflow,
  workflows,
  onRename,
  onClose,
}: {
  module: WorkflowModule;
  workflow: Workflow;
  workflows: Workflow[];
  onRename: (id: string, name: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const composing = useRef(false);
  const [name, setName] = useState(module.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    input.current?.select();
    return () => element?.close();
  }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (submitting.current || composing.current) return;
    setError("");
    const title = normalizeName(name);
    try {
      renameModuleEntries(workflow, module.id, title, workflows);
      if (title === normalizeName(module.title)) {
        onClose();
        return;
      }
      submitting.current = true;
      setBusy(true);
      await onRename(module.id, title);
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
      className="module-picker module-rename-dialog"
      aria-label="工作改名"
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting.current) onClose();
      }}
    >
      <form onSubmit={submit} noValidate>
        <div className="module-picker-heading">
          <h2>工作改名</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭改名"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="module-picker-new">
          <label>
            工作名称
            <input
              ref={input}
              autoFocus
              maxLength={200}
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (composing.current ||
                    event.nativeEvent.isComposing ||
                    event.nativeEvent.keyCode === 229)
                )
                  event.preventDefault();
              }}
            />
          </label>
        </div>
        {error && (
          <p role="alert" className="error">
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
          <button type="submit" className="btn" disabled={busy}>
            {busy ? "正在保存…" : "确定"}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
