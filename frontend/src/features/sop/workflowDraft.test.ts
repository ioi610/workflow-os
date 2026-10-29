import { describe, expect, it } from "vitest";
import type { WorkflowDetailDocument } from "../../types";
import { validateContent } from "./workflows";
import {
  validateWorkflowDraft,
  workflowDraftPayload,
  workflowDraftSavePayload,
  type WorkflowDraftContent,
} from "./workflowDraft";

const draft = (): WorkflowDraftContent => ({
  title: "已有工作流程",
  category: "日常工作",
  boardSettings: null,
  modules: [
    {
      kind: "MODULE",
      id: "work",
      title: "已安排的工作",
      frame: { x: 10, y: 20, width: 100, height: 120 },
      custom: "保留",
    },
  ],
  details: [
    {
      kind: "DETAIL",
      id: "written",
      title: "已安排的工作",
      items: [
        { id: "one", text: "  先执行这一步\n保留原文字  " },
        { id: "blank", text: "" },
      ],
      materials: "已写好的准备事项",
      custom: { preserve: true },
    },
    {
      kind: "DETAIL",
      id: "untitled-a",
      title: "",
      items: [{ id: "new", text: "" }],
    },
    { kind: "DETAIL", id: "untitled-b", title: " \n\uFEFF", items: [] },
    { kind: "DETAIL", id: "named-empty", title: "另一项工作", items: [] },
  ],
});

describe("existing workflow draft saves", () => {
  it("allows unfinished named and unnamed instructions without blocking unrelated written content", () => {
    const current = draft(),
      before = structuredClone(current);
    expect(validateWorkflowDraft(current, "org")).toBeNull();
    expect(validateContent(current)).not.toBeNull();
    expect(current).toEqual(before);
    current.details[0].items = Array.from({ length: 100 }, (_, index) => ({
      id: String(index),
      text: index ? "" : "保留已有做法",
    }));
    expect(validateWorkflowDraft(current, "org")).toBeNull();
  });

  it("requires stable unique detail ids while allowing several unnamed documents", () => {
    for (const id of [undefined, "", " \n\uFEFF", "x".repeat(256), "written"]) {
      const current = draft();
      current.details[1].id = id as string;
      expect(validateWorkflowDraft(current, "org")).toContain("编号");
    }
    const current = draft();
    current.details[1].id = "work";
    current.details[2].id = " work ";
    expect(validateWorkflowDraft(current, "org")).toBeNull();
    expect(workflowDraftSavePayload(current).steps[3].id).toBe(" work ");
  });

  it("retains strict workflow and module names, count limits and nonempty instruction-name uniqueness", () => {
    const mutations: Array<(value: WorkflowDraftContent) => void> = [
      (value) => {
        value.title = "  ";
      },
      (value) => {
        value.title = "x".repeat(201);
      },
      (value) => {
        value.category = "x".repeat(101);
      },
      (value) => {
        value.modules[0].title = "";
      },
      (value) => {
        value.modules.push({
          ...value.modules[0],
          id: "duplicate",
          title: ` ${value.modules[0].title} `,
        });
      },
      (value) => {
        value.modules = Array.from({ length: 101 }, (_, index) => ({
          kind: "MODULE",
          id: String(index),
          title: `工作 ${index}`,
        }));
      },
      (value) => {
        value.details = Array.from({ length: 101 }, (_, index) => ({
          kind: "DETAIL",
          id: String(index),
          title: "",
          items: [],
        }));
      },
      (value) => {
        value.details[0].title = "café";
        value.details[1].title = " cafe\u0301 ";
      },
    ];
    for (const mutate of mutations) {
      const current = draft();
      mutate(current);
      expect(validateWorkflowDraft(current, "org")).not.toBeNull();
    }
  });

  it("accepts empty strings and zero rows but rejects malformed instruction lists", () => {
    for (const items of [
      null,
      "not an array",
      [null],
      ["text"],
      [{ text: 42 }],
      [{ text: null }],
      [{ text: ["text"] }],
      Array.from({ length: 101 }, () => ({ text: "" })),
    ]) {
      const current = draft();
      current.details[0].items = items as WorkflowDetailDocument["items"];
      expect(validateWorkflowDraft(current, "org")).not.toBeNull();
    }
    for (const text of ["", "  \n", "手写内容"]) {
      const current = draft();
      current.details[0].items = [{ id: "row", text }];
      expect(validateWorkflowDraft(current, "org")).toBeNull();
    }
  });

  it("keeps existing media restrictions in unfinished documents", () => {
    for (const value of [
      "https://example.com/reference",
      "/api/orgs/org/files/original",
      "",
    ]) {
      const current = draft();
      current.details[1].videoUrl = value;
      expect(validateWorkflowDraft(current, "org")).toBeNull();
    }
    for (const value of [
      "http://example.com/reference",
      "/api/orgs/other/files/original",
      "javascript:alert(1)",
    ]) {
      const current = draft();
      current.details[1].imageUrl = value;
      expect(validateWorkflowDraft(current, "org")).toContain("https://");
    }
  });

  it("sends the complete unfiltered draft with draftOnly while keeping protocol flags out of content fingerprints", () => {
    const current = draft(),
      before = structuredClone(current);
    const content = workflowDraftPayload(current),
      request = workflowDraftSavePayload(current);
    expect(content).not.toHaveProperty("draftOnly");
    expect(request.draftOnly).toBe(true);
    const { draftOnly: _flag, ...savedContent } = request;
    expect(savedContent).toEqual(content);
    expect(request.steps).toHaveLength(
      current.modules.length + current.details.length,
    );
    expect(request.steps[0]).toEqual(current.modules[0]);
    expect(request.steps[1]).toMatchObject({
      id: "written",
      materials: "已写好的准备事项",
      custom: { preserve: true },
      items: [
        { id: "one", text: "  先执行这一步\n保留原文字  " },
        { id: "blank", text: "" },
      ],
    });
    expect(request.steps[2]).toMatchObject({
      id: "untitled-a",
      title: "",
      items: [{ id: "new", text: "" }],
    });
    expect(request.steps[3]).toMatchObject({
      id: "untitled-b",
      title: "",
      items: [],
    });
    expect(current).toEqual(before);
  });
});
