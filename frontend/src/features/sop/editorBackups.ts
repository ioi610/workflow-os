import type { EditorDraft } from "./useWorkflowAutosave";

export type EditorBackup = {
  draft: EditorDraft;
  revision: number;
  updatedAt?: number;
};
export type EditorBackupRecord = {
  key: string;
  raw: string;
  backup: EditorBackup;
};

export const editorBackupKey = (user: string, org: string, id: string) =>
  `workflow-os:editor:${user}:${org}:${id}`;

function parseBackup(raw: string | null): EditorBackup | null {
  try {
    const backup = JSON.parse(raw || "null"),
      draft = backup?.draft;
    return Number.isInteger(backup?.revision) &&
      typeof draft?.title === "string" &&
      typeof draft.category === "string" &&
      Array.isArray(draft.modules) &&
      draft.modules.every(
        (entry: { title?: unknown }) => typeof entry?.title === "string",
      ) &&
      Array.isArray(draft.details) &&
      draft.details.every(
        (entry: { title?: unknown; items?: unknown }) =>
          typeof entry?.title === "string" &&
          Array.isArray(entry.items) &&
          entry.items.every(
            (item: { text?: unknown } | null) => typeof item?.text === "string",
          ),
      )
      ? backup
      : null;
  } catch {
    return null;
  }
}

export function readEditorBackupRecords(key: string): EditorBackupRecord[] {
  try {
    const keys = new Set([key]);
    for (let index = 0; index < localStorage.length; index++) {
      const candidate = localStorage.key(index);
      if (candidate?.startsWith(`${key}:tab:`)) keys.add(candidate);
    }
    return [...keys]
      .flatMap((storageKey) => {
        const raw = localStorage.getItem(storageKey),
          backup = parseBackup(raw);
        return raw && backup ? [{ key: storageKey, raw, backup }] : [];
      })
      .sort(
        (a, b) =>
          (Number.isFinite(b.backup.updatedAt) ? b.backup.updatedAt! : 0) -
          (Number.isFinite(a.backup.updatedAt) ? a.backup.updatedAt! : 0),
      );
  } catch {
    return [];
  }
}

export const readEditorBackupRecord = (key: string) =>
  readEditorBackupRecords(key)[0] || null;
export const readEditorBackup = (key: string): EditorBackup | null =>
  readEditorBackupRecord(key)?.backup || null;

export function readEditorBackupForEditor(
  key: string,
): EditorBackupRecord | null {
  try {
    const preferred = sessionStorage.getItem(`${key}:active`);
    const own =
      preferred &&
      readEditorBackupRecords(key).find((record) => record.key === preferred);
    if (own) return own;
  } catch {
    /* session storage may be unavailable; all backups are still retained. */
  }
  return readEditorBackupRecord(key);
}

// A tab may clean up only the exact snapshot it read or wrote. Other tabs own
// separate keys, so an unchanged page cannot erase their unsaved work.
export function removeEditorBackupRecord(record: EditorBackupRecord | null) {
  if (record && localStorage.getItem(record.key) === record.raw) {
    localStorage.removeItem(record.key);
    try {
      const base = record.key.split(":tab:")[0];
      if (sessionStorage.getItem(`${base}:active`) === record.key)
        sessionStorage.removeItem(`${base}:active`);
    } catch {
      /* The backup itself has already been cleaned up. */
    }
  }
}

export function writeEditorBackup(
  key: string,
  owner: string,
  draft: EditorDraft,
  revision: number,
): EditorBackupRecord {
  const record = {
    key: `${key}:tab:${owner}`,
    raw: JSON.stringify({ draft, revision, updatedAt: Date.now() }),
    backup: { draft, revision },
  };
  localStorage.setItem(record.key, record.raw);
  try {
    sessionStorage.setItem(`${key}:active`, record.key);
  } catch {}
  return record;
}
