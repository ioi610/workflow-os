import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import type { Workflow, WorkflowContent } from "../../types";
import { readSteps, readWorkflow, workflowKey } from "./workflows";
import { workItemsKey } from "./workItems";
import {
  validateWorkflowDraft,
  workflowDraftPayload,
  workflowDraftSavePayload,
} from "./workflowDraft";

export type EditorDraft = WorkflowContent & {
  title: string;
  category: string;
  revision?: number;
  boardSettings?: string | null;
};
export { editorBackupKey, readEditorBackup } from "./editorBackups";
import {
  editorBackupKey,
  removeEditorBackupRecord,
  writeEditorBackup,
  type EditorBackupRecord,
} from "./editorBackups";

export function editableContent(record: Workflow): WorkflowContent {
  const content = readWorkflow(record.draft);
  // Empty instructions in old workflows are valid; retain that narrow compatibility.
  for (const [index, step] of readSteps(record.draft).entries()) {
    if (
      step.kind === "MODULE" ||
      step.kind === "DETAIL" ||
      (step.description || "").trim()
    )
      continue;
    const detail = content.details.find(
      (entry) => entry.id === `detail-${step.id || `legacy-${index}`}`,
    );
    if (detail) {
      detail.items = [];
      detail.legacyEmpty = true;
    }
  }
  return content;
}

const payload = workflowDraftPayload;
const fingerprint = (draft: EditorDraft) => JSON.stringify(payload(draft));
const recordDraft = (record: Workflow): EditorDraft => ({
  ...editableContent(record),
  title: record.title,
  category: record.category || "",
  boardSettings: record.boardSettings ?? null,
});
const problem = validateWorkflowDraft;

