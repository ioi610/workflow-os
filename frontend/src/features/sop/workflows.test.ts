import { describe, expect, it } from "vitest";
import type { Workflow, WorkflowDetailDocument } from "../../types";
import {
  appendModuleEntries,
  matchDetail,
  moduleHref,
  newDetail,
  newModule,
  normalizeName,
  readWorkflow,
  reorderModuleEntries,
  resolveInstructionLink,
  resolveModuleLink,
  serializeWorkflow,
  validateContent,
} from "./workflows";

const detail = (title: string): WorkflowDetailDocument => ({
  ...newDetail(title),
  items: [{ id: "first", text: "手动写下的第一步" }],
});
const workflow = (
  id: string,
  details: WorkflowDetailDocument[] = [],
): Workflow => ({
  id,
  title: id,
  category: "日常工作",
  revision: 1,
  draft: JSON.stringify(details),
});

describe("template module creation", () => {
  it("allows saving a blank template before arranging any work", () => {
    expect(validateContent({ modules: [], details: [] })).toBeNull();
    expect(appendModuleEntries("[]", newModule(" 第一项 "))[0].title).toBe(
      "第一项",
    );
  });
  it("appends a link without converting old records or copying its source list", () => {
    const legacy = {
      title: "旧工作",
      description: "",
      videoUrl: "/media/old.mp4",
      custom: { original: true },
    };
    const localDetail = detail("现有做法");
    const module = { ...newModule(" Café "), detailWorkflowId: "source" };
    const stored = appendModuleEntries(
      JSON.stringify([legacy, localDetail]),
      module,
    );
    expect(stored).toEqual([legacy, localDetail, { ...module, title: "Café" }]);
    expect(readWorkflow(JSON.stringify(stored)).details).toHaveLength(2);
    expect(readWorkflow(JSON.stringify(stored)).details[0].items[0].text).toBe(
      "",
    );
  });
  it("rejects blank names, normalized duplicate names and a 101st module", () => {
    expect(() => appendModuleEntries("[]", newModule(" "))).toThrow("名称");
    expect(() =>
      appendModuleEntries(
        JSON.stringify([{ title: "Café", description: "旧做法" }]),
        newModule(" Cafe\u0301 "),
      ),
    ).toThrow("请换个名称");
    const full = Array.from({ length: 100 }, (_, i) => newModule(`工作 ${i}`));
    expect(() =>
      appendModuleEntries(JSON.stringify(full), newModule("额外工作")),
    ).toThrow("100");
  });
});

