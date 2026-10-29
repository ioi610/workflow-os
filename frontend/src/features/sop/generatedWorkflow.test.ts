import { describe, expect, it } from "vitest";
import type { Workflow, WorkflowModule, WorkflowStep } from "../../types";
import {
  DEFAULT_BOARD_AXES,
  serializeBoardAxes,
  timelinePosition,
  type BoardAxesSettings,
} from "./boardAxes";
import { generateWorkflow } from "./generatedWorkflow";
import { connectProcedure } from "./connectedProcedure";
import { completeWorkflowText } from "./completeWorkflowText";

const module = (
  id: string,
  title = id,
  nextModuleIds?: string[],
): WorkflowModule => ({
  kind: "MODULE",
  id,
  title,
  ...(nextModuleIds ? { nextModuleIds } : {}),
});
const detail = (id: string, title = id, text = `手写 ${id}`): WorkflowStep => ({
  kind: "DETAIL",
  id: `detail-${id}`,
  title,
  items: [{ id: `item-${id}`, text }],
});
function workflow(
  steps: WorkflowStep[],
  settings?: BoardAxesSettings,
  id = "current",
): Workflow {
  return {
    id,
    title: "我的流程",
    category: "日常",
    revision: 4,
    draft: JSON.stringify(steps),
    boardSettings: settings ? serializeBoardAxes(settings) : null,
  };
}
const sortedEdges = (result: ReturnType<typeof generateWorkflow>) =>
  result.edges.map((edge) => `${edge.sourceId}->${edge.targetId}`).sort();
const schedulingAxes: BoardAxesSettings = {
  ...DEFAULT_BOARD_AXES,
  timeline: { enabled: true, startMinute: 540, endMinute: 1080, axis: "x" },
  canvas: { width: 1000, height: 1000 },
};
function scheduledWorkflow(
  schedule: { id: string; minute: number; next?: string[]; title?: string }[],
  settings = schedulingAxes,
) {
  const width = settings.canvas!.width;
  return workflow(
    [
      ...schedule.map((entry) => ({
        ...module(entry.id, entry.title || entry.id, entry.next),
        frame: {
          x:
            timelinePosition(
              entry.minute - settings.timeline.startMinute,
              settings,
            ) *
            (width - 100),
          y: 0,
          width: 100,
          height: 100,
        },
      })),
      ...schedule.map((entry) =>
        detail(
          entry.id,
          entry.title || entry.id,
          `手写${entry.title || entry.id}。`,
        ),
      ),
    ],
    settings,
  );
}

