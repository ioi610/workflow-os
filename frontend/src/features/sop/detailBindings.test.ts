import { describe, expect, it } from "vitest";
import type {
  Workflow,
  WorkflowDetailDocument,
  WorkflowModule,
} from "../../types";
import { bindContentDetails, bindModuleDetail } from "./detailBindings";
import {
  moduleHref,
  readWorkflow,
  resolveInstructionLink,
  resolveModuleLink,
  serializeWorkflow,
} from "./workflows";

const document = (
  id: string,
  title: string,
  text = "保留原手写做法",
): WorkflowDetailDocument => ({
  kind: "DETAIL",
  id,
  title,
  items: [{ id: `${id}-step`, text }],
  materials: "原材料",
  safetyNotice: "不要关闭电源",
  custom: { keep: true },
});
const record = (id: string, steps: unknown[]): Workflow => ({
  id,
  title: `流程${id}`,
  category: "",
  revision: 3,
  draft: JSON.stringify(steps),
});
const module = (title = "清洁"): WorkflowModule => ({
  kind: "MODULE",
  id: "work",
  title,
  frame: { x: 12, y: 34, width: 56, height: 78 },
  nextModuleIds: ["next"],
  connectionPorts: { next: { source: "left", target: "top" } },
});

describe("stable instruction bindings", () => {
  it("pins an explicitly chosen local document and never replaces it with another same-name source after deletion", () => {
    const local = document("local", "清洁", "用清水清洗"),
      remote = document("remote", "清洁", "使用另一份做法");
    const board = record("board", [local]),
      other = record("other", [remote]);
    const chosen = bindModuleDetail(
      board,
      { ...module(), detailWorkflowId: "board" },
      [board, other],
    );
    expect(chosen).toMatchObject({
      detailWorkflowId: "board",
      detailId: "local",
    });
    const after = record("board", [chosen]);
    const match = resolveModuleLink(after, chosen, [after, other]);
    expect(match.status).toBe("MISSING");
    expect(match.detail).toBeUndefined();
    expect(match.targetWorkflow).toBe(after);
  });

  it("retains an external document by ID through both module and source-document name changes", () => {
    const original = document("opaque / id", "旧做法"),
      source = record("source", [original]),
      board = record("board", []);
    const chosen = bindModuleDetail(
      board,
      {
        ...module("我的工作"),
        detailWorkflowId: source.id,
        detailName: "旧做法",
      },
      [source],
    );
    const renamed = record("source", [
      { ...original, title: "新做法" },
      document("replacement", "旧做法", "不可切换的同名文档"),
    ]);
    const match = resolveModuleLink(board, { ...chosen, title: "第二次改名" }, [
      renamed,
    ]);
    expect(match.detail).toEqual({ ...original, title: "新做法" });
    expect(moduleHref(board, chosen, [renamed])).toBe(
      "/workflows/source/steps?name=%E6%96%B0%E5%81%9A%E6%B3%95&detailId=opaque%20%2F%20id&from=board",
    );
    expect(resolveModuleLink(board, chosen, []).status).toBe("MISSING");
  });

  it("interprets an ID without a source as local-only and rejects missing or ambiguous IDs without name fallback", () => {
    const local = document("local", "清洁"),
      other = record("other", [document("external", "清洁")]);
    const board = record("board", [local]);
    const chosen = { ...module(), detailId: "local" };
    expect(resolveModuleLink(board, chosen, [other]).detail?.id).toBe("local");
    expect(
      resolveModuleLink(board, { ...chosen, detailId: "external" }, [other])
        .status,
    ).toBe("MISSING");
    expect(
      resolveModuleLink(board, { ...chosen, detailId: " " }, [other]).status,
    ).toBe("MISSING");
    const ambiguous = record("board", [local, { ...local, title: "另一份" }]);
    expect(resolveModuleLink(ambiguous, chosen, [other]).status).toBe(
      "AMBIGUOUS",
    );
  });

  it("binds before a local title edit while preserving all IDs, geometry, arrows, documents and draft fields", () => {
    const manual = document("manual", "清洁"),
      work = module();
    const draft = {
      ...readWorkflow(JSON.stringify([work, manual])),
      title: "流程标题",
      category: "分类",
      boardSettings: "原设置",
      revision: 9,
    };
    const before = JSON.stringify(draft);
    const bound = bindContentDetails(draft, "board", []);
    expect(bound.modules[0]).not.toBe(draft.modules[0]);
    expect(JSON.stringify(draft)).toBe(before);
    expect(bound).toEqual({
      ...draft,
      modules: [{ ...work, detailWorkflowId: "board", detailId: manual.id }],
    });
    const renamed = {
      ...bound,
      details: bound.details.map((detail) => ({ ...detail, title: "新名字" })),
    };
    const board = record("board", serializeWorkflow(renamed));
    expect(
      resolveModuleLink(board, renamed.modules[0], [board]).detail?.items,
    ).toEqual(manual.items);
    expect(bindContentDetails(renamed, "board", [])).toBe(renamed);
  });

  it("binds newly written local documents after a pending draft is added, without pinning temporary workflow IDs", () => {
    const work = module(),
      content = { modules: [work], details: [] as WorkflowDetailDocument[] };
    expect(bindContentDetails(content, undefined, [])).toBe(content);
    const written = { ...content, details: [document("written", "清洁", "")] };
    const bound = bindContentDetails(written, undefined, []);
    expect(bound.modules[0]).toEqual({ ...work, detailId: "written" });
    expect(bound.details).toBe(written.details);
    const created = record("real-id", serializeWorkflow(bound));
    expect(
      resolveModuleLink(created, bound.modules[0], [created]).detail?.id,
    ).toBe("written");
  });

  it("leaves missing and ambiguous old names unresolved and retains existing lost bindings", () => {
    const work = module(),
      board = record("board", []);
    const sources = [
      record("one", [document("one", "清洁")]),
      record("two", [document("two", "清洁")]),
    ];
    expect(bindModuleDetail(board, work, sources)).toBe(work);
    const lost = { ...work, detailWorkflowId: "gone", detailId: "gone-doc" };
    expect(bindModuleDetail(board, lost, sources)).toBe(lost);
  });

  it("uses the document ID from a canonical reader URL even when its name is stale or another document reuses that name", () => {
    const chosen = document("chosen", "新名字"),
      reused = document("other", "旧名字");
    const board = record("board", [chosen, reused]);
    expect(
      resolveInstructionLink(board, "旧名字", [board], null, "chosen").detail
        ?.id,
    ).toBe("chosen");
    expect(
      resolveInstructionLink(board, "旧名字", [board], null, "deleted").status,
    ).toBe("MISSING");
    expect(resolveInstructionLink(board, "旧名字", [board]).detail?.id).toBe(
      "other",
    );
  });
});
