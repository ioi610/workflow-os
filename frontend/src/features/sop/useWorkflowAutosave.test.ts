import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "../../types";
import {
  editableContent,
  editorBackupKey,
  readEditorBackup,
  type EditorDraft,
} from "./useWorkflowAutosave";
import { serializeWorkflow, validateContent } from "./workflows";

const workflow = (steps: unknown[]): Workflow => ({
  id: "workflow-a",
  title: "已有流程",
  category: "日常工作",
  revision: 7,
  draft: JSON.stringify(steps),
});

describe("editable legacy workflows", () => {
  it("preserves old empty instructions as saveable documents with stable IDs and metadata", () => {
    const blank = {
      id: "old-work",
      title: "旧工作",
      description: " \n\u00a0\ufeff",
      materials: "原有材料",
      imageUrl: "https://example.com/original.png",
      position: { x: 0.4, y: 0.2 },
      custom: { preserve: ["原始数据"] },
    };
    const unnamedId = { title: "没有旧编号的工作", description: "" };
    const record = workflow([blank, unnamedId]);
    const originalDraft = record.draft;

    const content = editableContent(record);

    expect(content.modules.map((entry) => entry.id)).toEqual([
      "module-old-work",
      "module-legacy-1",
    ]);
    expect(content.details).toEqual([
      {
        ...blank,
        id: "detail-old-work",
        kind: "DETAIL",
        legacyEmpty: true,
        items: [],
      },
      {
        ...unnamedId,
        id: "detail-legacy-1",
        kind: "DETAIL",
        legacyEmpty: true,
        items: [],
      },
    ]);
    expect(content.modules[0]).toMatchObject({
      ...blank,
      id: "module-old-work",
      kind: "MODULE",
    });
    expect(validateContent(content)).toBeNull();
    expect(serializeWorkflow(content)).toContainEqual(content.details[0]);
    expect(editableContent(record)).toEqual(content);
    expect(record.draft).toBe(originalDraft);
  });

  it("keeps nonempty old instructions and modern unfinished rows unchanged", () => {
    const legacy = {
      id: "with-instructions",
      title: "已有做法的工作",
      description: "  先断电。\n再检查设备。  ",
      custom: { tool: "原有工具" },
    };
    const modern = {
      kind: "DETAIL",
      id: "new-instructions",
      title: "正在填写的做法",
      items: [{ id: "unfinished-row", text: "" }],
      custom: { temporary: true },
    };
    const module = {
      kind: "MODULE",
      id: "modern-work",
      title: "现代格式的工作",
      description: "",
      size: { width: 0.4, height: 0.2 },
    };

    const content = editableContent(workflow([legacy, modern, module]));

    expect(content.details[0]).toEqual({
      ...legacy,
      kind: "DETAIL",
      id: "detail-with-instructions",
      items: [{ id: "item-with-instructions", text: legacy.description }],
    });
    expect(content.details[0]).not.toHaveProperty("legacyEmpty");
    expect(content.details[1]).toEqual(modern);
    expect(content.details[1]).not.toHaveProperty("legacyEmpty");
    expect(content.modules[1]).toEqual(module);
  });
});

describe("editor draft backups", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("safely ignores missing, broken, or unusable backups", () => {
    const key = editorBackupKey("person", "workspace", "workflow");
    expect(readEditorBackup(key)).toBeNull();
    for (const raw of [
      "{interrupted write",
      "null",
      JSON.stringify({ draft: { title: "只有部分内容" } }),
      JSON.stringify({
        revision: 3,
        draft: {
          title: "已有名称",
          category: "",
          modules: [null],
          details: [],
        },
      }),
      JSON.stringify({
        revision: 3,
        draft: {
          title: "已有名称",
          category: "",
          modules: [],
          details: [{ title: "做法", items: "损坏的清单" }],
        },
      }),
      JSON.stringify({
        revision: 3,
        draft: {
          title: "已有名称",
          category: "",
          modules: [],
          details: [{ title: "做法", items: [null] }],
        },
      }),
      JSON.stringify({
        revision: 3,
        draft: {
          title: "已有名称",
          category: "",
          modules: [],
          details: [{ title: "做法", items: [{ id: "broken", text: 42 }] }],
        },
      }),
    ]) {
      storage.set(key, raw);
      expect(readEditorBackup(key)).toBeNull();
      expect(storage.get(key)).toBe(raw);
    }
  });

  it("returns null when local storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage access denied");
      },
    });
    expect(readEditorBackup("some-backup")).toBeNull();
  });

  it("restores unfinished text and its revision without validating or trimming the draft", () => {
    const key = editorBackupKey("person", "workspace", "workflow");
    const draft: EditorDraft = {
      title: "  ",
      category: "  尚未整理  ",
      revision: 23,
      modules: [{ kind: "MODULE", id: "unfinished-work", title: "" }],
      details: [
        {
          kind: "DETAIL",
          id: "unfinished-detail",
          title: "正在编写的做法",
          items: [
            { id: "written-row", text: "  保留换行\n和两端空格  " },
            { id: "new-row", text: "" },
          ],
          videoUrl: "https:",
          custom: { preserve: true },
        },
      ],
    };
    const backup = { draft, revision: 23 };
    const raw = JSON.stringify(backup);
    storage.set(key, raw);

    expect(readEditorBackup(key)).toEqual(backup);
    expect(validateContent(draft)).not.toBeNull();
    expect(storage.get(key)).toBe(raw);
  });

  it("isolates drafts by person, workspace, and workflow", () => {
    const key = editorBackupKey("person-a", "workspace-a", "workflow-a");
    const backup = {
      revision: 9,
      draft: { title: "未完成", category: "", modules: [], details: [] },
    };
    storage.set(key, JSON.stringify(backup));
    const otherKeys = [
      editorBackupKey("person-b", "workspace-a", "workflow-a"),
      editorBackupKey("person-a", "workspace-b", "workflow-a"),
      editorBackupKey("person-a", "workspace-a", "workflow-b"),
    ];

    expect(new Set([key, ...otherKeys]).size).toBe(4);
    expect(readEditorBackup(key)).toEqual(backup);
    for (const other of otherKeys) expect(readEditorBackup(other)).toBeNull();
  });
});
