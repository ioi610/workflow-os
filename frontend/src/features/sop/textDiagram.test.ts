import { describe, expect, it } from "vitest";
import type { ModuleFrame, Workflow } from "../../types";
import { boardSize, readBoardAxes, validateBoardAxes } from "./boardAxes";
import { canvasArrows, moduleFrame } from "./canvas";
import {
  createTextDiagramDraft,
  type TextDiagram,
  type TextDiagramNode,
} from "./textDiagram";
import { readWorkflow, resolveModuleLink, validateContent } from "./workflows";

const node = (
  id: string,
  nextIds: string[] = [],
  details: string[] = [`${id}的具体做法。`],
): TextDiagramNode => ({ id, name: `工作${id}`, details, nextIds });
const diagram = (nodes: TextDiagramNode[]): TextDiagram => ({
  title: "原文流程名称",
  nodes,
});
function draftContent(value: TextDiagram) {
  const draft = createTextDiagramDraft(value);
  return { ...draft, ...readWorkflow(JSON.stringify(draft.steps)) };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
const overlaps = (a: ModuleFrame, b: ModuleFrame) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;
function expectValidGeometry(value: TextDiagram) {
  const result = draftContent(value),
    axes = readBoardAxes(result.boardSettings),
    board = boardSize(axes),
    frames = result.modules.map((module, index) =>
      moduleFrame(module, index, board),
    );
  expect(validateBoardAxes(axes)).toBeNull();
  expect(axes.timeline.enabled).toBe(false);
  expect(axes.priority.enabled).toBe(false);
  expect(result.modules).toHaveLength(value.nodes.length);
  expect(result.details).toHaveLength(value.nodes.length);
  expect(validateContent(result)).toBeNull();
  for (const edge of [board.width, board.height]) {
    expect(edge).toBeGreaterThanOrEqual(320);
    expect(edge).toBeLessThanOrEqual(2400);
    expect(Number.isInteger(edge)).toBe(true);
  }
  frames.forEach((frame, index) => {
    expect(frame.x).toBeGreaterThanOrEqual(0);
    expect(frame.y).toBeGreaterThanOrEqual(0);
    expect(frame.width).toBeGreaterThanOrEqual(32);
    expect(frame.height).toBeGreaterThanOrEqual(32);
    expect(frame.x + frame.width).toBeLessThanOrEqual(board.width);
    expect(frame.y + frame.height).toBeLessThanOrEqual(board.height);
    frames.slice(index + 1).forEach((other) => {
      expect(overlaps(frame, other)).toBe(false);
    });
  });
  const byName = new Map(
    result.modules.map((module) => [module.title, module]),
  );
  expect(
    canvasArrows(result.modules).map((edge) => [edge.sourceId, edge.targetId]),
  ).toEqual(
    value.nodes.flatMap((source) =>
      source.nextIds.map((id) => [
        byName.get(source.name)!.id,
        byName.get(value.nodes.find((candidate) => candidate.id === id)!.name)!
          .id,
      ]),
    ),
  );
  return { ...result, frames, board };
}

describe("text diagram draft conversion", () => {
  it("lays out a fork and a join by dependency rather than response order, retaining all arrows and ports", () => {
    const value = diagram([
      node("join"),
      node("branch-two", ["join"]),
      node("start", ["branch-one", "branch-two"]),
      node("branch-one", ["join"]),
    ]);
    const result = expectValidGeometry(value),
      byName = new Map(result.modules.map((module) => [module.title, module]));
    const start = byName.get("工作start")!,
      branchOne = byName.get("工作branch-one")!,
      branchTwo = byName.get("工作branch-two")!,
      join = byName.get("工作join")!;
    expect(start.frame!.x).toBeLessThan(branchOne.frame!.x);
    expect(branchOne.frame!.x).toBe(branchTwo.frame!.x);
    expect(branchOne.frame!.y).not.toBe(branchTwo.frame!.y);
    expect(join.frame!.x).toBeGreaterThan(branchOne.frame!.x);
    expect(result.modules.map((module) => module.title)).toEqual(
      value.nodes.map((entry) => entry.name),
    );
    for (const arrow of canvasArrows(result.modules))
      expect(arrow.ports).toEqual({ source: "right", target: "left" });
  });

  it("keeps cycle members together, puts their downstream work later and retains independent work", () => {
    const result = expectValidGeometry(
      diagram([
        node("after"),
        node("cycle-b", ["cycle-a", "after"]),
        node("unconnected"),
        node("before", ["cycle-a"]),
        node("cycle-a", ["cycle-b"]),
      ]),
    );
    const byName = new Map(
        result.modules.map((module) => [module.title, module]),
      ),
      a = byName.get("工作cycle-a")!,
      b = byName.get("工作cycle-b")!,
      before = byName.get("工作before")!,
      after = byName.get("工作after")!;
    expect(a.frame!.x).toBe(b.frame!.x);
    expect(a.frame!.y).not.toBe(b.frame!.y);
    expect(before.frame!.x).toBeLessThan(a.frame!.x);
    expect(after.frame!.x).toBeGreaterThan(a.frame!.x);
    expect(a.connectionPorts![b.id]).toEqual({
      source: "top",
      target: "bottom",
    });
    expect(b.connectionPorts![a.id]).toEqual({
      source: "bottom",
      target: "top",
    });
    expect(byName.get("工作unconnected")!.nextModuleIds).toEqual([]);
  });

  it("creates fresh UUIDs for every module, detail and item with stable local bindings and no reused source records", () => {
    const value = diagram([node("first", ["empty"]), node("empty", [], [])]),
      first = draftContent(value),
      second = draftContent(value),
      allIds = (result: ReturnType<typeof draftContent>) =>
        result.steps.flatMap((entry) => [
          entry.id!,
          ...(entry.kind === "DETAIL"
            ? result.details
                .find((detail) => detail.id === entry.id)!
                .items.map((item) => item.id)
            : []),
        ]),
      firstIds = allIds(first),
      secondIds = allIds(second);
    expect(new Set(firstIds).size).toBe(firstIds.length);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
    for (const id of [...firstIds, ...secondIds])
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    const workflow: Workflow = {
      id: "a-new-workflow",
      title: first.title,
      category: "",
      revision: 1,
      draft: JSON.stringify(first.steps),
      boardSettings: first.boardSettings,
    };
    const existing: Workflow = {
      ...workflow,
      id: "existing-workflow",
      draft: JSON.stringify([
        {
          kind: "DETAIL",
          id: "previous-detail",
          title: value.nodes[0].name,
          items: [{ id: "previous-item", text: "不该被复用的旧做法" }],
        },
      ]),
    };
    for (const module of first.modules) {
      expect(module.detailWorkflowId).toBeUndefined();
      const resolved = resolveModuleLink(workflow, module, [existing]);
      expect(resolved.status).toBe("MATCHED");
      expect(resolved.targetWorkflow!.id).toBe(workflow.id);
      expect(resolved.detail!.id).toBe(module.detailId);
      expect(resolved.detail!.title).toBe(module.title);
    }
    expect(first.details[1]).toMatchObject({ items: [], legacyEmpty: true });
    expect(validateContent(first)).toBeNull();
  });

  it("preserves names, long text, line breaks, clock text and source data exactly, with time and priority axes off", () => {
    const value = freeze({
      title: "  我自己的完整流程🌱  ",
      nodes: [
        {
          id: "source",
          name:
            "  09:00 " + "这是一份不会被截掉的很长工作名称".repeat(30) + "  ",
          details: [
            "  09:00 开始准备。\n第二行需要留着，不能改写。  ",
            "\t保留标点、<标签> 与 emoji 🍲。",
          ],
          nextIds: [],
        },
      ],
    });
    const snapshot = JSON.stringify(value),
      result = expectValidGeometry(value);
    expect(result.title).toBe(value.title);
    expect(result.modules[0].title).toBe(value.nodes[0].name);
    expect(result.details[0].title).toBe(value.nodes[0].name);
    expect(result.details[0].items.map((item) => item.text)).toEqual(
      value.nodes[0].details,
    );
    expect(JSON.stringify(value)).toBe(snapshot);
    expect(result.modules[0]).not.toHaveProperty("minute");
  });

  it("wraps a long dependency chain into readable bands and uses vertical ports at the wrap", () => {
    const value = diagram(
      Array.from({ length: 60 }, (_, index) =>
        node(`n${index}`, index === 59 ? [] : [`n${index + 1}`]),
      ),
    );
    const result = expectValidGeometry(value);
    expect(result.modules[8].frame!.x).toBeGreaterThan(
      result.modules[9].frame!.x,
    );
    expect(result.modules[8].frame!.y).toBeLessThan(result.modules[9].frame!.y);
    expect(result.modules[8].connectionPorts![result.modules[9].id]).toEqual({
      source: "bottom",
      target: "top",
    });
    expect(result.modules[0].frame!.width).toBe(200);
  });

  it.each([
    [
      "sixty independent nodes",
      Array.from({ length: 60 }, (_, i) => node(`n${i}`)),
    ],
    [
      "wide fork and join",
      [
        node(
          "start",
          Array.from({ length: 58 }, (_, i) => `n${i}`),
        ),
        ...Array.from({ length: 58 }, (_, i) => node(`n${i}`, ["join"])),
        node("join"),
      ],
    ],
    [
      "sixty cycle members",
      Array.from({ length: 60 }, (_, i) => node(`n${i}`, [`n${(i + 1) % 60}`])),
    ],
  ])("fits %s without overlap or lost content", (_label, nodes) => {
    expectValidGeometry(diagram(nodes));
  });

  it("shrinks a dense multilevel graph uniformly to fit instead of dropping nodes or overlapping boxes", () => {
    const nodes: TextDiagramNode[] = [];
    let previous: string[] = [];
    for (let rank = 0; rank < 40; rank++) {
      const group = Array.from(
        { length: rank < 36 && rank % 9 === 0 ? 6 : 1 },
        (_, i) => node(`r${rank}-${i}`),
      );
      for (const predecessor of nodes.filter((entry) =>
        previous.includes(entry.id),
      ))
        predecessor.nextIds = group.map((entry) => entry.id);
      nodes.push(...group);
      previous = group.map((entry) => entry.id);
    }
    expect(nodes).toHaveLength(60);
    const result = expectValidGeometry(diagram(nodes));
    expect(result.modules[0].frame!.width).toBeLessThan(200);
    expect(result.board.height).toBe(2400);
  });

  it.each([
    null,
    {},
    { title: "", nodes: [node("a")] },
    diagram([]),
    diagram(Array.from({ length: 61 }, (_, i) => node(`n${i}`))),
    diagram([node("a"), node("a")]),
    diagram([node("a"), { ...node("b"), name: " 工作a " }]),
    diagram([node("a", ["missing"])]),
    diagram([node("a", ["a"])]),
    diagram([node("a", ["b", "b"]), node("b")]),
    diagram([{ ...node("a"), name: "   " }]),
    diagram([{ ...node("a"), details: [" \n "] }]),
    diagram([
      { ...node("a"), details: Array.from({ length: 101 }, () => "原文") },
    ]),
    { title: "流程", nodes: [{ ...node("a"), details: "不是数组" }] },
    { title: "流程", nodes: [{ ...node("a"), details: [null] }] },
    { title: "流程", nodes: [{ ...node("a"), nextIds: null }] },
    { title: "流程", nodes: [{ ...node("a"), nextIds: [123] }] },
    { title: "流程", nodes: [null] },
    { title: "流程", nodes: new Array(2) },
  ])(
    "rejects malformed or incomplete data without a partial conversion: %j",
    (value) => {
      expect(() => createTextDiagramDraft(value as TextDiagram)).toThrow();
    },
  );

  it("rejects duplicate names after Unicode normalization without changing valid names", () => {
    expect(() =>
      createTextDiagramDraft(
        diagram([
          { ...node("a"), name: "café" },
          { ...node("b"), name: "cafe\u0301" },
        ]),
      ),
    ).toThrow("重复");
  });
});