describe("reusable same-name work links", () => {
  it("automatically resolves a unique list elsewhere and returns to the source template", () => {
    const board = workflow("board");
    const source = workflow("source", [detail("Café")]);
    const module = newModule(" Cafe\u0301 ");
    const resolved = resolveModuleLink(board, module, [board, source]);
    expect(resolved.status).toBe("MATCHED");
    expect(resolved.targetWorkflow).toBe(source);
    expect(resolved.detail?.items).toEqual(
      readWorkflow(source.draft).details[0].items,
    );
    expect(moduleHref(board, module, [board, source])).toBe(
      `/workflows/source/steps?name=Caf%C3%A9&detailId=${readWorkflow(source.draft).details[0].id}&from=board`,
    );
    expect(JSON.parse(board.draft)).toEqual([]);
  });
  it("prefers a local list even when another workflow has the same name", () => {
    const board = workflow("board", [detail("清洁")]);
    const source = workflow("source", [detail("清洁")]);
    const module = newModule("清洁");
    expect(resolveModuleLink(board, module, [source]).targetWorkflow).toBe(
      board,
    );
    expect(moduleHref(board, module, [source])).toBe(
      `/workflows/board/steps?name=%E6%B8%85%E6%B4%81&detailId=${readWorkflow(board.draft).details[0].id}`,
    );
  });
  it("respects an explicit selection and never falls back when that list is renamed or deleted", () => {
    const board = workflow("board", [detail("清洁")]);
    const chosen = workflow("chosen", [detail("清洁")]);
    const other = workflow("other", [detail("清洁")]);
    const module = { ...newModule("清洁"), detailWorkflowId: chosen.id };
    expect(
      resolveModuleLink(board, module, [other, chosen]).targetWorkflow,
    ).toBe(chosen);
    expect(resolveModuleLink(board, module, [other])).toEqual({
      status: "MISSING",
    });
    expect(
      resolveModuleLink(board, module, [
        other,
        workflow("chosen", [detail("清洁设备")]),
      ]).status,
    ).toBe("MISSING");
    expect(moduleHref(board, module, [other])).toBe(
      `/workflows/board/steps?name=%E6%B8%85%E6%B4%81&module=${encodeURIComponent(module.id)}`,
    );
  });
  it("keeps a selected module-only source as the place to author its missing list", () => {
    const board = workflow("board");
    const source = {
      ...workflow("source"),
      draft: JSON.stringify([newModule("检查设备")]),
    };
    const module = {
      ...newModule("检查设备"),
      detailWorkflowId: source.id,
    };
    const result = resolveModuleLink(board, module, [board, source]);
    expect(result.status).toBe("MISSING");
    expect(result.detail).toBeUndefined();
    expect(result.targetWorkflow).toBe(source);
    const persisted = readWorkflow(
      JSON.stringify(appendModuleEntries(board.draft, module)),
    );
    expect(persisted.modules[0].detailWorkflowId).toBe(source.id);
    expect(persisted.details).toEqual([]);
    const writtenSource = workflow("source", [detail("检查设备")]);
    expect(
      resolveModuleLink(board, persisted.modules[0], [writtenSource]).status,
    ).toBe("MATCHED");
  });
  it("never picks an ambiguous local or cross-workflow list", () => {
    const module = newModule("清洁");
    const source = workflow("source", [detail("清洁")]);
    const other = workflow("other", [detail(" 清洁 ")]);
    const board = workflow("board");
    expect(resolveModuleLink(board, module, [source, other])).toEqual({
      status: "AMBIGUOUS",
    });
    expect(moduleHref(board, module, [source, other])).toBe(
      `/workflows/board/steps?name=%E6%B8%85%E6%B4%81&module=${encodeURIComponent(module.id)}`,
    );
    const localDuplicates = workflow("board", [
      detail("清洁"),
      detail(" 清洁 "),
    ]);
    expect(resolveModuleLink(localDuplicates, module, [source]).status).toBe(
      "AMBIGUOUS",
    );
    expect(
      resolveModuleLink(board, module, [
        workflow("source", [detail("清洁"), detail(" 清洁 ")]),
      ]).status,
    ).toBe("AMBIGUOUS");
    expect(
      resolveModuleLink(board, { ...module, detailWorkflowId: "chosen" }, [
        workflow("chosen", [detail("清洁"), detail(" 清洁 ")]),
      ]).status,
    ).toBe("AMBIGUOUS");
  });
  it("uses exact normalized names and does not link partial or case-insensitive matches", () => {
    const board = workflow("board");
    const source = workflow("source", [detail("Café")]);
    expect(resolveModuleLink(board, newModule("café"), [source]).status).toBe(
      "MISSING",
    );
    expect(resolveModuleLink(board, newModule("Caf"), [source]).status).toBe(
      "MISSING",
    );
  });
});

describe("instruction route intent", () => {
  it("keeps local directory documents distinct from a same-name module's chosen source", () => {
    const module = {
      ...newModule("检查设备"),
      detailWorkflowId: "source",
    };
    const board = {
      ...workflow("board"),
      draft: JSON.stringify([module, detail("检查设备")]),
    };
    const source = workflow("source", [detail("检查设备")]);
    expect(
      resolveInstructionLink(board, "检查设备", [board, source]).targetWorkflow,
    ).toBe(board);
    expect(
      resolveInstructionLink(board, "检查设备", [board, source], module.id)
        .targetWorkflow,
    ).toBe(source);
    expect(moduleHref(board, module, [source])).toBe(
      `/workflows/source/steps?name=%E6%A3%80%E6%9F%A5%E8%AE%BE%E5%A4%87&detailId=${readWorkflow(source.draft).details[0].id}&from=board`,
    );
  });
  it("carries unresolved module identity without replacing a local directory document", () => {
    const module = {
      ...newModule("检查设备"),
      id: "module / 1",
      detailWorkflowId: "source",
    };
    const board = {
      ...workflow("board"),
      draft: JSON.stringify([module, detail("检查设备")]),
    };
    const source = workflow("source");
    expect(moduleHref(board, module, [source])).toBe(
      "/workflows/board/steps?name=%E6%A3%80%E6%9F%A5%E8%AE%BE%E5%A4%87&module=module%20%2F%201",
    );
    const unresolved = resolveInstructionLink(
      board,
      "检查设备",
      [source],
      module.id,
    );
    expect(unresolved.status).toBe("MISSING");
    expect(unresolved.targetWorkflow).toBe(source);
    expect(
      resolveInstructionLink(board, "检查设备", [source]).detail,
    ).toBeDefined();
    expect(
      resolveInstructionLink(board, "检查设备", [source], "unknown")
        .targetWorkflow,
    ).toBe(board);
    expect(
      resolveInstructionLink(board, "另一名称", [source], module.id).status,
    ).toBe("MISSING");
  });
  it("opens a canonical source document without following another same-name module pin", () => {
    const source = {
      ...workflow("source"),
      draft: JSON.stringify([
        { ...newModule("检查设备"), detailWorkflowId: "other" },
        detail("检查设备"),
      ]),
    };
    const other = workflow("other", [detail("检查设备")]);
    expect(
      resolveInstructionLink(source, "检查设备", [source, other])
        .targetWorkflow,
    ).toBe(source);
  });
});

