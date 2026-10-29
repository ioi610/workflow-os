import { describe, expect, it } from "vitest";
import type {
  Workflow,
  WorkflowDetailDocument,
  WorkflowModule,
} from "../../types";
import { connectProcedure } from "./connectedProcedure";
import { generateWorkflow, type GeneratedWorkflow } from "./generatedWorkflow";

const module = (id: string, nextModuleIds: string[] = []): WorkflowModule => ({
  kind: "MODULE",
  id,
  title: id,
  nextModuleIds,
});
const detail = (
  title: string,
  texts: string[] = [`做 ${title}`],
): WorkflowDetailDocument => ({
  kind: "DETAIL",
  id: `detail-${title}`,
  title,
  items: texts.map((text, index) => ({ id: `item-${index}`, text })),
});
function generate(
  modules: WorkflowModule[],
  documents = modules.map((entry) => detail(entry.title)),
): GeneratedWorkflow {
  const workflow: Workflow = {
    id: "current",
    title: "我的流程",
    category: "",
    revision: 1,
    draft: JSON.stringify([...modules, ...documents]),
  };
  return generateWorkflow(workflow, []);
}
const connections = (result: ReturnType<typeof connectProcedure>) =>
  result.connections.map((edge) => {
    const from = result.steps.find((step) => step.id === edge.sourceId)!,
      to = result.steps.find((step) => step.id === edge.targetId)!;
    return `${edge.kind}:${from.moduleId}[${from.itemIndex}]->${to.moduleId}[${to.itemIndex}]`;
  });

