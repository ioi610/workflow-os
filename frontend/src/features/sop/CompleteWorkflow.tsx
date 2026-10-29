import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Check,
  CloudUpload,
  Copy,
  Printer,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api";
import type { Context, Workflow } from "../../types";
import { generateWorkflow } from "./generatedWorkflow";
import { completeWorkflowParagraphs } from "./completeWorkflowText";
import { readWorkflow, workflowKey } from "./workflows";
import {
  validateWorkflowDraft,
  workflowDraftSavePayload,
} from "./workflowDraft";
import { completeWorkflowSources } from "./completeWorkflowSources";
import { editorBackupKey, readEditorBackup } from "./useWorkflowAutosave";
import {
  readEditorBackupRecord,
  removeEditorBackupRecord,
} from "./editorBackups";
import { connectProcedure } from "./connectedProcedure";
import { WorkflowProse } from "./WorkflowProse";
import { originalWorkflowOrder } from "./workflowTextOrigin";
import { serializeWorkflowTransfer } from "./workflowTransfer";
import { rememberWorkflowCopySnapshot } from "./workflowCopySnapshots";
import "./CompleteWorkflow.css";

export function CompleteWorkflow(c: Context) {
  const { id } = useParams();
  const qc = useQueryClient();
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState("");
  const [copyError, setCopyError] = useState("");
  const copyInFlight = useRef(false);
  const [draftVersion, setDraftVersion] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [showOrder, setShowOrder] = useState(false);
  const [sourceChoice, setSourceChoice] = useState<{
    signature: string;
    ids: string[];
  } | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<{
    key: string;
    signature: string;
    order: string[];
  } | null>(null);
  const [orderNotice, setOrderNotice] = useState("");
  const q = useQuery<Workflow[]>({
    queryKey: workflowKey(c.org),
    queryFn: () => api(`/orgs/${c.org}/sops`),
  });
  useEffect(() => {
    const refresh = () => setDraftVersion((version) => version + 1);
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, []);
  const sourceSignature = JSON.stringify([
    q.data?.map((record) => [record.id, record.revision]),
    draftVersion,
  ]);
  const preferLocal = useMemo(
    () =>
      new Set(
        sourceChoice?.signature === sourceSignature ? sourceChoice.ids : [],
      ),
    [sourceChoice, sourceSignature],
  );
  const sources = useMemo(
    () =>
      completeWorkflowSources(
        q.data || [],
        (recordId) =>
          c.role === "EMPLOYEE"
            ? null
            : readEditorBackup(
                editorBackupKey(String(c.user.id), c.org, recordId),
              ),
        preferLocal,
      ),
    [q.data, c.org, c.role, c.user.id, draftVersion, preferLocal],
  );
  const workflow = sources.workflows.find((record) => record.id === id);
  const generated = useMemo(
    () => (workflow ? generateWorkflow(workflow, sources.workflows) : null),
    [workflow, sources.workflows],
  );
  const orderKey = `workflow-os:procedure-order:${c.user.id}:${c.org}:${id || ""}`;
  const orderSignature = generated
    ? JSON.stringify({
        entries: generated.entries.map((entry) => [entry.id, entry.minute]),
        groups: generated.groups.map((group) => [group.id, group.entryIds]),
        edges: generated.edges,
      })
    : "";
  const storedOrder = useMemo(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(orderKey) || "null");
      if (
        !stored ||
        !Array.isArray(stored.order) ||
        !stored.order.every((item: unknown) => typeof item === "string")
      )
        return undefined;
      if (stored.signature === orderSignature) return stored.order as string[];
      // Older releases grouped all ready dependencies together. A grouping-only
      // change must not erase a still-valid manual order for the same board.
      const previous = JSON.parse(stored.signature),
        current = JSON.parse(orderSignature);
      if (
        JSON.stringify(previous.entries) !== JSON.stringify(current.entries) ||
        JSON.stringify(previous.edges) !== JSON.stringify(current.edges) ||
        !generated
      )
        return undefined;
      connectProcedure(generated, stored.order);
      return stored.order as string[];
    } catch {
      return undefined;
    }
  }, [orderKey, orderSignature]);
  const preferredOrder =
    selectedOrder?.key === orderKey &&
    selectedOrder.signature === orderSignature
      ? selectedOrder.order
      : (storedOrder ??
        (workflow && generated
          ? originalWorkflowOrder(workflow, generated)
          : undefined));
  const procedure = useMemo(() => {
    if (!generated) return null;
    try {
      return connectProcedure(generated, preferredOrder);
    } catch {
      return connectProcedure(generated);
    }
  }, [generated, preferredOrder]);
  const hasLocalDraft = !!id && sources.draftDetails.has(id);
  const canRecover =
    !!id && hasLocalDraft && !sources.conflictingDrafts.has(id);
  const paragraphs = useMemo(
    () =>
      workflow && generated && procedure
        ? completeWorkflowParagraphs(workflow, generated, procedure)
        : [],
    [workflow, generated, procedure],
  );
  const plainText = paragraphs.join("\n\n");
  // A copied export is a snapshot, including separately stored linked details.
  // Invalidate it when any content used for that snapshot changes.
  const copySourceKey = JSON.stringify([
    c.org,
    c.user.id,
    id,
    workflow?.draft,
    workflow?.boardSettings,
    workflow?.title,
    workflow?.category,
    plainText,
    procedure?.entryOrder,
    generated?.entries.map((entry) => [
      entry.id,
      entry.status,
      entry.sourceMissing,
      entry.targetWorkflow?.id,
      entry.detail,
    ]),
  ]);
  const currentCopySourceKey = useRef(copySourceKey);
  currentCopySourceKey.current = copySourceKey;
  const copyAlive = useRef(true);
  useEffect(() => {
    copyAlive.current = true;
    return () => {
      copyAlive.current = false;
    };
  }, []);
  useEffect(() => {
    setCopied(false);
    setCopyFallback("");
    setCopyError("");
  }, [copySourceKey]);
  useEffect(() => {
    window.scrollTo(0, 0);
    setShowOrder(false);
    setOrderNotice("");
  }, [id, c.org]);
  function copySourceIsCurrent(key: string) {
    return copyAlive.current && currentCopySourceKey.current === key;
  }
  function swappedOrder(index: number, offset: number) {
    if (!generated || !procedure) return null;
    const next = [...procedure.entryOrder];
    const target = index + offset;
    if (target < 0 || target >= next.length) return null;
    [next[index], next[target]] = [next[target], next[index]];
    try {
      connectProcedure(generated, next);
      return next;
    } catch {
      return null;
    }
  }
  function useOrder(order: string[]) {
    setSelectedOrder({ key: orderKey, signature: orderSignature, order });
    setCopied(false);
    setCopyFallback("");
    setCopyError("");
    try {
      localStorage.setItem(
        orderKey,
        JSON.stringify({ signature: orderSignature, order }),
      );
      setOrderNotice("衔接顺序已记住，复制和打印也会使用这个顺序。");
    } catch {
      setOrderNotice("顺序已调整，本次页面会保留；本机暂时无法记住这个顺序。");
    }
  }
  function captureCopySnapshot() {
    if (!workflow || !procedure) return null;
    // Capture before awaiting the clipboard so later edits cannot change
    // the diagram associated with the text that was actually copied.
    return {
      text: plainText,
      transferText: serializeWorkflowTransfer(
        workflow,
        sources.workflows,
        plainText,
        procedure.entryOrder,
      ),
      sourceWorkflowId: workflow.id,
      userId: String(c.user.id),
      orgId: c.org,
    };
  }
  function rememberCapturedCopy(
    snapshot: ReturnType<typeof captureCopySnapshot>,
  ) {
    if (!snapshot) return;
    try {
      rememberWorkflowCopySnapshot(snapshot);
    } catch {
      // A disabled local cache must not affect the complete clipboard export.
    }
  }
  function rememberPlainCopy() {
    try {
      rememberCapturedCopy(captureCopySnapshot());
    } catch {
      // Manual selection still copies the visible text if a snapshot is invalid.
    }
  }
  async function copy() {
    if (copyInFlight.current || !copyAlive.current) return;
    const sourceKey = copySourceKey;
    copyInFlight.current = true;
    setCopying(true);
    setCopied(false);
    setCopyFallback("");
    setCopyError("");
    try {
      const snapshot = captureCopySnapshot();
      if (!snapshot) throw new Error("未找到要复制的流程，请重新打开。");
      try {
        if (!navigator.clipboard) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(snapshot.transferText);
        // A failed copy must not replace a previous successful copy's source.
        rememberCapturedCopy(snapshot);
        if (copySourceIsCurrent(sourceKey)) setCopied(true);
      } catch {
        if (copySourceIsCurrent(sourceKey))
          setCopyFallback(snapshot.transferText);
      }
    } catch (error) {
      if (copySourceIsCurrent(sourceKey))
        setCopyError((error as Error).message || "这次没有复制成功，请重试。");
    } finally {
      copyInFlight.current = false;
      if (copyAlive.current) setCopying(false);
    }
  }
  async function recoverInstructions() {
    if (!id || recovering || c.role === "EMPLOYEE") return;
    setRecovering(true);
    setRecoveryError("");
    try {
      const key = editorBackupKey(String(c.user.id), c.org, id);
      const snapshot = readEditorBackupRecord(key);
      const raw = snapshot?.raw;
      const backup = snapshot?.backup;
      if (!snapshot || !raw || !backup)
        throw new Error("本机做法已经更新，请重新打开完整流程。");
      const currentRecords = await api<Workflow[]>(`/orgs/${c.org}/sops`);
      const current = currentRecords.find((record) => record.id === id);
      if (!current) throw new Error("这个流程暂时无法打开，本机做法仍然保留。");
      const recovery = completeWorkflowSources(currentRecords, (recordId) =>
        recordId === id ? backup : null,
      );
      if (recovery.conflictingDrafts.has(id))
        throw new Error(
          "补存会改变已有做法或对应来源，请先核对；本机做法仍然保留。",
        );
      const draft = {
        ...readWorkflow(
          recovery.workflows.find((record) => record.id === id)!.draft,
        ),
        title: current.title,
        category: current.category || "",
        boardSettings: current.boardSettings ?? null,
      };
      const problem = validateWorkflowDraft(draft, c.org);
      if (problem) throw new Error(problem);
      if (localStorage.getItem(snapshot.key) !== raw)
        throw new Error("本机做法刚有新的修改，请核对后再保存；草稿仍然保留。");
      // Keep a full copy before recovering instructions onto the newest board.
      localStorage.setItem(`${key}:recovery:${crypto.randomUUID()}`, raw);
      const saved = await api<Workflow>(`/orgs/${c.org}/sops/save`, {
        id,
        expectedRevision: current.revision,
        ...workflowDraftSavePayload(draft),
      });
      const unchangedLocal = localStorage.getItem(snapshot.key) === raw;
      if (unchangedLocal) removeEditorBackupRecord(snapshot);
      qc.setQueryData<Workflow[]>(workflowKey(c.org), (records) =>
        records?.map((record) => (record.id === saved.id ? saved : record)),
      );
      setDraftVersion((version) => version + 1);
      c.notify(
        unchangedLocal
          ? "本机做法已保存，当前流程图的位置和时间已保留。"
          : "已补存这份做法，之后修改的本机草稿仍然保留。",
      );
    } catch (error) {
      setRecoveryError((error as Error).message);
    } finally {
      setRecovering(false);
    }
  }
  if (q.isPending)
    return (
      <main>
        <p className="muted">正在整理完整流程…</p>
      </main>
    );
  if (q.isError)
    return (
      <main>
        <p className="error" role="alert">
          {q.error.message}
        </p>
      </main>
    );
  if (!workflow || !generated || !procedure)
    return (
      <main>
        <h1>未找到这个流程</h1>
        <Link className="btn secondary" to="/">
          返回首页
        </Link>
      </main>
    );
  const byId = new Map(generated.entries.map((entry) => [entry.id, entry]));
  const relatedSources = new Set([
    id,
    ...generated.entries.map(
      (entry) => entry.targetWorkflow?.id || entry.module.detailWorkflowId,
    ),
  ]);
  const conflicts = [...sources.conflictingDrafts].filter((sourceId) =>
    relatedSources.has(sourceId),
  );
  const viewingLocal = conflicts.some((sourceId) => preferLocal.has(sourceId));
  return (
    <main className="complete-workflow" aria-label="完整操作流程">
      <div className="complete-screen-tools">
        <Link className="back-link" to={`/workflows/${workflow.id}`}>
          <ArrowLeft size={15} />
          返回流程
        </Link>
        <div className="complete-tools">
          {canRecover && (
            <button
              className="btn secondary"
              type="button"
              disabled={recovering}
              onClick={() => void recoverInstructions()}
            >
              <CloudUpload size={15} />
              {recovering ? "正在保存…" : "保存本机做法"}
            </button>
          )}
          <button
            className="btn secondary"
            type="button"
            onClick={() => void copy()}
            disabled={copying}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copying ? "正在复制…" : copied ? "已复制" : "复制全文"}
          </button>
          <button
            className="btn secondary"
            type="button"
            onClick={() => window.print()}
            disabled={!plainText.trim()}
          >
            <Printer size={15} />
            打印
          </button>
        </div>
      </div>
      {conflicts.length > 0 && (
        <div
          className="complete-source-choice complete-screen-only"
          role="status"
        >
          <p>
            {viewingLocal
              ? "当前查看本机草稿，已保存的做法没有被修改。"
              : "本机草稿与已保存的做法不同，当前使用已保存的做法。"}
          </p>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setSourceChoice({
                signature: sourceSignature,
                ids: viewingLocal ? [] : conflicts,
              });
              setCopied(false);
              setCopyFallback("");
              setCopyError("");
            }}
          >
            {viewingLocal ? "使用已保存的做法" : "查看本机草稿"}
          </button>
        </div>
      )}
      {recoveryError && (
        <p role="alert" className="error complete-screen-only">
          {recoveryError}
        </p>
      )}
      {(copied || copyFallback) && (
        <div
          className="complete-transfer-copy complete-screen-only"
          role="status"
        >
          <p>
            {copyFallback
              ? "未能自动复制，请复制下框中的全部文字，再粘贴到“文字生成流程图”还原。"
              : "已包含方框位置、连线和完整做法，可粘贴到“文字生成流程图”还原。"}
          </p>
          {copyFallback && (
            <textarea
              aria-label="完整流程文本"
              readOnly
              value={copyFallback}
              onFocus={(event) => event.currentTarget.select()}
            />
          )}
        </div>
      )}
      {copyError && (
        <p role="alert" className="error complete-screen-only">
          {copyError}
        </p>
      )}
      {generated.entries.length > 1 && (
        <div className="procedure-order-controls complete-screen-only">
          <button
            className="text-button"
            type="button"
            aria-expanded={showOrder}
            onClick={() => setShowOrder(!showOrder)}
          >
            调整衔接顺序
          </button>
          {showOrder && (
            <div className="procedure-order-panel" aria-label="衔接顺序">
              <ol>
                {procedure.entryOrder.map((entryId, index) => {
                  const entry = byId.get(entryId)!;
                  return (
                    <li key={entryId}>
                      <span>{entry.name}</span>
                      <div>
                        <button
                          type="button"
                          aria-label={`将 ${entry.name} 提前`}
                          disabled={!swappedOrder(index, -1)}
                          onClick={() => {
                            const next = swappedOrder(index, -1);
                            if (next) useOrder(next);
                          }}
                        >
                          <ArrowUp size={15} />
                        </button>
                        <button
                          type="button"
                          aria-label={`将 ${entry.name} 推后`}
                          disabled={!swappedOrder(index, 1)}
                          onClick={() => {
                            const next = swappedOrder(index, 1);
                            if (next) useOrder(next);
                          }}
                        >
                          <ArrowDown size={15} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <button
                className="text-button"
                type="button"
                onClick={() =>
                  useOrder(generated.entries.map((entry) => entry.id))
                }
              >
                按模版重新排列
              </button>
              {orderNotice && <p role="status">{orderNotice}</p>}
            </div>
          )}
        </div>
      )}
      <div className="complete-paper" onCopy={rememberPlainCopy}>
        <h1>{workflow.title}</h1>
        <WorkflowProse paragraphs={paragraphs} />
      </div>
    </main>
  );
}
