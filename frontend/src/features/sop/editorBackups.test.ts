import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  editorBackupKey,
  readEditorBackup,
  readEditorBackupRecord,
  readEditorBackupForEditor,
  readEditorBackupRecords,
  removeEditorBackupRecord,
  writeEditorBackup,
} from "./editorBackups";
import type { EditorDraft } from "./useWorkflowAutosave";

const draft = (text: string): EditorDraft => ({
  title: text,
  category: "日常工作",
  modules: [],
  details: [],
});
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    get length() {
      return storage.size;
    },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const key = editorBackupKey("user", "org", "flow");

describe("independent editor backup snapshots", () => {
  it("keeps simultaneous tabs in separate keys and removes only the consumed snapshot", () => {
    const a = writeEditorBackup(key, "a", draft("甲页未保存内容"), 3);
    const b = writeEditorBackup(key, "b", draft("乙页未保存内容"), 3);
    expect(readEditorBackupRecords(key)).toHaveLength(2);
    removeEditorBackupRecord(a);
    expect(storage.has(a.key)).toBe(false);
    expect(storage.get(b.key)).toBe(b.raw);
    expect(readEditorBackup(key)?.draft.title).toBe("乙页未保存内容");
  });
  it("does not remove a snapshot changed since it was read", () => {
    const old = writeEditorBackup(key, "a", draft("旧内容"), 3);
    const latest = writeEditorBackup(key, "a", draft("新内容"), 3);
    removeEditorBackupRecord(old);
    expect(storage.get(latest.key)).toBe(latest.raw);
  });
  it("reads old single-key backups and chooses the latest tab while excluding recovery archives", () => {
    const legacy = JSON.stringify({ draft: draft("原单份草稿"), revision: 2 });
    storage.set(key, legacy);
    storage.set(
      `${key}:recovery:old`,
      JSON.stringify({ draft: draft("归档"), revision: 9, updatedAt: 999 }),
    );
    expect(readEditorBackupRecord(key)?.raw).toBe(legacy);
    vi.spyOn(Date, "now").mockReturnValue(100);
    const current = writeEditorBackup(key, "current", draft("最近草稿"), 3);
    expect(readEditorBackupRecord(key)?.key).toBe(current.key);
    expect(readEditorBackupRecords(key)).toHaveLength(2);
    expect(storage.get(key)).toBe(legacy);
  });
  it("restores this tab's snapshot after refresh even when another tab wrote later", () => {
    const pointers = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => pointers.get(key) ?? null,
      setItem: (key: string, value: string) => pointers.set(key, value),
      removeItem: (key: string) => pointers.delete(key),
    });
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(200);
    const a = writeEditorBackup(key, "a", draft("甲页"), 3);
    const b = writeEditorBackup(key, "b", draft("乙页"), 3);
    pointers.set(`${key}:active`, a.key);
    expect(readEditorBackupForEditor(key)?.key).toBe(a.key);
    expect(readEditorBackupRecord(key)?.key).toBe(b.key);
  });
});