describe("connected read-only procedure", () => {
  it("numbers every original instruction occurrence without rewriting text or deduplicating shared documents and item IDs", () => {
    const instructions = detail("共享做法", [
      "  保持原有空格\n和换行  ",
      "下一步",
    ]);
    instructions.items[1].id = instructions.items[0].id;
    instructions.materials = "准备两张抹布";
    instructions.safetyNotice = "先断电";
    const generated = generate(
      [
        { ...module("第一次"), detailName: "共享做法" },
        { ...module("第二次"), detailName: "共享做法" },
      ],
      [instructions],
    );
    const before = JSON.stringify(generated);
    const result = connectProcedure(generated);
    expect(result.steps.map((step) => step.text)).toEqual([
      instructions.items[0].text,
      "下一步",
      instructions.items[0].text,
      "下一步",
    ]);
    expect(result.steps.map((step) => step.ordinal)).toEqual([1, 2, 3, 4]);
    expect(result.steps.map((step) => [step.moduleId, step.itemIndex])).toEqual(
      [
        ["第一次", 0],
        ["第一次", 1],
        ["第二次", 0],
        ["第二次", 1],
      ],
    );
    expect(new Set(result.steps.map((step) => step.id)).size).toBe(4);
    expect(
      result.entryRanges.map((range) => [range.startOrdinal, range.endOrdinal]),
    ).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(connections(result)).toEqual([
      "internal:第一次[0]->第一次[1]",
      "internal:第二次[0]->第二次[1]",
      "sequence:第一次[1]->第二次[0]",
    ]);
    expect(JSON.stringify(generated)).toBe(before);
  });

  it("keeps incomplete blank rows and one placeholder for each missing, ambiguous, unavailable, or empty document", () => {
    const generated = generate(
      [
        module("missing"),
        module("ambiguous"),
        module("source-missing"),
        module("empty"),
        module("partial"),
      ],
      [detail("empty", []), detail("partial", ["已写步骤", " \n "])],
    );
    const ambiguous = generated.entries.find(
      (entry) => entry.id === "ambiguous",
    )!;
    ambiguous.status = "AMBIGUOUS";
    const unavailable = generated.entries.find(
      (entry) => entry.id === "source-missing",
    )!;
    unavailable.sourceMissing = true;
    const result = connectProcedure(generated);
    expect(result.steps.map((step) => step.placeholderReason)).toEqual([
      "missing",
      "ambiguous",
      "source-missing",
      "empty-document",
      undefined,
      "blank-step",
    ]);
    expect(result.steps.at(-1)?.text).toBe(" \n ");
    expect(result.steps.filter((step) => step.itemIndex === null)).toHaveLength(
      4,
    );
    expect(result.entryRanges).toHaveLength(5);
    expect(
      result.connections.filter((edge) => edge.kind === "sequence"),
    ).toHaveLength(4);
  });

  it("connects exact branch and merge endpoints while keeping unrelated work disconnected", () => {
    const generated = generate(
      [
        module("a", ["b", "c"]),
        module("b", ["d"]),
        module("c", ["d"]),
        module("d"),
        module("alone"),
      ],
      [
        detail("a", ["a1", "a2"]),
        detail("b"),
        detail("c"),
        detail("d", ["d1", "d2"]),
        detail("alone"),
      ],
    );
    const result = connectProcedure(generated);
    expect(connections(result).sort()).toEqual([
      "dependency:a[1]->b[0]",
      "dependency:a[1]->c[0]",
      "dependency:b[0]->d[0]",
      "dependency:c[0]->d[0]",
      "internal:a[0]->a[1]",
      "internal:d[0]->d[1]",
    ]);
    expect(result.suggestedSequence).toBe(false);
    expect(result.steps.some((step) => step.moduleId === "alone")).toBe(true);
  });

  it("retains loops and self loops once, with no invented repetition count or reading-sequence edges", () => {
    const generated = generate([
      module("a", ["b"]),
      module("b", ["a", "after"]),
      module("after"),
      module("self", ["self"]),
    ]);
    const result = connectProcedure(generated, ["b", "a", "self", "after"]);
    expect(result.steps).toHaveLength(4);
    expect(connections(result).sort()).toEqual([
      "dependency:a[0]->b[0]",
      "dependency:b[0]->a[0]",
      "dependency:b[0]->after[0]",
      "dependency:self[0]->self[0]",
    ]);
    expect(new Set(result.stages.flatMap((stage) => stage.cycleIds)).size).toBe(
      2,
    );
    expect(() =>
      connectProcedure(generated, ["b", "after", "a", "self"]),
    ).toThrow("箭头");
  });

  it("allows a valid topological display order across original groups without adding dependencies", () => {
    const generated = generate([
      module("a", ["b"]),
      module("alone"),
      module("b", ["c"]),
      module("c"),
    ]);
    const result = connectProcedure(generated, ["a", "b", "alone", "c"]);
    expect(result.entryOrder).toEqual(["a", "b", "alone", "c"]);
    expect(result.stages.flatMap((stage) => stage.entryIds)).toEqual(
      result.entryOrder,
    );
    expect(result.stages.map((stage) => stage.sourceGroupId)).toEqual(
      result.entryOrder.map(
        (id) =>
          generated.groups.find((group) => group.entryIds.includes(id))!.id,
      ),
    );
    expect(new Set(result.stages.map((stage) => stage.id)).size).toBe(
      result.stages.length,
    );
    expect(connections(result)).toEqual([
      "dependency:a[0]->b[0]",
      "dependency:b[0]->c[0]",
    ]);
    expect(() => connectProcedure(generated, ["c", "a", "b", "alone"])).toThrow(
      "箭头",
    );
    expect(() => connectProcedure(generated, ["a", "c", "b", "alone"])).toThrow(
      "箭头",
    );
  });

  it("marks timeline links as reading suggestions and permits only changes within the same scheduled minute", () => {
    const generated = generate([module("a"), module("b"), module("next-day")]);
    generated.mode = "timeline";
    generated.entries.forEach((entry, index) => {
      entry.minute = index < 2 ? 1430 : 1440;
      entry.time = index < 2 ? "23:50" : "次日 00:00";
    });
    generated.groups = [
      {
        id: "time-1430",
        label: "23:50",
        kind: "timeline",
        entryIds: ["a", "b"],
        cycleIds: [],
      },
      {
        id: "time-1440",
        label: "次日 00:00",
        kind: "timeline",
        entryIds: ["next-day"],
        cycleIds: [],
      },
    ];
    const result = connectProcedure(generated, ["b", "a", "next-day"]);
    expect(result.entryOrder).toEqual(["b", "a", "next-day"]);
    expect(
      result.stages.map((stage) => [
        stage.label,
        stage.sameTime,
        stage.requiresOrder,
      ]),
    ).toEqual([
      ["23:50", true, true],
      ["次日 00:00", false, false],
    ]);
    expect(connections(result)).toEqual([
      "sequence:b[0]->a[0]",
      "sequence:a[0]->next-day[0]",
    ]);
    expect(result.suggestedSequence).toBe(true);
    expect(
      result.warnings.some((warning) => warning.includes("阅读建议")),
    ).toBe(true);
    expect(() => connectProcedure(generated, ["a", "next-day", "b"])).toThrow(
      "时间顺序",
    );
  });

  it("allows free source reading order but rejects incomplete, duplicate, and unknown IDs without mutation", () => {
    const generated = generate([module("a"), module("b"), module("c")]);
    const before = JSON.stringify(generated);
    expect(
      connectProcedure(generated, ["c", "b", "a"]).steps.map(
        (step) => step.moduleId,
      ),
    ).toEqual(["c", "b", "a"]);
    for (const order of [
      ["a", "b"],
      ["a", "b", "b"],
      ["a", "b", "unknown"],
    ])
      expect(() => connectProcedure(generated, order)).toThrow(
        "工作内容已经变化",
      );
    expect(JSON.stringify(generated)).toBe(before);
  });

  it("does not invent an instruction for an empty framework", () => {
    const result = connectProcedure(generate([]));
    expect(result.steps).toEqual([]);
    expect(result.connections).toEqual([]);
    expect(result.stages).toEqual([]);
    expect(result.entryRanges).toEqual([]);
    expect(result.suggestedSequence).toBe(false);
  });
});