describe("board ordering preserves the stored handbook", () => {
  it("reorders only module slots and keeps separate details and custom data intact", () => {
    const first = {
      kind: "MODULE",
      id: "a",
      title: "A",
      custom: { keep: true },
    };
    const method = { ...detail("A"), imageUrl: "/media/image.png" };
    const last = { kind: "MODULE", id: "b", title: "B" };
    expect(
      reorderModuleEntries(JSON.stringify([first, method, last]), ["b", "a"]),
    ).toEqual([last, method, first]);
  });
  it("retains legacy records including blank text, metadata and generated IDs", () => {
    const old = {
      title: "旧工作",
      description: "",
      videoUrl: "/media/old.mp4",
      custom: [1, 2],
    };
    const other = { id: "old-b", title: "另一项", description: "手写原文" };
    const raw = JSON.stringify([old, other]);
    const ids = readWorkflow(raw).modules.map((module) => module.id);
    const reordered = reorderModuleEntries(raw, [...ids].reverse());
    expect(reordered).toEqual([other, old]);
    expect(readWorkflow(JSON.stringify(reordered)).details[1].videoUrl).toBe(
      old.videoUrl,
    );
  });
  it("rejects missing, repeated and foreign IDs instead of discarding entries", () => {
    const raw = JSON.stringify([
      { kind: "MODULE", id: "a", title: "A" },
      { kind: "MODULE", id: "b", title: "B" },
    ]);
    for (const ids of [["a"], ["a", "a"], ["b", "unknown"]])
      expect(() => reorderModuleEntries(raw, ids)).toThrow("重新打开");
  });
});
describe("module links and independent instruction lists", () => {
  it("resolves only a unique same-name document after NFC and pasted edge-space trimming", () => {
    const target = detail("Café");
    expect(matchDetail("\uFEFF Cafe\u0301\u00a0", [target]).detail).toBe(
      target,
    );
    expect(normalizeName("\u001cname\u001c")).toBe("\u001cname\u001c");
    expect(matchDetail("café", [target]).status).toBe("MISSING");
    expect(matchDetail("Caf", [target]).status).toBe("MISSING");
  });
  it("never chooses the first of ambiguous matches or an unrelated document", () => {
    expect(
      matchDetail("清洁设备", [detail("清洁设备"), detail(" 清洁设备 ")])
        .status,
    ).toBe("AMBIGUOUS");
    expect(matchDetail("备料", [detail("清洁设备")]).detail).toBeUndefined();
  });
  it("preserves legacy instruction text, media and extra metadata when converted and saved", () => {
    const raw = {
      id: "old",
      title: "旧事项",
      description: "1. 保留原文\n2. 不覆盖说明",
      materials: "工具",
      imageUrl: "https://example.com/photo.png",
      custom: { value: 3 },
    };
    const content = readWorkflow(JSON.stringify([raw]));
    expect(content.modules[0].title).toBe("旧事项");
    expect(content.details[0].items[0].text).toBe(raw.description);
    const roundtrip = readWorkflow(JSON.stringify(serializeWorkflow(content)));
    expect(roundtrip.details[0].imageUrl).toBe(raw.imageUrl);
    expect(roundtrip.details[0].custom).toEqual(raw.custom);
    expect(roundtrip.details[0].items).toEqual(content.details[0].items);
  });
  it("keeps each module's own list across persistence and permits authoring missing links later", () => {
    const content = {
      modules: [newModule("清洁"), newModule("备料"), newModule("待编写")],
      details: [
        detail("清洁"),
        { ...detail("备料"), items: [{ id: "other", text: "称量原料" }] },
      ],
    };
    expect(validateContent(content)).toBeNull();
    const stored = readWorkflow(JSON.stringify(serializeWorkflow(content)));
    expect(
      matchDetail("备料", stored.details).detail?.items.map(
        (item) => item.text,
      ),
    ).toEqual(["称量原料"]);
    expect(matchDetail("待编写", stored.details).status).toBe("MISSING");
  });
  it("rejects duplicate names and blank list entries while allowing details written before modules", () => {
    expect(
      validateContent({
        modules: [newModule("A"), newModule(" A ")],
        details: [],
      }),
    ).toContain("请换个名称");
    expect(
      validateContent({ modules: [], details: [detail("A"), detail(" A ")] }),
    ).toContain("请换个名称");
    expect(
      validateContent({ modules: [], details: [newDetail("A")] }),
    ).toContain("内容");
    expect(validateContent({ modules: [], details: [detail("A")] })).toBeNull();
  });
});