export function useWorkflowAutosave({
  id,
  org,
  user,
  draft,
  initial,
  restoredRevision,
  restoredBackup,
  enabled,
  paused,
}: {
  id?: string;
  org: string;
  user: string;
  draft: EditorDraft | null;
  initial: Workflow | null;
  restoredRevision: number | null;
  restoredBackup?: EditorBackupRecord | null;
  enabled: boolean;
  paused: boolean;
}) {
  const qc = useQueryClient();
  const latest = useRef(draft);
  latest.current = draft;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const session = useRef<{
    revision: number;
    confirmed: string;
    blocked: boolean;
    conflict: boolean;
  } | null>(null);
  const running = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const [status, setStatus] = useState("编辑后自动保存");
  const [error, setError] = useState("");
  const [backupError, setBackupError] = useState("");
  const [saving, setSaving] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const key = editorBackupKey(user, org, id || "new");
  const owner = useRef(crypto.randomUUID());
  const writtenBackup = useRef<EditorBackupRecord | null>(null);
  const restoredSnapshot = useRef(restoredBackup);
  if (restoredBackup) restoredSnapshot.current = restoredBackup;

  const clearSavedBackup = useCallback(() => {
    if (session.current && latest.current)
      session.current.confirmed = fingerprint(latest.current);
    try {
      removeEditorBackupRecord(writtenBackup.current);
      writtenBackup.current = null;
      removeEditorBackupRecord(restoredSnapshot.current || null);
      restoredSnapshot.current = null;
    } catch {
      // The workflow already exists on the server. Cleanup failure must not
      // turn a successful creation into a retry that creates a duplicate.
      setBackupError("流程已创建，本机旧草稿暂时未能清理。");
    }
  }, []);

  const backup = useCallback(() => {
    const current = latest.current,
      state = session.current;
    if (!key || !current || !state || !enabled) return true;
    try {
      if (fingerprint(current) === state.confirmed) {
        removeEditorBackupRecord(writtenBackup.current);
        writtenBackup.current = null;
      } else {
        const previous = writtenBackup.current;
        const previousValue = previous ? JSON.parse(previous.raw) : null;
        if (
          !previous ||
          previousValue.revision !== state.revision ||
          JSON.stringify(previousValue.draft) !== JSON.stringify(current) ||
          localStorage.getItem(previous.key) !== previous.raw
        ) {
          writtenBackup.current = writeEditorBackup(
            key,
            owner.current,
            current,
            state.revision,
          );
        }
      }
      if (mounted.current) setBackupError("");
      return true;
    } catch {
      if (mounted.current)
        setBackupError("本机草稿没能保留，请保持页面打开，等自动保存完成。");
      return false;
    }
  }, [key, enabled]);

  const flush = useCallback((): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    if (running.current) return running.current;
    const state = session.current;
    if (!enabled || !state) return Promise.resolve(true);
    if (!id) return Promise.resolve(backup());
    const run = async () => {
      if (state.conflict) {
        backup();
        return false;
      }
      while (
        latest.current &&
        fingerprint(latest.current) !== state.confirmed
      ) {
        const current = latest.current;
        if (state.blocked || pausedRef.current || problem(current, org)) {
          backup();
          return false;
        }
        const sent = fingerprint(current),
          expectedRevision = state.revision;
        if (mounted.current) {
          setSaving(true);
          setStatus("正在保存…");
          setError("");
        }
        let saved: Workflow;
        try {
          saved = await api<Workflow>(`/orgs/${org}/sops/save`, {
            id,
            expectedRevision,
            ...workflowDraftSavePayload(current),
          });
        } catch (failure) {
          // A response can be lost after the server commits. Only acknowledge an exact match.
          let remote: Workflow | undefined;
          try {
            remote = (await api<Workflow[]>(`/orgs/${org}/sops`)).find(
              (record) => record.id === id,
            );
          } catch {}
          if (remote && fingerprint(recordDraft(remote)) === sent)
            saved = remote;
          else {
            state.blocked = true;
            state.conflict = !!remote && remote.revision !== expectedRevision;
            const preserved = backup();
            if (mounted.current) {
              setStatus(preserved ? "草稿已保留在本机" : "尚未保存");
              setError(
                state.conflict
                  ? "这个流程在别处改过，自动保存已暂停。你的草稿已保留，没有覆盖另一份修改。"
                  : `自动保存没成功，草稿已保留。${(failure as Error).message}`,
              );
            }
            return false;
          }
        }
        state.revision = saved.revision;
        state.confirmed = sent;
        qc.setQueryData<Workflow[]>(workflowKey(org), (old) => [
          ...(old || []).filter((record) => record.id !== saved.id),
          saved,
        ]);
        await Promise.all([
          qc.invalidateQueries({ queryKey: workflowKey(org) }),
          qc.invalidateQueries({ queryKey: workItemsKey(org) }),
        ]);
        // Remove only the snapshots this editor consumed. Keep later edits and
        // backups belonging to other open tabs.
        try {
          removeEditorBackupRecord(restoredSnapshot.current || null);
          restoredSnapshot.current = null;
        } catch {
          // The server has committed; a local cleanup error must not turn this
          // into a failed save. backup() reports unavailable storage below.
        }
        backup();
      }
      if (mounted.current) {
        setStatus("已自动保存");
        setError("");
      }
      return true;
    };
    const task = run().finally(() => {
      running.current = null;
      if (mounted.current) setSaving(false);
    });
    running.current = task;
    return task;
  }, [enabled, id, org, qc, backup]);

  useEffect(() => {
    if (!enabled || (id && !initial) || session.current) return;
    const confirmed = initial
      ? recordDraft(initial)
      : {
          title: "",
          category: "日常工作",
          modules: [],
          details: [],
          boardSettings: null,
        };
    const conflict =
      !!initial &&
      restoredRevision !== null &&
      restoredRevision !== initial.revision &&
      !!latest.current &&
      fingerprint(latest.current) !== fingerprint(recordDraft(initial));
    session.current = {
      revision: conflict ? restoredRevision! : (initial?.revision ?? 0),
      confirmed: fingerprint(confirmed),
      blocked: conflict,
      conflict,
    };
    if (conflict)
      setError("这个流程在别处改过，自动保存已暂停。你的本机草稿仍然保留。");
  }, [enabled, id, initial, restoredRevision]);

  useEffect(() => {
    const state = session.current;
    if (!enabled || !draft || !state) return;
    const preserved = backup();
    if (fingerprint(draft) === state.confirmed && !state.conflict) {
      state.blocked = false;
      setStatus("已自动保存");
      setError("");
      return;
    }
    if (state.blocked) {
      setStatus(preserved ? "草稿已保留在本机" : "尚未保存");
      return;
    }
    if (!id) {
      setStatus(
        preserved ? "草稿已保留在本机，点击添加流程后创建" : "尚未保存",
      );
      return;
    }
    if (paused) {
      setStatus("输入停下后自动保存");
      return;
    }
    const validation = problem(draft, org);
    if (validation) {
      setStatus(
        preserved ? "草稿已保留，补全后自动保存" : "内容还没写完，尚未保存",
      );
      setError(validation);
      return;
    }
    setError("");
    if (!running.current) setStatus("输入停下后自动保存");
    timer.current = setTimeout(() => {
      void flush();
    }, 700);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, id, draft, initial, org, backup, flush, retryVersion, paused]);

  useEffect(() => {
    mounted.current = true;
    const preserve = () => backup();
    const hide = () => {
      if (document.visibilityState === "hidden") {
        backup();
        void flush();
      }
    };
    window.addEventListener("beforeunload", preserve);
    window.addEventListener("pagehide", preserve);
    document.addEventListener("visibilitychange", hide);
    return () => {
      backup();
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      void flush();
      window.removeEventListener("beforeunload", preserve);
      window.removeEventListener("pagehide", preserve);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [backup, flush]);

  function retry() {
    if (!session.current || session.current.conflict) return;
    session.current.blocked = false;
    setRetryVersion((value) => value + 1);
  }
  return {
    flush,
    clearSavedBackup,
    saving,
    status,
    error: backupError || error,
    retry,
    canRetry: !!session.current?.blocked && !session.current.conflict,
  };
}
