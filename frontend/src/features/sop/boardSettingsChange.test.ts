import { describe, expect, it } from "vitest";
import { boardSettingsChange } from "./boardSettingsChange";
import {
  DEFAULT_BOARD_AXES,
  readBoardAxes,
  serializeBoardAxes,
  boardSize,
  moduleAxisLabels,
  timelineOffset,
  timelineIntervals,
  withTimelineIntervalLength,
  moveTimelineTick,
  type BoardAxesSettings,
} from "./boardAxes";
import { moduleFrame, modulePosition, moduleSize } from "./canvas";
import { readWorkflow } from "./workflows";
import type { WorkflowModule, WorkflowStep } from "../../types";

describe("fixed module geometry during board changes", () => {
  const previous = serializeBoardAxes({
    ...DEFAULT_BOARD_AXES,
    canvas: { width: 1000, height: 700 },
  });
  const steps = [
    {
      kind: "MODULE",
      id: "a",
      title: "准备",
      position: { x: 0.1, y: 0.2 },
      size: { width: 0.2, height: 0.2 },
      nextModuleIds: ["b"],
      connectionPorts: { b: { source: "top", target: "left" } },
      custom: "保留",
    },
    {
      kind: "DETAIL",
      id: "d",
      title: "准备",
      items: [{ id: "i", text: "手写步骤" }],
    },
    { kind: "MODULE", id: "b", title: "收好", position: { x: 0.6, y: 0.6 } },
  ];
  it("converts legacy ratios once and keeps the original scale reference for later resizes", () => {
    const next = serializeBoardAxes({
      ...readBoardAxes(previous),
      canvas: { width: 1800, height: 1200 },
    });
    const changed = boardSettingsChange(JSON.stringify(steps), previous, next);
    expect(changed.steps[0]).toEqual({
      kind: "MODULE",
      id: "a",
      title: "准备",
      frame: { x: 100, y: 140, width: 200, height: 140 },
      nextModuleIds: ["b"],
      connectionPorts: { b: { source: "top", target: "left" } },
      custom: "保留",
    });
    expect(changed.steps[1]).toEqual(steps[1]);
    expect(readBoardAxes(changed.boardSettings).referenceCanvas).toEqual({
      width: 1000,
      height: 700,
    });
    const again = boardSettingsChange(
      JSON.stringify(changed.steps),
      changed.boardSettings,
      serializeBoardAxes({
        ...readBoardAxes(changed.boardSettings),
        canvas: { width: 2000, height: 1800 },
      }),
    );
    expect(again.steps).toEqual(changed.steps);
    expect(readBoardAxes(again.boardSettings).referenceCanvas).toEqual({
      width: 1000,
      height: 700,
    });
  });
  it("keeps axis-only updates from rewriting geometry or forgetting an existing reference", () => {
    const stored = serializeBoardAxes({
      ...readBoardAxes(previous),
      referenceCanvas: { width: 820, height: 820 },
    });
    const next = serializeBoardAxes({
      ...readBoardAxes(previous),
      priority: { enabled: true, axis: "y" },
    });
    const changed = boardSettingsChange(JSON.stringify(steps), stored, next);
    expect(changed.steps).toEqual(steps);
    expect(readBoardAxes(changed.boardSettings)).toMatchObject({
      priority: { enabled: true, axis: "y" },
      referenceCanvas: { width: 820, height: 820 },
    });
  });
  it("rejects shrinking through content and validates reference dimensions even with a valid canvas", () => {
    expect(() =>
      boardSettingsChange(
        JSON.stringify(steps),
        previous,
        serializeBoardAxes({
          ...readBoardAxes(previous),
          canvas: { width: 320, height: 320 },
        }),
      ),
    ).toThrow();
    expect(steps[0]).not.toHaveProperty("frame");
    expect(() =>
      serializeBoardAxes({
        ...readBoardAxes(previous),
        referenceCanvas: { width: 319, height: 820 },
      }),
    ).toThrow();
    const restored = readBoardAxes(
      JSON.stringify({
        ...readBoardAxes(previous),
        referenceCanvas: { width: 319, height: 820 },
      }),
    );
    expect(restored.canvas).toEqual({ width: 1000, height: 700 });
    expect(restored.referenceCanvas).toBeUndefined();
  });
});

