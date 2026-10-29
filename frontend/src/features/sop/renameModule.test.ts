import { describe, expect, it } from "vitest";
import type { Workflow, WorkflowModule, WorkflowStep } from "../../types";
import { renameModuleEntries } from "./renameModule";
import {
  moduleHref,
  newModule,
  readSteps,
  readWorkflow,
  resolveModuleLink,
} from "./workflows";

const workflow = (id: string, steps: unknown[]): Workflow => ({
  id,
  title: `流程 ${id}`,
  category: "日常工作",
  revision: 3,
  boardSettings: '{"canvas":{"width":1600,"height":1000}}',
  draft: JSON.stringify(steps),
});
const detail = (id: string, title: string) => ({
  kind: "DETAIL",
  id,
  title,
  items: [{ id: `${id}-item`, text: `手写的${title}做法` }],
  imageUrl: "https://example.com/original.png",
  materials: "原来的工具",
  safetyNotice: "保留注意事项",
  custom: { original: true },
});
const renamedModule = (steps: WorkflowStep[], id: string) =>
  readWorkflow(JSON.stringify(steps)).modules.find((entry) => entry.id === id)!;

describe("rename a workflow module", () => {
  it("renames the unique local document while preserving work identities, geometry, ports and written content", () => {
    const other = {
      ...newModule("收尾"),
      nextModuleIds: ["module-a"],
      connectionPorts: { "module-a": { source: "left", target: "right" } },
    };
    const module = {
      ...newModule("准备"),
      id: "module-a",
      frame: { x: 80, y: 140, width: 64, height: 96 },
      position: { x: 0.1, y: 0.2 },
      size: { width: 0.2, height: 0.3 },
      nextModuleIds: [other.id],
      connectionPorts: { [other.id]: { source: "top", target: "bottom" } },
      custom: { keep: true },
    };
    const manual = detail("manual-a", "准备");
    const board = workflow("board", [module, manual, other]);
    const original = structuredClone(board);
    const steps = renameModuleEntries(board, module.id, " Cafe\u0301 ", [
      board,
    ]);
    expect(steps).toEqual([
      {
        ...module,
        title: "Café",
        detailWorkflowId: "board",
        detailId: manual.id,
      },
      { ...manual, title: "Café" },
      other,
    ]);
    expect(board).toEqual(original);
    const changed = { ...board, draft: JSON.stringify(steps) };
    expect(
      resolveModuleLink(changed, renamedModule(steps, module.id), [changed])
        .detail,
    ).toMatchObject({
      id: manual.id,
      title: "Café",
      items: manual.items,
      imageUrl: manual.imageUrl,
    });
  });

  it("rejects empty, overlong and normalized duplicate module names and local document collisions", () => {
    const a = newModule("准备"),
      b = newModule("Café");
    const board = workflow("board", [a, b, detail("d", "准备")]);
    expect(() => renameModuleEntries(board, a.id, " \n ", [board])).toThrow(
      "填写工作名称",
    );
    expect(() =>
      renameModuleEntries(board, a.id, "字".repeat(201), [board]),
    ).toThrow("200");
    expect(() =>
      renameModuleEntries(board, a.id, " Cafe\u0301 ", [board]),
    ).toThrow("已经有一项工作");
    expect(() => renameModuleEntries(board, "gone", "新名字", [board])).toThrow(
      "不在这里",
    );
    const collision = workflow("board", [
      a,
      detail("old", "准备"),
      detail("other", "Café"),
    ]);
    expect(() =>
      renameModuleEntries(collision, a.id, " Cafe\u0301 ", [collision]),
    ).toThrow("已经有一份做法");
  });

  it("treats normalized identical names as an exact no-op including aliases and stored whitespace", () => {
    const module = {
      ...newModule(" Café "),
      detailName: "外部原名",
      detailWorkflowId: "chosen",
      custom: "unchanged",
    };
    const board = workflow("board", [module]);
    expect(
      renameModuleEntries(board, module.id, " Cafe\u0301 ", [board]),
    ).toEqual(readSteps(board.draft));
  });

  it("renames a shared legacy module/document row without replacing its generated identifier", () => {
    const legacy = {
      title: "旧工作",
      description: "旧的手写原文",
      frame: { x: 20, y: 30, width: 164, height: 164 },
      nextModuleIds: ["modern"],
      connectionPorts: { modern: { source: "right", target: "left" } },
      custom: { legacy: true },
    };
    const modern = {
      ...newModule("收好"),
      id: "modern",
      nextModuleIds: ["module-legacy-0"],
    };
    const board = workflow("board", [legacy, modern]);
    const steps = renameModuleEntries(
      board,
      "module-legacy-0",
      " 新的工作名 ",
      [board],
    );
    expect(steps).toEqual([{ ...legacy, title: "新的工作名" }, modern]);
    const content = readWorkflow(JSON.stringify(steps));
    expect(content.modules[0].id).toBe("module-legacy-0");
    expect(content.details[0]).toMatchObject({
      id: "detail-legacy-0",
      title: "新的工作名",
      items: [{ id: "item-legacy-0", text: legacy.description }],
      custom: legacy.custom,
    });
  });

  it("pins an explicitly selected external document under its original name across repeated module renames", () => {
    const module = {
      ...newModule("清洁"),
      detailWorkflowId: "chosen",
      frame: { x: 90, y: 80, width: 164, height: 164 },
    };
    const local = detail("local", "清洁");
    const board = workflow("board", [module, local]);
    const chosen = workflow("chosen", [detail("external", "清洁")]);
    const another = workflow("another", [detail("another", "清洁")]);
    const originals = structuredClone([board, chosen, another]);
    let steps = renameModuleEntries(board, module.id, " 我的清洁工作 ", [
      board,
      chosen,
      another,
    ]);
    let renamed = renamedModule(steps, module.id);
    expect(renamed).toEqual({
      ...module,
      title: "我的清洁工作",
      detailName: "清洁",
      detailId: "external",
    });
    const changed = { ...board, draft: JSON.stringify(steps) };
    expect(moduleHref(changed, renamed, [changed, chosen, another])).toBe(
      "/workflows/chosen/steps?name=%E6%B8%85%E6%B4%81&detailId=external&from=board",
    );
    expect(
      resolveModuleLink(changed, renamed, [chosen, another]).detail?.id,
    ).toBe("external");
    steps = renameModuleEntries(changed, module.id, "第二次改名", [
      changed,
      chosen,
      another,
    ]);
    renamed = renamedModule(steps, module.id);
    expect(renamed).toMatchObject({
      title: "第二次改名",
      detailName: "清洁",
      detailWorkflowId: "chosen",
    });
    expect(steps[1]).toEqual(local);
    expect([board, chosen, another]).toEqual(originals);
  });

  it("keeps an implicitly found external document rather than switching to a local document with the new name", () => {
    const module = newModule("共享做法");
    const local = detail("local", "我的工作");
    const board = workflow("board", [module, local]);
    const source = workflow("source", [detail("shared", "共享做法")]);
    const steps = renameModuleEntries(board, module.id, "我的工作", [
      board,
      source,
    ]);
    const renamed = renamedModule(steps, module.id);
    expect(renamed).toMatchObject({
      title: "我的工作",
      detailWorkflowId: "source",
      detailName: "共享做法",
    });
    const changed = { ...board, draft: JSON.stringify(steps) };
    expect(
      resolveModuleLink(changed, renamed, [changed, source]).detail?.id,
    ).toBe("shared");
    expect(steps[1]).toEqual(local);
  });

  it("removes a redundant local alias while renaming its uniquely matched local document", () => {
    const module = {
      ...newModule("我的别名"),
      detailName: " 原做法 ",
      detailWorkflowId: "board",
    };
    const manual = detail("original", "原做法");
    const board = workflow("board", [module, manual]);
    const steps = renameModuleEntries(board, module.id, "统一名称", [board]);
    expect(steps[0]).toEqual({
      kind: "MODULE",
      id: module.id,
      title: "统一名称",
      detailWorkflowId: "board",
      detailId: "original",
    });
    expect(steps[1]).toEqual({ ...manual, title: "统一名称" });
    expect(
      moduleHref(
        { ...board, draft: JSON.stringify(steps) },
        renamedModule(steps, module.id),
        [],
      ),
    ).toBe(
      "/workflows/board/steps?name=%E7%BB%9F%E4%B8%80%E5%90%8D%E7%A7%B0&detailId=original",
    );
  });

  it("keeps a locally shared document name stable across repeated caption changes", () => {
    const module = newModule("清洁");
    const reuse = {
      ...newModule("第二班清洁"),
      detailWorkflowId: "board",
      detailName: "清洁",
    };
    const manual = detail("shared", "清洁");
    const board = workflow("board", [module, reuse, manual]);
    const first = renameModuleEntries(board, module.id, "早班清洁", [board]);
    expect(first).toEqual([
      {
        ...module,
        title: "早班清洁",
        detailWorkflowId: "board",
        detailName: "清洁",
        detailId: "shared",
      },
      reuse,
      manual,
    ]);
    const changed = { ...board, draft: JSON.stringify(first) };
    const second = renameModuleEntries(changed, module.id, "更早的清洁", [
      changed,
    ]);
    expect(second[2]).toEqual(manual);
    expect(renamedModule(second, module.id)).toMatchObject({
      title: "更早的清洁",
      detailWorkflowId: "board",
      detailName: "清洁",
    });
    const final = { ...board, draft: JSON.stringify(second) };
    expect(
      resolveModuleLink(final, renamedModule(second, reuse.id), [final]).detail
        ?.id,
    ).toBe(manual.id);
    expect(moduleHref(final, renamedModule(second, module.id), [final])).toBe(
      "/workflows/board/steps?name=%E6%B8%85%E6%B4%81&detailId=shared",
    );
  });

  it("preserves a local document that another workflow actually references without changing that workflow", () => {
    const module = newModule("清洁");
    const manual = detail("shared", "清洁");
    const board = workflow("board", [module, manual]);
    const dependent = {
      ...newModule("别的流程里的清洁"),
      detailWorkflowId: "board",
      detailName: "清洁",
    };
    const other = workflow("other", [dependent]);
    const original = structuredClone(other);
    const stale = workflow("board", [module, detail("shared", "过时的标题")]);
    const steps = renameModuleEntries(board, module.id, "新的清洁名称", [
      stale,
      other,
    ]);
    expect(steps[1]).toEqual(manual);
    expect(steps[0]).toMatchObject({
      title: "新的清洁名称",
      detailWorkflowId: "board",
      detailName: "清洁",
    });
    const changed = { ...board, draft: JSON.stringify(steps) };
    expect(
      resolveModuleLink(other, dependent, [changed, other]).detail?.id,
    ).toBe(manual.id);
    expect(other).toEqual(original);
  });

  it("splits a shared legacy row without changing existing module or detail identities", () => {
    const old = {
      title: "旧工作",
      description: "",
      imageUrl: "https://example.com/legacy.png",
      frame: { x: 10, y: 20, width: 164, height: 164 },
      nextModuleIds: ["module-1"],
      connectionPorts: { "module-1": { source: "top", target: "left" } },
      custom: "keep",
    };
    const reuse = {
      kind: "MODULE",
      title: "复用旧工作",
      detailWorkflowId: "board",
      detailName: "旧工作",
      nextModuleIds: ["module-legacy-0"],
    };
    const another = { title: "另一项旧工作", description: "另一份原文" };
    const standalone = {
      kind: "DETAIL",
      title: "单独做法",
      items: [{ id: "i", text: "独立原文" }],
    };
    const board = workflow("board", [old, reuse, another, standalone]);
    const before = readWorkflow(board.draft);
    const steps = renameModuleEntries(board, "module-legacy-0", "新工作名", [
      board,
    ]);
    const after = readWorkflow(JSON.stringify(steps));
    expect(after.modules.map((entry) => entry.id)).toEqual(
      before.modules.map((entry) => entry.id),
    );
    expect(after.details.map((entry) => entry.id)).toEqual(
      before.details.map((entry) => entry.id),
    );
    expect(after.modules[0]).toMatchObject({
      id: "module-legacy-0",
      title: "新工作名",
      detailWorkflowId: "board",
      detailName: "旧工作",
      frame: old.frame,
      nextModuleIds: old.nextModuleIds,
      connectionPorts: old.connectionPorts,
      custom: old.custom,
    });
    expect(after.details[0]).toMatchObject({
      title: "旧工作",
      legacyEmpty: true,
      items: [],
      imageUrl: old.imageUrl,
      custom: old.custom,
    });
    expect(after.modules[1]).toMatchObject({
      title: reuse.title,
      detailName: reuse.detailName,
      nextModuleIds: reuse.nextModuleIds,
    });
    const changed = { ...board, draft: JSON.stringify(steps) };
    expect(
      resolveModuleLink(changed, after.modules[1], [changed]).detail?.id,
    ).toBe(before.details[0].id);
  });

  it("leaves unmatched and ambiguous documents alone and lets the new name resolve normally", () => {
    const module = {
      ...newModule("旧显示名称"),
      detailName: "已经删掉的做法",
      detailWorkflowId: "chosen",
    };
    const board = workflow("board", [module]);
    const chosen = workflow("chosen", [detail("new-doc", "新名称")]);
    const steps = renameModuleEntries(board, module.id, "新名称", [
      board,
      chosen,
    ]);
    expect(steps[0]).toEqual({
      kind: "MODULE",
      id: module.id,
      title: "新名称",
      detailWorkflowId: "chosen",
    });
    const changed = { ...board, draft: JSON.stringify(steps) };
    expect(
      resolveModuleLink(changed, renamedModule(steps, module.id), [chosen])
        .detail?.id,
    ).toBe("new-doc");
    const ambiguous = { ...newModule("旧显示名称"), detailName: "重复做法" };
    const ambBoard = workflow("amb", [ambiguous]);
    const first = workflow("first", [detail("d1", "重复做法")]);
    const second = workflow("second", [detail("d2", "重复做法")]);
    const renamed = renameModuleEntries(ambBoard, ambiguous.id, "全新名称", [
      ambBoard,
      first,
      second,
    ]);
    expect(renamed[0]).toEqual({
      kind: "MODULE",
      id: ambiguous.id,
      title: "全新名称",
    });
    expect(
      resolveModuleLink(
        { ...ambBoard, draft: JSON.stringify(renamed) },
        renamedModule(renamed, ambiguous.id),
        [first, second],
      ).status,
    ).toBe("MISSING");
    const missing = newModule("没写做法");
    const localBoard = workflow("local", [
      missing,
      detail("available", "可用名称"),
    ]);
    const localRename = renameModuleEntries(
      localBoard,
      missing.id,
      "可用名称",
      [localBoard],
    );
    expect(localRename[1]).toEqual(readSteps(localBoard.draft)[1]);
    expect(
      resolveModuleLink(
        { ...localBoard, draft: JSON.stringify(localRename) },
        renamedModule(localRename, missing.id),
        [],
      ).detail?.id,
    ).toBe("available");
  });

  it("resolves normalized aliases first and builds the URL using the actual detail name", () => {
    const board = workflow("board", []);
    const source = workflow("source", [
      detail("cafe", "Café"),
      detail("caption", "我的咖啡"),
    ]);
    const module: WorkflowModule = {
      ...newModule("我的咖啡"),
      detailName: " Cafe\u0301 ",
      detailWorkflowId: "source",
    };
    expect(resolveModuleLink(board, module, [source]).detail?.id).toBe("cafe");
    expect(moduleHref(board, module, [source])).toBe(
      "/workflows/source/steps?name=Caf%C3%A9&detailId=cafe&from=board",
    );
    expect(
      resolveModuleLink(board, { ...module, detailName: " " }, [source]).detail
        ?.id,
    ).toBe("caption");
  });

  it("keeps a stable binding after the source document is renamed and its old name is reused", () => {
    const module = {
      ...newModule("我的清洁"),
      detailWorkflowId: "source",
      detailId: "original",
      detailName: "旧清洁",
    };
    const source = workflow("source", [
      detail("original", "新清洁"),
      detail("replacement", "旧清洁"),
    ]);
    const board = workflow("board", [module]);
    const steps = renameModuleEntries(board, module.id, "早班清洁", [
      board,
      source,
    ]);
    expect(renamedModule(steps, module.id)).toMatchObject({
      detailWorkflowId: "source",
      detailId: "original",
      detailName: "新清洁",
    });
    const changed = { ...board, draft: JSON.stringify(steps) };
    expect(
      resolveModuleLink(changed, renamedModule(steps, module.id), [source])
        .detail?.id,
    ).toBe("original");
  });

  it("does not retarget a missing stable document when renaming the module to another available document name", () => {
    const module = {
      ...newModule("原工作"),
      detailWorkflowId: "source",
      detailId: "deleted",
      detailName: "旧做法",
    };
    const source = workflow("source", [detail("other", "可用名称")]);
    const board = workflow("board", [module]);
    const steps = renameModuleEntries(board, module.id, "可用名称", [source]);
    const changed = { ...board, draft: JSON.stringify(steps) };
    expect(renamedModule(steps, module.id)).toMatchObject({
      detailWorkflowId: "source",
      detailId: "deleted",
    });
    expect(
      resolveModuleLink(changed, renamedModule(steps, module.id), [source])
        .status,
    ).toBe("MISSING");
  });
});
