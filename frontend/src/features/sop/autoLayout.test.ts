import { describe, expect, it } from "vitest";
import type {
  ModuleFrame,
  Workflow,
  WorkflowModule,
  WorkflowStep,
} from "../../types";
import { autoLayoutWorkflow } from "./autoLayout";
import {
  DEFAULT_BOARD_AXES,
  boardSize,
  moduleAxisLabels,
  serializeBoardAxes,
  timelinePosition,
  type BoardAxesSettings,
} from "./boardAxes";
import { moduleFrame, modulePosition, moduleSize } from "./canvas";
import { generateWorkflow } from "./generatedWorkflow";
import { completeWorkflowText } from "./completeWorkflowText";
import { readWorkflow } from "./workflows";

const settings: BoardAxesSettings = {
  ...DEFAULT_BOARD_AXES,
  canvas: { width: 820, height: 820 },
};
const module = (
  id: string,
  x: number,
  y: number,
  width = 80,
  height = 80,
): WorkflowModule => ({
  kind: "MODULE",
  id,
  title: `工作${id}`,
  frame: { x, y, width, height },
});
const detail = (title: string, text: string): WorkflowStep => ({
  kind: "DETAIL",
  id: `detail-${title}`,
  title,
  items: [{ id: `item-${title}`, text }],
});
function record(steps: WorkflowStep[], axes = settings): Workflow {
  return {
    id: "local-only",
    title: "手工流程",
    category: "自用",
    revision: 9,
    draft: JSON.stringify(steps),
    boardSettings: serializeBoardAxes(axes),
  };
}
function frames(workflow: Workflow, axes: BoardAxesSettings) {
  const board = boardSize(axes);
  return new Map(
    readWorkflow(workflow.draft).modules.map((entry, index) => [
      entry.id,
      moduleFrame(entry, index, board),
    ]),
  );
}
const overlaps = (a: ModuleFrame, b: ModuleFrame) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;
function expectNoNewOverlaps(
  before: Map<string, ModuleFrame>,
  after: Map<string, ModuleFrame>,
) {
  const ids = [...before.keys()];
  for (let first = 0; first < ids.length; first++)
    for (let second = first + 1; second < ids.length; second++) {
      const a = ids[first],
        b = ids[second];
      if (!overlaps(before.get(a)!, before.get(b)!))
        expect(
          overlaps(after.get(a)!, after.get(b)!),
          `${a} and ${b} gained an overlap`,
        ).toBe(false);
    }
}
function expectNoOverlaps(positions: Map<string, ModuleFrame>) {
  const values = [...positions.values()];
  for (let first = 0; first < values.length; first++)
    for (let second = first + 1; second < values.length; second++)
      expect(overlaps(values[first], values[second])).toBe(false);
}
const apply = (workflow: Workflow, steps: WorkflowStep[]) => ({
  ...workflow,
  draft: JSON.stringify(steps),
});
function labels(workflow: Workflow, axes: BoardAxesSettings) {
  const board = boardSize(axes);
  return new Map(
    readWorkflow(workflow.draft).modules.map((entry, index) => [
      entry.id,
      moduleAxisLabels(
        modulePosition(entry, index, board),
        moduleSize(entry, board),
        axes,
      ),
    ]),
  );
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

describe("local workflow layout planning", () => {
  it("packs an unconstrained board deterministically and preserves original text, dimensions, raw order and extra fields", () => {
    const steps: WorkflowStep[] = [
      {
        ...module("a", 540, 600),
        nextModuleIds: ["c"],
        connectionPorts: { c: { source: "bottom", target: "left" } },
        detailWorkflowId: "shared",
        detailName: "共享原文",
        custom: { color: "green" },
      },
      {
        ...detail("共享原文", "原步骤不可改写。"),
        imageUrl: "https://example.com/image.png",
        videoUrl: "https://example.com/video.mp4",
        materials: "原物料",
        safetyNotice: "原注意",
        additional: [1, "keep"],
      },
      {
        title: "旧工作",
        description: "旧正文与空白必须保留。",
        frame: {
          x: 300,
          y: 500,
          width: 120,
          height: 70,
          customFrame: "retain",
        },
        customLegacy: true,
      },
      module("c", 200, 260, 64, 100),
    ];
    const workflow = freeze(record(steps));
    const library = freeze([record([detail("共享原文", "外部原文。")])]);
    const before = JSON.stringify({ workflow, library });
    const plan = autoLayoutWorkflow(workflow, library);
    expect(plan.changed).toBe(3);
    expect(plan.unplaced).toEqual([]);
    const next = apply(workflow, plan.steps);
    const originalFrames = frames(workflow, settings),
      nextFrames = frames(next, settings);
    for (const [id, original] of originalFrames) {
      expect(nextFrames.get(id)!.width).toBe(original.width);
      expect(nextFrames.get(id)!.height).toBe(original.height);
    }
    expectNoOverlaps(nextFrames);
    expect(
      plan.steps.map(({ frame: _frame, ...unchanged }) => unchanged),
    ).toEqual(steps.map(({ frame: _frame, ...unchanged }) => unchanged));
    expect((plan.steps[2].frame as Record<string, unknown>).customFrame).toBe(
      "retain",
    );
    expect(generateWorkflow(next, library).edges).toEqual(
      generateWorkflow(workflow, library).edges,
    );
    expect(completeWorkflowText(next, generateWorkflow(next, library))).toBe(
      completeWorkflowText(workflow, generateWorkflow(workflow, library)),
    );
    expect(JSON.stringify({ workflow, library })).toBe(before);
    expect(autoLayoutWorkflow(workflow, library)).toEqual(plan);
    expect(autoLayoutWorkflow(next, library)).toMatchObject({
      changed: 0,
      unplaced: [],
    });
  });

  it("uses dependency order for placement without reordering stored modules or inventing connections", () => {
    const workflow = record([
      module("last", 50, 50),
      { ...module("first", 500, 400), nextModuleIds: ["last"] },
    ]);
    const plan = autoLayoutWorkflow(workflow, []),
      next = apply(workflow, plan.steps);
    const positioned = frames(next, settings);
    expect(positioned.get("first")!.x).toBeLessThan(positioned.get("last")!.x);
    expect(plan.steps.map((entry) => entry.id)).toEqual(["last", "first"]);
    expect(generateWorkflow(next, []).edges).toEqual([
      { sourceId: "first", targetId: "last" },
    ]);
  });

  it("keeps the exact time coordinate and every true progress on a non-linear horizontal time axis", () => {
    const axes: BoardAxesSettings = {
      ...settings,
      timeline: {
        enabled: true,
        startMinute: 540,
        endMinute: 1080,
        axis: "x",
        segments: [{ startOffset: 0, endOffset: 60, scale: 4 }],
      },
    };
    const at = (id: string, minute: number, width: number, y: number) =>
      module(
        id,
        timelinePosition(minute - 540, axes) * (820 - width),
        y,
        width,
        90,
      );
    const workflow = record(
      [
        at("late", 720, 160, 500),
        at("one", 600, 80, 400),
        at("two", 600, 120, 400),
      ],
      axes,
    );
    const plan = autoLayoutWorkflow(workflow, []),
      next = apply(workflow, plan.steps);
    expect(plan.changed).toBeGreaterThan(0);
    expect(plan.unplaced).toEqual([]);
    const oldFrames = frames(workflow, axes),
      newFrames = frames(next, axes);
    for (const [id, oldFrame] of oldFrames) {
      expect(newFrames.get(id)!.x).toBe(oldFrame.x);
      expect(newFrames.get(id)!.x / (820 - oldFrame.width)).toBe(
        oldFrame.x / (820 - oldFrame.width),
      );
    }
    expect(labels(next, axes)).toEqual(labels(workflow, axes));
    expect(
      generateWorkflow(next, []).entries.map((entry) => entry.minute),
    ).toEqual([600, 600, 720]);
    expectNoOverlaps(newFrames);
  });

  it("packs within each original priority band without changing any priority category", () => {
    const axes: BoardAxesSettings = {
      ...settings,
      priority: { enabled: true, axis: "y" },
    };
    const workflow = record(
      [
        module("normal", 300, 400),
        module("early", 200, 10),
        module("later", 500, 700),
      ],
      axes,
    );
    const plan = autoLayoutWorkflow(workflow, []),
      next = apply(workflow, plan.steps);
    expect(plan.changed).toBe(3);
    expect(plan.unplaced).toEqual([]);
    expect(labels(next, axes)).toEqual(labels(workflow, axes));
    expectNoOverlaps(frames(next, axes));
  });

  it("preserves exact vertical times and horizontal priority bands while separating same-time work", () => {
    const axes: BoardAxesSettings = {
      ...settings,
      canvas: { width: 1200, height: 1000 },
      timeline: {
        enabled: true,
        startMinute: 540,
        endMinute: 1080,
        axis: "y",
        focus: { startOffset: 60, endOffset: 180, scale: 3 },
      },
      priority: { enabled: true, axis: "x" },
    };
    const y = timelinePosition(60, axes) * (1000 - 80);
    const workflow = record(
      [
        module("normal-one", 560, y),
        module("normal-two", 616, y),
        module("high", 112, y),
      ],
      axes,
    );
    const plan = autoLayoutWorkflow(workflow, []),
      next = apply(workflow, plan.steps);
    expect(plan.unplaced).toEqual([]);
    expect(plan.changed).toBeGreaterThan(0);
    const oldFrames = frames(workflow, axes),
      newFrames = frames(next, axes);
    for (const [id, frame] of oldFrames)
      expect(newFrames.get(id)!.y).toBe(frame.y);
    expect(labels(next, axes)).toEqual(labels(workflow, axes));
    expectNoOverlaps(newFrames);
  });

  it("keeps impossible time-and-priority-locked boxes in place rather than changing semantic values or board size", () => {
    const axes: BoardAxesSettings = {
      ...settings,
      canvas: { width: 320, height: 320 },
      timeline: { enabled: true, startMinute: 0, endMinute: 60, axis: "x" },
      priority: { enabled: true, axis: "y" },
    };
    const steps = [module("a", 0, 0, 320, 320), module("b", 0, 0, 320, 320)];
    const workflow = record(steps, axes),
      before = JSON.stringify(workflow);
    const plan = autoLayoutWorkflow(workflow, []);
    expect(plan.changed).toBe(0);
    expect(new Set(plan.unplaced)).toEqual(new Set(["a", "b"]));
    expect(plan.steps).toEqual(steps);
    expect(JSON.stringify(workflow)).toBe(before);
  });

  it("replans around retained original boxes and rolls earlier moves back if they would create overlaps", () => {
    const axes: BoardAxesSettings = {
      ...settings,
      canvas: { width: 320, height: 320 },
      timeline: { enabled: true, startMinute: 0, endMinute: 60, axis: "x" },
    };
    const steps = [
      module("bottom-left", 0, 220, 100, 100),
      module("bottom-right", 200, 220, 100, 100),
      module("large", 0, 0, 320, 200),
    ];
    const workflow = record(steps, axes);
    expectNoOverlaps(frames(workflow, axes));
    const plan = autoLayoutWorkflow(workflow, []);
    expect(plan.unplaced.length).toBeGreaterThan(0);
    expectNoNewOverlaps(
      frames(workflow, axes),
      frames(apply(workflow, plan.steps), axes),
    );
    expect(plan.steps).toEqual(steps);
    expect(plan.changed).toBe(0);
  });

  it("leaves empty and instruction-only workflows unchanged", () => {
    for (const steps of [[], [detail("独立原文", "第一句。\n第二句。")]])
      expect(autoLayoutWorkflow(record(steps), [])).toEqual({
        steps,
        changed: 0,
        unplaced: [],
      });
  });

  it("handles all one hundred supported modules with stable identities and no collisions", () => {
    const workflow = record(
      Array.from({ length: 100 }, (_, index) =>
        module(`m-${index}`, 0, 0, 32, 32),
      ),
    );
    const plan = autoLayoutWorkflow(workflow, []);
    expect(plan.unplaced).toEqual([]);
    expect(plan.changed).toBe(99);
    expect(plan.steps.map((entry) => entry.id)).toEqual(
      JSON.parse(workflow.draft).map((entry: WorkflowStep) => entry.id),
    );
    expectNoOverlaps(frames(apply(workflow, plan.steps), settings));
  });
});