describe("read-only complete workflow generation", () => {
  it("groups real scheduled minutes despite stretched time segments, different module sizes, and horizontal priorities", () => {
    const settings: BoardAxesSettings = {
      ...DEFAULT_BOARD_AXES,
      timeline: {
        enabled: true,
        startMinute: 600,
        endMinute: 1320,
        axis: "y",
        segments: [{ startOffset: 0, endOffset: 60, scale: 4 }],
      },
      priority: { enabled: true, axis: "x" },
      canvas: { width: 1000, height: 1000 },
    };
    const at = (
      id: string,
      minute: number,
      height: number,
      priority: number,
    ): WorkflowModule => ({
      ...module(id),
      frame: {
        x: priority * 900,
        y: timelinePosition(minute - 600, settings) * (1000 - height),
        width: 100,
        height,
      },
    });
    const late = at("late", 720, 800, 0),
      firstLow = at("first-low", 660, 100, 0.9),
      secondHigh = at("second-high", 660, 100, 0);
    expect(late.frame!.y).toBeLessThan(firstLow.frame!.y);
    const record = workflow(
      [
        late,
        firstLow,
        secondHigh,
        detail("late"),
        detail("first-low"),
        detail("second-high"),
      ],
      settings,
    );
    const before = JSON.stringify(record);
    const result = generateWorkflow(record, [record]);
    expect(result.mode).toBe("timeline");
    expect(result.groups.map((group) => [group.label, group.entryIds])).toEqual(
      [
        ["11:00", ["first-low", "second-high"]],
        ["12:00", ["late"]],
      ],
    );
    expect(result.entries.map((entry) => entry.minute)).toEqual([
      660, 660, 720,
    ]);
    expect(result.entries.map((entry) => entry.priority)).toEqual([
      "可以稍后",
      "优先做",
      "优先做",
    ]);
    expect(result.edges).toEqual([]);
    expect(
      result.warnings.some((warning) => warning.includes("组内尚未指定先后")),
    ).toBe(true);
    expect(JSON.stringify(record)).toBe(before);
  });

  it("keeps overnight minutes chronological and matches the visible half-minute rounding", () => {
    const settings: BoardAxesSettings = {
      ...DEFAULT_BOARD_AXES,
      timeline: { enabled: true, startMinute: 1380, endMinute: 60, axis: "x" },
      canvas: { width: 820, height: 820 },
    };
    const at = (id: string, offset: number): WorkflowModule => ({
      ...module(id),
      frame: { x: (offset / 120) * (820 - 32), y: 0, width: 32, height: 32 },
    });
    const record = workflow(
      [
        at("next-day", 90),
        at("round-up", 59.5),
        at("same-minute", 60.1),
        at("earlier", 30),
        detail("next-day"),
        detail("round-up"),
        detail("same-minute"),
        detail("earlier"),
      ],
      settings,
    );
    const result = generateWorkflow(record, []);
    expect(result.groups.map((group) => [group.label, group.entryIds])).toEqual(
      [
        ["23:30", ["earlier"]],
        ["次日 00:00", ["round-up", "same-minute"]],
        ["次日 00:30", ["next-day"]],
      ],
    );
    expect(result.entries.map((entry) => entry.minute)).toEqual([
      1410, 1440, 1440, 1470,
    ]);
  });

  it("considers an early newly available successor before an unrelated late work in the generated prose", () => {
    const record = scheduledWorkflow([
      { id: "late", title: "晚间整理", minute: 1020 },
      { id: "check", title: "早间检查", minute: 545 },
      { id: "prepare", title: "早间准备", minute: 540, next: ["check"] },
    ]);
    const before = JSON.stringify(record);
    const result = generateWorkflow(record, []);
    expect(result.mode).toBe("arrows");
    expect(result.entries.map((entry) => [entry.id, entry.time])).toEqual([
      ["prepare", "09:00"],
      ["check", "09:05"],
      ["late", "17:00"],
    ]);
    expect(sortedEdges(result)).toEqual(["prepare->check"]);
    const procedure = connectProcedure(result);
    expect(procedure.entryOrder).toEqual(["prepare", "check", "late"]);
    expect(
      procedure.connections.filter((edge) => edge.kind === "dependency"),
    ).toHaveLength(1);
    expect(procedure.connections.some((edge) => edge.kind === "sequence")).toBe(
      false,
    );
    expect(completeWorkflowText(record, result, procedure)).toBe(
      "09:00 早间准备：手写早间准备。09:05 早间检查：手写早间检查。17:00 晚间整理：手写晚间整理。",
    );
    expect(JSON.stringify(record)).toBe(before);
  });

  it("immediately considers branch successors but waits for every incoming dependency before releasing a merge", () => {
    const record = scheduledWorkflow([
      { id: "late", minute: 1020 },
      { id: "merge", minute: 555 },
      { id: "right", minute: 550, next: ["merge"] },
      { id: "start", minute: 540, next: ["left", "right"] },
      { id: "left", minute: 545, next: ["merge"] },
    ]);
    const result = generateWorkflow(record, []);
    expect(result.entries.map((entry) => entry.id)).toEqual([
      "start",
      "left",
      "right",
      "merge",
      "late",
    ]);
    expect(sortedEdges(result)).toEqual([
      "left->merge",
      "right->merge",
      "start->left",
      "start->right",
    ]);
    expect(
      result.entries
        .find((entry) => entry.id === "merge")
        ?.from.slice()
        .sort(),
    ).toEqual(["left", "right"]);
    expect(
      connectProcedure(result).connections.filter(
        (edge) => edge.kind === "dependency",
      ),
    ).toHaveLength(4);
  });

  it("selects a ready cycle by its earliest actual minute, keeps its members together and then releases its exit", () => {
    const record = scheduledWorkflow(
      [
        { id: "late", minute: 1020 },
        { id: "exit", minute: 550 },
        { id: "cycle-b", minute: 545, next: ["cycle-a", "exit"] },
        { id: "cycle-a", minute: 540, next: ["cycle-b"] },
        { id: "before", minute: 535 },
      ],
      {
        ...schedulingAxes,
        timeline: { ...schedulingAxes.timeline, startMinute: 480 },
      },
    );
    const result = generateWorkflow(record, []);
    expect(result.entries.map((entry) => entry.id)).toEqual([
      "before",
      "cycle-a",
      "cycle-b",
      "exit",
      "late",
    ]);
    expect(result.cycles).toHaveLength(1);
    expect(
      result.groups.find((group) => group.entryIds.includes("cycle-a"))
        ?.entryIds,
    ).toEqual(["cycle-a", "cycle-b"]);
    expect(sortedEdges(result)).toEqual([
      "cycle-a->cycle-b",
      "cycle-b->cycle-a",
      "cycle-b->exit",
    ]);
    expect(
      connectProcedure(result, ["before", "cycle-b", "cycle-a", "exit", "late"])
        .entryOrder,
    ).toEqual(["before", "cycle-b", "cycle-a", "exit", "late"]);
  });

  it("uses actual overnight minutes for ready work and retains valid manual order changes within the same minute", () => {
    const record = scheduledWorkflow(
      [
        { id: "late", minute: 1500 },
        { id: "same-minute", minute: 1441 },
        { id: "after-midnight", minute: 1441 },
        { id: "before-midnight", minute: 1439, next: ["after-midnight"] },
      ],
      {
        ...schedulingAxes,
        timeline: {
          enabled: true,
          startMinute: 1380,
          endMinute: 120,
          axis: "x",
        },
      },
    );
    const result = generateWorkflow(record, []);
    expect(result.entries.map((entry) => [entry.id, entry.time])).toEqual([
      ["before-midnight", "23:59"],
      ["same-minute", "次日 00:01"],
      ["after-midnight", "次日 00:01"],
      ["late", "次日 01:00"],
    ]);
    const order = ["before-midnight", "after-midnight", "same-minute", "late"];
    expect(connectProcedure(result, order).entryOrder).toEqual(order);
    expect(sortedEdges(result)).toEqual(["before-midnight->after-midnight"]);
  });

  it("preserves explicit branch and merge dependencies while retaining isolated work without inventing edges", () => {
    const record = workflow([
      module("d"),
      module("b", "乙", ["d"]),
      module("a", "甲", ["b", "c"]),
      module("c", "丙", ["d"]),
      module("isolated"),
      detail("a", "甲"),
      detail("b", "乙"),
      detail("c", "丙"),
      detail("d"),
      detail("isolated"),
    ]);
    const before = structuredClone(record);
    const result = generateWorkflow(record, []);
    expect(result.mode).toBe("arrows");
    expect(result.groups.map((group) => group.entryIds)).toEqual([
      ["a"],
      ["b"],
      ["c"],
      ["d"],
      ["isolated"],
    ]);
    expect(sortedEdges(result)).toEqual(["a->b", "a->c", "b->d", "c->d"]);
    expect(result.entries.find((entry) => entry.id === "d")?.from).toEqual([
      "b",
      "c",
    ]);
    expect(result.entries.find((entry) => entry.id === "a")?.to).toEqual([
      "b",
      "c",
    ]);
    expect(
      result.entries.find((entry) => entry.id === "isolated")?.isolated,
    ).toBe(true);
    expect(result.entries.map((entry) => entry.id)).toHaveLength(5);
    expect(
      result.warnings.some((warning) => warning.includes("部分工作没有连线")),
    ).toBe(true);
    expect(
      result.warnings.some((warning) => warning.includes("分支条件")),
    ).toBe(true);
    expect(record).toEqual(before);
  });

  it("keeps cycles and their exits without pretending the loop has a finite internal order", () => {
    const record = workflow([
      module("tail"),
      module("b", "乙", ["a", "tail"]),
      module("a", "甲", ["b"]),
      module("self", "重复", ["self"]),
      module("isolated"),
    ]);
    const result = generateWorkflow(record, []);
    expect(
      result.cycles.map((cycle) => [...cycle.entryIds].sort()).sort(),
    ).toEqual([["a", "b"], ["self"]]);
    expect(sortedEdges(result)).toEqual([
      "a->b",
      "b->a",
      "b->tail",
      "self->self",
    ]);
    expect(result.groups[0].entryIds).toContain("a");
    expect(result.groups[0].entryIds).toContain("b");
    const orderedIds = result.entries.map((entry) => entry.id);
    expect(orderedIds.indexOf("tail")).toBeGreaterThan(orderedIds.indexOf("a"));
    expect(orderedIds.indexOf("tail")).toBeGreaterThan(orderedIds.indexOf("b"));
    expect(
      result.groups.find((group) => group.entryIds.includes("tail"))?.entryIds,
    ).toEqual(["tail"]);
    expect(new Set(result.entries.map((entry) => entry.id)).size).toBe(5);
    expect(result.entries.find((entry) => entry.id === "a")?.cycleId).toBe(
      result.entries.find((entry) => entry.id === "b")?.cycleId,
    );
    expect(
      result.warnings.some((warning) => warning.includes("重复次数和退出条件")),
    ).toBe(true);
  });

  it("uses arrows before conflicting clock positions and deduplicates only duplicate edges", () => {
    const settings: BoardAxesSettings = {
      ...DEFAULT_BOARD_AXES,
      timeline: { enabled: true, startMinute: 600, endMinute: 720, axis: "x" },
    };
    const record = workflow(
      [
        { ...module("last"), position: { x: 0, y: 0 } },
        {
          ...module("first", "先做", ["middle", "middle", "deleted"]),
          position: { x: 0.8, y: 0 },
        },
        { ...module("middle", "中间", ["last"]), position: { x: 0.4, y: 0 } },
      ],
      settings,
    );
    const result = generateWorkflow(record, []);
    expect(result.entries.map((entry) => entry.id)).toEqual([
      "first",
      "middle",
      "last",
    ]);
    expect(sortedEdges(result)).toEqual(["first->middle", "middle->last"]);
    expect(
      result.warnings.some((warning) => warning.includes("1 条连线")),
    ).toBe(true);
    expect(result.warnings).toContain(
      "部分箭头的先后与安排时间不一致，汇总以箭头为准，时间仍按框架显示。",
    );
  });

  it("does not repeat time-conflict warnings for edges inside the same cycle", () => {
    const settings: BoardAxesSettings = {
      ...DEFAULT_BOARD_AXES,
      timeline: { enabled: true, startMinute: 600, endMinute: 720, axis: "x" },
    };
    const record = workflow(
      [
        {
          ...module("later", "晚一点", ["earlier"]),
          position: { x: 0.8, y: 0 },
        },
        { ...module("earlier", "早一点", ["later"]), position: { x: 0, y: 0 } },
      ],
      settings,
    );
    const result = generateWorkflow(record, []);
    expect(result.cycles).toHaveLength(1);
    expect(result.warnings.some((warning) => warning.includes("回路"))).toBe(
      true,
    );
    expect(
      result.warnings.some((warning) =>
        warning.includes("先后与安排时间不一致"),
      ),
    ).toBe(false);
  });

  it("retains alias and pinned sources and repeats shared instructions for each separate module occurrence", () => {
    const shared = workflow(
      [
        {
          ...detail("shared", "原做法"),
          materials: "准备原料",
          safetyNotice: "小心",
          imageUrl: "/image.png",
          videoUrl: "https://example.com/video",
          custom: "keep",
        },
        detail("external-only", "只在外部"),
      ],
      undefined,
      "external",
    );
    const record = workflow([
      {
        ...module("one", "新工作名"),
        detailName: " 原做法 ",
        detailWorkflowId: "external",
      },
      {
        ...module("two", "另一次工作"),
        detailName: "原做法",
        detailWorkflowId: "external",
      },
      module("implicit", "只在外部"),
      detail("wrong-local", "新工作名", "不应偷换到这份"),
    ]);
    const oldCurrent = workflow([detail("old", "原做法", "陈旧内容")]);
    const before = JSON.stringify([record, shared, oldCurrent]);
    const result = generateWorkflow(record, [oldCurrent, shared]);
    expect(result.entries).toHaveLength(3);
    expect(result.entries.map((entry) => entry.status)).toEqual([
      "MATCHED",
      "MATCHED",
      "MATCHED",
    ]);
    expect(result.entries.map((entry) => entry.targetWorkflow?.id)).toEqual([
      "external",
      "external",
      "external",
    ]);
    expect(result.entries[0].detail?.id).toBe("detail-shared");
    expect(result.entries[1].detail?.id).toBe("detail-shared");
    expect(result.entries[0].detail?.items).toEqual([
      { id: "item-shared", text: "手写 shared" },
    ]);
    expect(result.entries[0].detail).toMatchObject({
      materials: "准备原料",
      safetyNotice: "小心",
      imageUrl: "/image.png",
      videoUrl: "https://example.com/video",
      custom: "keep",
    });
    expect(JSON.stringify([record, shared, oldCurrent])).toBe(before);
  });

  it("distinguishes missing sources, absent instructions, ambiguous names and unfinished handwritten lists", () => {
    const external = workflow(
      [detail("other", "别的做法")],
      undefined,
      "external",
    );
    const record = workflow([
      { ...module("source-gone", "已有本地"), detailWorkflowId: "gone" },
      { ...module("detail-gone", "不存在"), detailWorkflowId: "external" },
      module("ambiguous", "café"),
      module("blank", "空做法"),
      module("partial", "未写完"),
      { id: "legacy", title: "旧空做法", description: "" },
      detail("local", "已有本地"),
      detail("duplicate-a", " café "),
      detail("duplicate-b", "cafe\u0301"),
      {
        kind: "DETAIL",
        id: "blank-document",
        title: "空做法",
        items: [],
        materials: "保留准备信息",
      },
      {
        kind: "DETAIL",
        id: "partial-document",
        title: "未写完",
        items: [
          { id: "done", text: "第一步" },
          { id: "empty", text: "  " },
        ],
      },
    ]);
    const result = generateWorkflow(record, [external]),
      entries = new Map(result.entries.map((entry) => [entry.id, entry]));
    expect(entries.get("source-gone")).toMatchObject({
      status: "MISSING",
      sourceMissing: true,
    });
    expect(entries.get("source-gone")?.detail).toBeUndefined();
    expect(entries.get("detail-gone")).toMatchObject({
      status: "MISSING",
      sourceMissing: false,
    });
    expect(entries.get("detail-gone")?.targetWorkflow?.id).toBe("external");
    expect(entries.get("ambiguous")?.status).toBe("AMBIGUOUS");
    expect(entries.get("ambiguous")?.detail).toBeUndefined();
    expect(entries.get("blank")).toMatchObject({
      status: "MATCHED",
      contentStatus: "EMPTY",
      detail: { materials: "保留准备信息" },
    });
    expect(entries.get("partial")?.contentStatus).toBe("INCOMPLETE");
    expect(entries.get("partial")?.detail?.items).toHaveLength(2);
    expect(entries.get("module-legacy")?.contentStatus).toBe("EMPTY");
  });

  it("keeps original module order without manufacturing precedence when no timeline or arrows exist", () => {
    const record = workflow([
      module("b"),
      detail("b"),
      { title: "更早格式", description: "原来写的步骤" },
      module("a"),
      detail("a"),
    ]);
    const result = generateWorkflow(record, []);
    expect(result.mode).toBe("source");
    expect(result.entries.map((entry) => entry.id)).toEqual([
      "b",
      "module-legacy-2",
      "a",
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.edges).toEqual([]);
    expect(
      result.warnings.some((warning) => warning.includes("尚未指定先后")),
    ).toBe(true);
    expect(result.entries[1].detail?.items[0].text).toBe("原来写的步骤");
    expect(generateWorkflow(workflow([]), []).entries).toEqual([]);
  });

  it("retains all one hundred nodes of a reversed stored chain", () => {
    const steps = Array.from({ length: 100 }, (_, index) =>
      module(
        String(index),
        `工作 ${index}`,
        index < 99 ? [String(index + 1)] : [],
      ),
    ).reverse();
    const result = generateWorkflow(workflow(steps), []);
    expect(result.entries.map((entry) => entry.id)).toEqual(
      Array.from({ length: 100 }, (_, index) => String(index)),
    );
    expect(result.groups).toHaveLength(100);
    expect(result.edges).toHaveLength(99);
  });
});
