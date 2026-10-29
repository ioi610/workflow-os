import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "../../types";
const harness = vi.hoisted(() => ({
  effects: [] as Array<() => unknown>,
  request: vi.fn(),
}));
vi.mock("react", () => ({
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (callback: unknown) => callback,
  useState: (value: unknown) => [value, vi.fn()],
  useEffect: (callback: () => unknown) => harness.effects.push(callback),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }),
}));
vi.mock("../../api", () => ({ api: harness.request }));
import { useWorkflowAutosave, type EditorDraft } from "./useWorkflowAutosave";
import {
  editorBackupKey,
  readEditorBackupRecords,
  readEditorBackup,
  readEditorBackupRecord,
  type EditorBackupRecord,
} from "./editorBackups";

const record: Workflow = {
  id: "flow",
  title: "已有流程",
  category: "日常工作",
  revision: 3,
  draft: "[]",
};
const baseline: EditorDraft = {
  title: record.title,
  category: record.category!,
  modules: [],
  details: [],
  boardSettings: null,
};
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  harness.effects = [];
  harness.request.mockReset();
  vi.stubGlobal("localStorage", {
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    visibilityState: "visible",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(
  draft: EditorDraft,
  isNew = false,
  paused = true,
  restoredBackup: EditorBackupRecord | null = null,
) {
  harness.effects = [];
  const result = useWorkflowAutosave({
    id: isNew ? undefined : record.id,
    user: "user",
    org: "org",
    draft,
    initial: isNew ? null : record,
    restoredRevision: restoredBackup?.backup.revision ?? null,
    restoredBackup,
    enabled: true,
    paused,
  });
  const cleanups = harness.effects
    .map((effect) => effect())
    .filter((value): value is () => void => typeof value === "function");
  return { ...result, close: () => cleanups.forEach((cleanup) => cleanup()) };
}
describe("autosave snapshot ownership and new workflow recovery", () => {
  it("closing an unchanged old editor cannot erase another tab's unsaved backup", () => {
    const old = mount(structuredClone(baseline));
    const changed = mount({ ...baseline, title: "尚未同步的新名称" });
    const key = editorBackupKey("user", "org", "flow");
    const before = readEditorBackupRecords(key);
    expect(before).toHaveLength(1);
    old.close();
    expect(readEditorBackupRecords(key)).toEqual(before);
    expect(harness.request).not.toHaveBeenCalled();
    changed.close();
  });
  it("preserves both different dirty tabs rather than replacing a shared backup", () => {
    mount({ ...baseline, title: "甲页" });
    mount({ ...baseline, title: "乙页" });
    const records = readEditorBackupRecords(
      editorBackupKey("user", "org", "flow"),
    );
    expect(records.map((item) => item.backup.draft.title).sort()).toEqual(
      ["乙页", "甲页"].sort(),
    );
    expect(harness.request).not.toHaveBeenCalled();
  });
  it("backs up incomplete new content without creating a workflow and clears only its own backup after creation", async () => {
    const newDraft = {
      ...baseline,
      title: "",
      details: [
        {
          kind: "DETAIL" as const,
          id: "d",
          title: "",
          items: [{ id: "s", text: "还没起名的原文" }],
        },
      ],
    };
    const first = mount(newDraft, true);
    const key = editorBackupKey("user", "org", "new");
    expect(readEditorBackup(key)?.draft).toEqual(newDraft);
    const second = mount({ ...newDraft, title: "另一页的新流程" }, true);
    await first.flush();
    first.clearSavedBackup();
    first.close();
    expect(
      readEditorBackupRecords(key).map((item) => item.backup.draft.title),
    ).toEqual(["另一页的新流程"]);
    expect(harness.request).not.toHaveBeenCalled();
    second.close();
  });
  it("a successful save consumes the restored legacy snapshot while preserving another tab's changes", async () => {
    const key = editorBackupKey("user", "org", "flow");
    const changed = { ...baseline, title: "恢复后继续修改" };
    storage.set(
      key,
      JSON.stringify({
        draft: { ...baseline, title: "恢复前草稿" },
        revision: 3,
      }),
    );
    const restored = readEditorBackupRecord(key);
    const first = mount(changed, false, false, restored);
    mount({ ...baseline, title: "另一页尚未同步" });
    harness.request.mockResolvedValue({
      ...record,
      title: changed.title,
      revision: 4,
    });
    expect(await first.flush()).toBe(true);
    expect(storage.has(key)).toBe(false);
    expect(
      readEditorBackupRecords(key).map((item) => item.backup.draft.title),
    ).toEqual(["另一页尚未同步"]);
    expect(harness.request).toHaveBeenCalledTimes(1);
  });
  it("cleanup storage failure cannot turn successful creation into an error or a second API create", () => {
    const first = mount({ ...baseline, title: "已创建流程" }, true);
    const removeItem = localStorage.removeItem;
    localStorage.removeItem = () => {
      throw Error("storage unavailable");
    };
    expect(() => first.clearSavedBackup()).not.toThrow();
    expect(harness.request).not.toHaveBeenCalled();
    localStorage.removeItem = removeItem;
  });
  it("closing an unchanged dirty tab does not make its older text look newer than another tab's edit", () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(200)
      .mockReturnValue(300);
    const older = mount({ ...baseline, title: "较早写下的内容" });
    mount({ ...baseline, title: "后来写下的内容" });
    const key = editorBackupKey("user", "org", "flow");
    older.close();
    expect(readEditorBackup(key)?.draft.title).toBe("后来写下的内容");
  });
});
