import type { Workflow, WorkflowDetailDocument } from "../../types";
import type { EditorDraft } from "./useWorkflowAutosave";
import {
  normalizeName,
  readWorkflow,
  resolveModuleLink,
  serializeWorkflow,
} from "./workflows";

type LocalDraft = { draft: EditorDraft; revision: number };

// Read-only recovery: keep the saved board and analyze local instructions
// without writing or removing backups. Conflicting sources require a choice.
export function completeWorkflowSources(
  records: Workflow[],
  readDraft: (id: string) => LocalDraft | null,
  preferLocal?: ReadonlySet<string>,
) {
  const draftDetails = new Map<string, Set<string>>();
  const olderDrafts = new Set<string>();
  const conflictingDrafts = new Set<string>();
  const previews = records.map((record) => {
    const local = readDraft(record.id);
    if (!local) return record;
    const saved = readWorkflow(record.draft);
    const byId = new Map(
      local.draft.details
        .filter((detail) => typeof detail.id === "string" && detail.id)
        .map((detail) => [detail.id, detail]),
    );
    const used = new Set<string>();
    const changed = new Set<string>();
    const details: WorkflowDetailDocument[] = saved.details.map((detail) => {
      const replacement = byId.get(detail.id);
      used.add(detail.id);
      if (
        !replacement ||
        JSON.stringify(replacement) === JSON.stringify(detail)
      )
        return detail;
      conflictingDrafts.add(record.id);
      changed.add(replacement.id);
      return replacement;
    });
    for (const detail of local.draft.details) {
      if (used.has(detail.id)) continue;
      if (
        normalizeName(detail.title) &&
        saved.details.some(
          (remote) =>
            normalizeName(remote.title) === normalizeName(detail.title),
        )
      )
        conflictingDrafts.add(record.id);
      details.push(detail);
      used.add(detail.id);
      changed.add(detail.id);
    }
    if (!changed.size) return record;
    draftDetails.set(record.id, changed);
    if (local.revision !== record.revision) olderDrafts.add(record.id);
    return {
      ...record,
      draft: JSON.stringify(
        serializeWorkflow({ modules: saved.modules, details }),
      ),
    };
  });
  // Recovery must not replace an already resolved shared instruction or make
  // another existing link ambiguous by adding a new same-name document.
  if (draftDetails.size) {
    const byId = new Map(previews.map((record) => [record.id, record]));
    for (const record of records) {
      const preview = byId.get(record.id)!;
      for (const module of readWorkflow(record.draft).modules) {
        const before = resolveModuleLink(record, module, records);
        if (before.status !== "MATCHED") continue;
        const after = resolveModuleLink(preview, module, previews);
        if (
          after.status !== "MATCHED" ||
          before.detail?.id !== after.detail?.id ||
          before.targetWorkflow?.id !== after.targetWorkflow?.id
        ) {
          for (const sourceId of draftDetails.keys())
            conflictingDrafts.add(sourceId);
        }
      }
    }
  }
  const usingLocalDrafts = new Set<string>();
  const workflows = records.map((record, index) => {
    if (
      !draftDetails.has(record.id) ||
      (conflictingDrafts.has(record.id) && !preferLocal?.has(record.id))
    )
      return record;
    usingLocalDrafts.add(record.id);
    return previews[index];
  });
  return {
    workflows,
    draftDetails,
    olderDrafts,
    conflictingDrafts,
    usingLocalDrafts,
  };
}