describe("atomic focus remapping", () => {
  const configured = (axis: "x" | "y" = "x"): BoardAxesSettings => ({
    ...DEFAULT_BOARD_AXES,
    timeline: { enabled: true, startMinute: 540, endMinute: 1080, axis },
    priority: { enabled: true, axis: axis === "x" ? "y" : "x" },
    canvas: { width: 1000, height: 700 },
    referenceCanvas: { width: 820, height: 820 },
  });
  function preciseOffset(
    module: WorkflowModule,
    index: number,
    settings: BoardAxesSettings,
  ) {
    const board = boardSize(settings),
      position = modulePosition(module, index, board),
      size = moduleSize(module, board);
    const axis = settings.timeline.axis || "x";
    const travel = 1 - (axis === "x" ? size.width : size.height);
    return timelineOffset(
      travel <= 1e-9 ? 0 : position[axis] / travel,
      settings,
    );
  }
  function fixture(axis: "x" | "y"): WorkflowStep[] {
    const frame = {
      x: 0.5 * (1000 - 32),
      y: 0.5 * (700 - 70),
      width: 32,
      height: 70,
    };
    frame[axis] =
      0.6 *
      ((axis === "x" ? 1000 : 700) -
        (axis === "x" ? frame.width : frame.height));
    return [
      {
        id: "legacy",
        title: "旧工作",
        description: "保留手写做法",
        custom: { color: "green" },
        position: {
          x: axis === "x" ? 0.4 * 0.8 : 0.5 * 0.8,
          y: axis === "y" ? 0.4 * 0.6 : 0.5 * 0.6,
        },
        size: { width: 0.2, height: 0.4 },
        nextModuleIds: ["fixed"],
        connectionPorts: { fixed: { source: "top", target: "left" } },
        detailWorkflowId: "shared",
        detailName: "原来做法名",
      },
      {
        kind: "DETAIL",
        id: "d",
        title: "独立做法",
        items: [{ id: "i", text: "手动写的步骤" }],
        materials: "不要覆盖",
        unknown: 42,
      },
      {
        kind: "MODULE",
        id: "fixed",
        title: "固定工作",
        frame,
        custom: "retained",
        nextModuleIds: ["module-legacy"],
      },
      {
        kind: "MODULE",
        id: "start",
        title: "最早",
        frame: { x: 0, y: 0, width: 32, height: 32 },
      },
      {
        kind: "MODULE",
        id: "end",
        title: "最晚",
        frame: { x: 1000 - 32, y: 700 - 32, width: 32, height: 32 },
      },
    ];
  }

  it("preserves exact original times, fixed sizes, priority and documents for horizontal and vertical focus changes", () => {
    for (const axis of ["x", "y"] as const) {
      const previous = configured(axis),
        steps = fixture(axis),
        original = structuredClone(steps);
      const raw = JSON.stringify(steps),
        before = readWorkflow(raw),
        dimensions = boardSize(previous);
      const next = {
        ...previous,
        timeline: {
          ...previous.timeline,
          focus: { startOffset: 180, endOffset: 300, scale: 6 },
        },
      };
      const change = boardSettingsChange(
        raw,
        serializeBoardAxes(previous),
        serializeBoardAxes(next),
      );
      const saved = readBoardAxes(change.boardSettings),
        after = readWorkflow(JSON.stringify(change.steps));
      expect(saved.canvas).toEqual(previous.canvas);
      expect(saved.referenceCanvas).toEqual(previous.referenceCanvas);
      expect(after.modules.map((module) => module.id)).toEqual(
        before.modules.map((module) => module.id),
      );
      const documentFields = (detail: (typeof before.details)[number]) => {
        const {
          frame: _frame,
          position: _position,
          size: _size,
          ...content
        } = detail;
        return content;
      };
      expect(after.details.map(documentFields)).toEqual(
        before.details.map(documentFields),
      );
      expect(change.steps[1]).toEqual(steps[1]);
      for (const [index, module] of before.modules.entries()) {
        const moved = after.modules[index],
          oldFrame = moduleFrame(module, index, dimensions),
          newFrame = moduleFrame(moved, index, dimensions);
        expect(preciseOffset(moved, index, saved)).toBeCloseTo(
          preciseOffset(module, index, previous),
          10,
        );
        expect(
          moduleAxisLabels(
            modulePosition(moved, index, dimensions),
            moduleSize(moved, dimensions),
            saved,
          ),
        ).toEqual(
          moduleAxisLabels(
            modulePosition(module, index, dimensions),
            moduleSize(module, dimensions),
            previous,
          ),
        );
        expect(newFrame.width).toBe(oldFrame.width);
        expect(newFrame.height).toBe(oldFrame.height);
        expect(newFrame[axis === "x" ? "y" : "x"]).toBe(
          oldFrame[axis === "x" ? "y" : "x"],
        );
        expect(newFrame.x).toBeGreaterThanOrEqual(0);
        expect(newFrame.y).toBeGreaterThanOrEqual(0);
        expect(newFrame.x + newFrame.width).toBeLessThanOrEqual(
          dimensions.width + 1e-9,
        );
        expect(newFrame.y + newFrame.height).toBeLessThanOrEqual(
          dimensions.height + 1e-9,
        );
      }
      expect(change.steps[0]).toMatchObject({
        id: "legacy",
        custom: { color: "green" },
        detailWorkflowId: "shared",
        detailName: "原来做法名",
        nextModuleIds: ["fixed"],
        connectionPorts: { fixed: { source: "top", target: "left" } },
      });
      expect(change.steps[0]).not.toHaveProperty("position");
      expect(change.steps[0]).not.toHaveProperty("size");
      expect(steps).toEqual(original);

      const stronger = {
        ...saved,
        timeline: {
          ...saved.timeline,
          focus: { startOffset: 50, endOffset: 100, scale: 10 },
        },
      };
      const again = boardSettingsChange(
        JSON.stringify(change.steps),
        change.boardSettings,
        serializeBoardAxes(stronger),
      );
      const restored = boardSettingsChange(
        JSON.stringify(again.steps),
        again.boardSettings,
        serializeBoardAxes({
          ...saved,
          timeline: { ...saved.timeline, focus: null },
        }),
      );
      const finalModules = readWorkflow(JSON.stringify(restored.steps)).modules;
      for (const [index, module] of before.modules.entries()) {
        const oldFrame = moduleFrame(module, index, dimensions),
          finalFrame = moduleFrame(finalModules[index], index, dimensions);
        expect(finalFrame.x).toBeCloseTo(oldFrame.x, 9);
        expect(finalFrame.y).toBeCloseTo(oldFrame.y, 9);
        expect(finalFrame.width).toBe(oldFrame.width);
        expect(finalFrame.height).toBe(oldFrame.height);
      }
    }
  });

  it("stabilizes legacy index identifiers without shifting links or losing untouched detail fields", () => {
    const previous = configured();
    const steps: WorkflowStep[] = [
      {
        kind: "MODULE",
        title: "未显式命名id",
        position: { x: 0.2, y: 0.3 },
        nextModuleIds: ["module-legacy-2"],
      },
      {
        kind: "DETAIL",
        title: "单独说明",
        items: [{ id: "i", text: "original" }],
        unknown: { keep: true },
      },
      {
        title: "更早的数据",
        description: "旧说明",
        position: { x: 0.4, y: 0.2 },
      },
    ];
    const before = readWorkflow(JSON.stringify(steps));
    const changed = boardSettingsChange(
      JSON.stringify(steps),
      serializeBoardAxes(previous),
      serializeBoardAxes({
        ...previous,
        timeline: {
          ...previous.timeline,
          focus: { startOffset: 100, endOffset: 200, scale: 3 },
        },
      }),
    );
    const after = readWorkflow(JSON.stringify(changed.steps));
    expect(after.modules.map((module) => module.id)).toEqual(
      before.modules.map((module) => module.id),
    );
    expect(after.details.map((detail) => detail.id)).toEqual(
      before.details.map((detail) => detail.id),
    );
    expect(changed.steps[0].nextModuleIds).toEqual(["module-legacy-2"]);
    expect(changed.steps[1]).toEqual({ ...steps[1], id: "detail-1" });
    expect(after.details[1].items).toEqual(before.details[1].items);
  });

  it("does not remap when a range, axis or initial enabled state is redefined", () => {
    const previous = configured(),
      steps = fixture("x"),
      raw = JSON.stringify(steps);
    const focus = { startOffset: 50, endOffset: 100, scale: 3 };
    for (const next of [
      {
        ...previous,
        timeline: { ...previous.timeline, endMinute: 1000, focus },
      },
      {
        ...previous,
        timeline: { ...previous.timeline, startMinute: 500, focus },
      },
      {
        ...previous,
        timeline: { ...previous.timeline, axis: "y" as const, focus },
        priority: { enabled: true, axis: "x" as const },
      },
      {
        ...previous,
        timeline: { ...previous.timeline, enabled: false, focus },
      },
    ])
      expect(
        boardSettingsChange(
          raw,
          serializeBoardAxes(previous),
          serializeBoardAxes(next),
        ).steps,
      ).toEqual(steps);
    const disabled = {
      ...previous,
      timeline: { ...previous.timeline, enabled: false },
    };
    expect(
      boardSettingsChange(
        raw,
        serializeBoardAxes(disabled),
        serializeBoardAxes({
          ...previous,
          timeline: { ...previous.timeline, focus },
        }),
      ).steps,
    ).toEqual(steps);
  });

  it("preserves ordinary resize semantics but remaps a simultaneous timeline edit before checking new bounds", () => {
    const previous = configured(),
      steps = fixture("x"),
      raw = JSON.stringify(steps);
    const focus = { startOffset: 180, endOffset: 300, scale: 4 };
    const focused = { ...previous, timeline: { ...previous.timeline, focus } };
    const resizeOnly = boardSettingsChange(
      raw,
      serializeBoardAxes(focused),
      serializeBoardAxes({ ...focused, canvas: { width: 1800, height: 1200 } }),
    );
    const oldModules = readWorkflow(raw).modules,
      resizedModules = readWorkflow(JSON.stringify(resizeOnly.steps)).modules;
    for (const [index, module] of oldModules.entries())
      expect(
        moduleFrame(resizedModules[index], index, {
          width: 1800,
          height: 1200,
        }),
      ).toEqual(moduleFrame(module, index, boardSize(previous)));
    const shrunk = boardSettingsChange(
      raw,
      serializeBoardAxes(previous),
      serializeBoardAxes({ ...focused, canvas: { width: 800, height: 700 } }),
    );
    const shrunkSettings = readBoardAxes(shrunk.boardSettings);
    const shrunkModules = readWorkflow(JSON.stringify(shrunk.steps)).modules;
    for (const [index, module] of oldModules.entries()) {
      expect(
        preciseOffset(shrunkModules[index], index, shrunkSettings),
      ).toBeCloseTo(preciseOffset(module, index, previous), 10);
      const frame = moduleFrame(
        shrunkModules[index],
        index,
        boardSize(shrunkSettings),
      );
      expect(frame.x + frame.width).toBeLessThanOrEqual(800 + 1e-9);
    }
    const grown = boardSettingsChange(
      raw,
      serializeBoardAxes(previous),
      serializeBoardAxes({ ...focused, canvas: { width: 1800, height: 1200 } }),
    );
    const afterSettings = readBoardAxes(grown.boardSettings),
      afterModules = readWorkflow(JSON.stringify(grown.steps)).modules;
    for (const [index, module] of oldModules.entries()) {
      const after = afterModules[index];
      expect(preciseOffset(after, index, afterSettings)).toBeCloseTo(
        preciseOffset(module, index, previous),
        10,
      );
      expect(
        moduleAxisLabels(
          modulePosition(after, index, boardSize(afterSettings)),
          moduleSize(after, boardSize(afterSettings)),
          afterSettings,
        ).priority,
      ).toBe(
        moduleAxisLabels(
          modulePosition(module, index, boardSize(previous)),
          moduleSize(module, boardSize(previous)),
          previous,
        ).priority,
      );
    }
    expect(readBoardAxes(grown.boardSettings).referenceCanvas).toEqual(
      previous.referenceCanvas,
    );
  });

  it("keeps overnight assigned minutes during a local focus change", () => {
    const previous = configured("y");
    previous.timeline = {
      ...previous.timeline,
      startMinute: 1380,
      endMinute: 60,
    };
    const steps = fixture("y"),
      raw = JSON.stringify(steps),
      before = readWorkflow(raw).modules;
    const changed = boardSettingsChange(
      raw,
      serializeBoardAxes(previous),
      serializeBoardAxes({
        ...previous,
        timeline: {
          ...previous.timeline,
          focus: { startOffset: 30, endOffset: 90, scale: 5 },
        },
      }),
    );
    const settings = readBoardAxes(changed.boardSettings),
      after = readWorkflow(JSON.stringify(changed.steps)).modules;
    for (const [index, module] of before.entries())
      expect(preciseOffset(after[index], index, settings)).toBeCloseTo(
        preciseOffset(module, index, previous),
        10,
      );
  });

  it("keeps half-minute labels stable for 32px modules across repeated focus round-trips", () => {
    const offsets = [0.5, 67.5, 251.5, 256.5, 277.5, 539.5];
    const expected = ["09:01", "10:08", "13:12", "13:17", "13:38", "18:00"];
    for (const axis of ["x", "y"] as const) {
      let settings = configured(axis);
      let steps: WorkflowStep[] = offsets.map((offset, index) => ({
        kind: "MODULE",
        id: `half-${index}`,
        title: `半分钟 ${index}`,
        frame: {
          x: 0,
          y: 0,
          width: 32,
          height: 32,
          [axis]: (offset / 540) * ((axis === "x" ? 1000 : 700) - 32),
        },
      }));
      for (const focus of [
        { startOffset: 180, endOffset: 240, scale: 4 },
        { startOffset: 0, endOffset: 500, scale: 10 },
        { startOffset: 37, endOffset: 98, scale: 2.7 },
        null,
        { startOffset: 180, endOffset: 240, scale: 4 },
        null,
      ]) {
        const change = boardSettingsChange(
          JSON.stringify(steps),
          serializeBoardAxes(settings),
          serializeBoardAxes({
            ...settings,
            timeline: { ...settings.timeline, focus },
          }),
        );
        steps = change.steps;
        settings = readBoardAxes(change.boardSettings);
        const modules = readWorkflow(JSON.stringify(steps)).modules;
        expect(
          modules.map(
            (module, index) =>
              moduleAxisLabels(
                modulePosition(module, index, boardSize(settings)),
                moduleSize(module, boardSize(settings)),
                settings,
              ).time,
          ),
        ).toEqual(expected);
        for (const [index, module] of modules.entries())
          expect(preciseOffset(module, index, settings)).toBeCloseTo(
            offsets[index],
            9,
          );
      }
    }
  });

  it("atomically preserves time, priority, fixed sizes and identifiers through interval inputs and tick drags", () => {
    for (const axis of ["x", "y"] as const) {
      const initial = configured(axis),
        dimensions = boardSize(initial);
      const halfFrame = {
        x: 0.5 * (1000 - 32),
        y: 0.5 * (700 - 32),
        width: 32,
        height: 32,
      };
      halfFrame[axis] = (251.5 / 540) * ((axis === "x" ? 1000 : 700) - 32);
      const original: WorkflowStep[] = [
        ...fixture(axis),
        {
          kind: "MODULE",
          id: "half-minute",
          title: "半分钟",
          frame: halfFrame,
        },
      ];
      const originalModules = readWorkflow(JSON.stringify(original)).modules;
      let settings = initial,
        steps = original;
      const operations = [
        (s: BoardAxesSettings) =>
          withTimelineIntervalLength(s, 3, timelineIntervals(s)[3].length + 50),
        (s: BoardAxesSettings) =>
          moveTimelineTick(s, timelineIntervals(s)[3].endOffset, 20),
        (s: BoardAxesSettings) =>
          moveTimelineTick(s, timelineIntervals(s).at(-1)!.endOffset, -30),
        (s: BoardAxesSettings) => ({
          ...s,
          canvas: initial.canvas,
          timeline: { ...s.timeline, segments: null },
        }),
      ];
      for (const operation of operations) {
        const next = operation(settings);
        const change = boardSettingsChange(
          JSON.stringify(steps),
          serializeBoardAxes(settings),
          serializeBoardAxes(next),
        );
        settings = readBoardAxes(change.boardSettings);
        steps = change.steps;
        const modules = readWorkflow(JSON.stringify(steps)).modules;
        expect(modules.map((module) => module.id)).toEqual(
          originalModules.map((module) => module.id),
        );
        expect(steps[1]).toEqual(original[1]);
        expect(settings.referenceCanvas).toEqual(initial.referenceCanvas);
        for (const [index, module] of modules.entries()) {
          expect(preciseOffset(module, index, settings)).toBeCloseTo(
            preciseOffset(originalModules[index], index, initial),
            9,
          );
          expect(
            moduleAxisLabels(
              modulePosition(module, index, boardSize(settings)),
              moduleSize(module, boardSize(settings)),
              settings,
            ),
          ).toEqual(
            moduleAxisLabels(
              modulePosition(originalModules[index], index, dimensions),
              moduleSize(originalModules[index], dimensions),
              initial,
            ),
          );
          const frame = moduleFrame(module, index, boardSize(settings)),
            oldFrame = moduleFrame(originalModules[index], index, dimensions);
          expect(frame.width).toBe(oldFrame.width);
          expect(frame.height).toBe(oldFrame.height);
          expect(frame.x + frame.width).toBeLessThanOrEqual(
            boardSize(settings).width + 1e-9,
          );
          expect(frame.y + frame.height).toBeLessThanOrEqual(
            boardSize(settings).height + 1e-9,
          );
        }
      }
      const restored = readWorkflow(JSON.stringify(steps)).modules;
      for (const [index, module] of restored.entries()) {
        expect(moduleFrame(module, index, dimensions).x).toBeCloseTo(
          moduleFrame(originalModules[index], index, dimensions).x,
          9,
        );
        expect(moduleFrame(module, index, dimensions).y).toBeCloseTo(
          moduleFrame(originalModules[index], index, dimensions).y,
          9,
        );
      }
    }
  });

  it("allows a timeline to shrink through old occupied positions after remapping, while rejecting frames larger than the new board", () => {
    const settings: BoardAxesSettings = {
      ...configured(),
      canvas: { width: 900, height: 700 },
      timeline: { ...configured().timeline, endMinute: 720 },
    };
    const steps: WorkflowStep[] = [
      {
        kind: "MODULE",
        id: "end",
        title: "最后",
        frame: { x: 868, y: 200, width: 32, height: 32 },
      },
      {
        kind: "MODULE",
        id: "middle",
        title: "中间",
        frame: { x: 434, y: 300, width: 32, height: 32 },
      },
    ];
    const next = withTimelineIntervalLength(settings, 1, 100);
    expect(boardSize(next).width).toBe(700);
    const changed = boardSettingsChange(
      JSON.stringify(steps),
      serializeBoardAxes(settings),
      serializeBoardAxes(next),
    );
    const modules = readWorkflow(JSON.stringify(changed.steps)).modules;
    expect(moduleFrame(modules[0], 0, boardSize(next)).x).toBe(668);
    for (const [index, module] of modules.entries())
      expect(preciseOffset(module, index, next)).toBeCloseTo(
        preciseOffset(
          readWorkflow(JSON.stringify(steps)).modules[index],
          index,
          settings,
        ),
        10,
      );
    expect(() =>
      boardSettingsChange(
        JSON.stringify(steps),
        serializeBoardAxes(settings),
        serializeBoardAxes({
          ...settings,
          canvas: { width: 700, height: 700 },
        }),
      ),
    ).toThrow("模版太小");
    const large = [
      {
        kind: "MODULE",
        id: "large",
        title: "大方框",
        frame: { x: 0, y: 0, width: 800, height: 32 },
      },
    ];
    expect(() =>
      boardSettingsChange(
        JSON.stringify(large),
        serializeBoardAxes(settings),
        serializeBoardAxes(next),
      ),
    ).toThrow("放不下");
  });

  it("migrates non-hour legacy focus boundaries to editable intervals without losing scheduled times", () => {
    const settings = configured();
    settings.timeline.focus = { startOffset: 75, endOffset: 165, scale: 4 };
    const steps = fixture("x"),
      before = readWorkflow(JSON.stringify(steps)).modules;
    const rows = timelineIntervals(settings);
    const next = withTimelineIntervalLength(settings, 1, rows[1].length + 30);
    expect(next.timeline.focus).toBeNull();
    expect(
      next.timeline.segments?.some((segment) => segment.endOffset === 75),
    ).toBe(true);
    expect(
      next.timeline.segments?.some((segment) => segment.endOffset === 165),
    ).toBe(true);
    const change = boardSettingsChange(
      JSON.stringify(steps),
      serializeBoardAxes(settings),
      serializeBoardAxes(next),
    );
    const after = readWorkflow(JSON.stringify(change.steps)).modules;
    for (const [index, module] of after.entries())
      expect(preciseOffset(module, index, next)).toBeCloseTo(
        preciseOffset(before[index], index, settings),
        10,
      );
  });
});
