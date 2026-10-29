import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOARD_AXES,
  DEFAULT_BOARD_SIZE,
  MAX_BOARD_SIZE,
  MIN_BOARD_SIZE,
  boardDisplaySize,
  boardSize,
  clampBoardSize,
  moduleAxisLabels,
  priorityTicks,
  readBoardAxes,
  serializeBoardAxes,
  timelineTicks,
  timelineRange,
  timelinePosition,
  timelineOffset,
  timelineIntervals,
  withTimelineIntervalLength,
  moveTimelineTick,
  validateBoardAxes,
  validateBoardSize,
  type BoardAxesSettings,
} from "./boardAxes";

const enabled = (): BoardAxesSettings => ({
  version: 1,
  timeline: { enabled: true, startMinute: 540, endMinute: 1080, axis: "x" },
  priority: { enabled: true, axis: "y" },
});

describe("a locally expanded timeline", () => {
  it("round-trips absent, null and valid focus settings while isolating invalid optional fields", () => {
    const base = {
      ...enabled(),
      canvas: { width: 1000, height: 700 },
      referenceCanvas: { width: 820, height: 820 },
    };
    expect(readBoardAxes(serializeBoardAxes(base))).toEqual(base);
    for (const focus of [
      null,
      { startOffset: 0, endOffset: 540, scale: 1 },
      { startOffset: 180, endOffset: 240, scale: 10 },
    ]) {
      const settings = { ...base, timeline: { ...base.timeline, focus } };
      const restored = readBoardAxes(serializeBoardAxes(settings));
      expect(restored).toEqual(settings);
      if (restored.timeline.focus) {
        restored.timeline.focus.scale = 2;
        expect(settings.timeline.focus?.scale).toBe(focus?.scale);
      }
    }
    for (const focus of [
      [],
      {},
      { startOffset: -1, endOffset: 50, scale: 2 },
      { startOffset: 30, endOffset: 30, scale: 2 },
      { startOffset: 30.5, endOffset: 60, scale: 2 },
      { startOffset: 0, endOffset: 541, scale: 2 },
      { startOffset: 30, endOffset: 60, scale: 0.9 },
      { startOffset: 30, endOffset: 60, scale: 11 },
      { startOffset: 30, endOffset: 60, scale: NaN },
      { startOffset: 30, endOffset: 60, scale: Infinity },
    ]) {
      const settings = { ...base, timeline: { ...base.timeline, focus } };
      expect(validateBoardAxes(settings)).toContain("时段");
      expect(() => serializeBoardAxes(settings as BoardAxesSettings)).toThrow(
        "时段",
      );
      expect(readBoardAxes(JSON.stringify(settings))).toEqual(base);
    }
    expect(
      readBoardAxes(
        JSON.stringify({
          ...base,
          canvas: { width: 0, height: 700 },
          referenceCanvas: { width: 820, height: 0 },
          timeline: {
            ...base.timeline,
            focus: { startOffset: 50, endOffset: 20, scale: 3 },
          },
        }),
      ),
    ).toEqual(enabled());
  });

  it("maps time offsets and positions reversibly with exact endpoints and identity fallbacks", () => {
    for (const focus of [
      undefined,
      null,
      { startOffset: 60, endOffset: 400, scale: 1 },
      { startOffset: 0, endOffset: 540, scale: 10 },
      { startOffset: 180, endOffset: 240, scale: 4 },
      { startOffset: 1, endOffset: 2, scale: 10 },
    ]) {
      const settings = {
        ...enabled(),
        timeline: { ...enabled().timeline, focus },
      };
      expect(timelineRange(settings)).toEqual({
        start: 540,
        end: 1080,
        duration: 540,
      });
      expect(timelinePosition(0, settings)).toBe(0);
      expect(timelinePosition(540, settings)).toBe(1);
      expect(timelineOffset(0, settings)).toBe(0);
      expect(timelineOffset(1, settings)).toBe(540);
      for (const offset of [0, 1, 59.125, 180, 210.75, 240, 539.9, 540])
        expect(
          timelineOffset(timelinePosition(offset, settings), settings),
        ).toBeCloseTo(offset, 10);
      for (const position of [0, 0.001, 0.1, 0.333333, 0.5, 0.999, 1])
        expect(
          timelinePosition(timelineOffset(position, settings), settings),
        ).toBeCloseTo(position, 12);
      expect(timelinePosition(-1, settings)).toBe(0);
      expect(timelinePosition(1000, settings)).toBe(1);
      expect(timelineOffset(-1, settings)).toBe(0);
      expect(timelineOffset(2, settings)).toBe(540);
      expect(timelinePosition(NaN, settings)).toBe(0);
      expect(timelineOffset(Infinity, settings)).toBe(0);
    }
  });

  it("expands the selected interval while compressing other intervals within the same board", () => {
    const settings = enabled();
    settings.timeline.focus = { startOffset: 180, endOffset: 240, scale: 4 };
    expect(timelinePosition(180, settings)).toBe(0.25);
    expect(
      timelinePosition(240, settings) - timelinePosition(180, settings),
    ).toBeCloseTo(1 / 3);
    expect(timelinePosition(180, settings)).toBeLessThan(180 / 540);
    expect(1 - timelinePosition(240, settings)).toBeLessThan(300 / 540);
    for (const axis of ["x", "y"] as const) {
      settings.timeline.axis = axis;
      settings.priority.axis = axis === "x" ? "y" : "x";
      for (const dimension of [32 / 2400, 0.2, 0.8])
        for (const [offset, time] of [
          [0, "09:00"],
          [150, "11:30"],
          [210, "12:30"],
          [540, "18:00"],
        ] as const) {
          const position = {
            x: 0.5 * (1 - dimension),
            y: 0.5 * (1 - dimension),
            [axis]: timelinePosition(offset, settings) * (1 - dimension),
          };
          expect(
            moduleAxisLabels(
              position,
              { width: dimension, height: dimension },
              settings,
            ),
          ).toEqual({ time, priority: "正常安排" });
        }
    }
  });

  it("uses offsets relative to the start across midnight on either axis", () => {
    const settings = enabled();
    settings.timeline = {
      enabled: true,
      startMinute: 1380,
      endMinute: 60,
      axis: "x",
      focus: { startOffset: 30, endOffset: 90, scale: 3 },
    };
    expect(timelineRange(settings)).toEqual({
      start: 1380,
      end: 1500,
      duration: 120,
    });
    for (const axis of ["x", "y"] as const) {
      settings.timeline.axis = axis;
      settings.priority.axis = axis === "x" ? "y" : "x";
      for (const [offset, time] of [
        [0, "23:00"],
        [30, "23:30"],
        [60, "次日 00:00"],
        [90, "次日 00:30"],
        [120, "次日 01:00"],
      ] as const) {
        const position = {
          x: 0,
          y: 0,
          [axis]: timelinePosition(offset, settings) * 0.8,
        };
        expect(
          moduleAxisLabels(position, { width: 0.2, height: 0.2 }, settings)
            .time,
        ).toBe(time);
      }
    }
  });

  it("keeps every full-hour tick and legacy focus boundary even on narrow views", () => {
    const settings = enabled();
    settings.timeline.focus = { startOffset: 75, endOffset: 165, scale: 10 };
    const ticks = timelineTicks(settings, 3);
    expect(ticks.map((tick) => tick.label)).toEqual([
      "09:00",
      "10:00",
      "10:15",
      "11:00",
      "11:45",
      "12:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
      "17:00",
      "18:00",
    ]);
    expect(timelineTicks(settings, 5)).toEqual(ticks);
    for (let index = 1; index < ticks.length; index++)
      expect(ticks[index].position).toBeGreaterThan(ticks[index - 1].position);
  });
});

describe("individual timeline interval lengths", () => {
  const threeHours = (axis: "x" | "y" = "x"): BoardAxesSettings => ({
    ...enabled(),
    timeline: { enabled: true, startMinute: 540, endMinute: 720, axis },
    priority: { enabled: true, axis: axis === "x" ? "y" : "x" },
    canvas:
      axis === "x" ? { width: 900, height: 700 } : { width: 700, height: 900 },
  });

  it("uses real clock hours with partial endpoints and retains non-hour legacy focus breaks", () => {
    const settings = enabled();
    settings.timeline.startMinute = 555;
    settings.timeline.endMinute = 760;
    expect(
      timelineIntervals(settings).map(
        ({ startOffset, endOffset, startLabel, endLabel }) => [
          startOffset,
          endOffset,
          startLabel,
          endLabel,
        ],
      ),
    ).toEqual([
      [0, 45, "09:15", "10:00"],
      [45, 105, "10:00", "11:00"],
      [105, 165, "11:00", "12:00"],
      [165, 205, "12:00", "12:40"],
    ]);
    settings.timeline.startMinute = 1410;
    settings.timeline.endMinute = 70;
    expect(
      timelineIntervals(settings).map((row) => [
        row.startOffset,
        row.endOffset,
        row.startLabel,
        row.endLabel,
      ]),
    ).toEqual([
      [0, 30, "23:30", "次日 00:00"],
      [30, 90, "次日 00:00", "次日 01:00"],
      [90, 100, "次日 01:00", "次日 01:10"],
    ]);
    settings.timeline = {
      ...enabled().timeline,
      focus: { startOffset: 75, endOffset: 165, scale: 4 },
    };
    const rows = timelineIntervals(settings);
    expect(rows.map((row) => row.endOffset)).toEqual([
      60, 75, 120, 165, 180, 240, 300, 360, 420, 480, 540,
    ]);
    const migrated = withTimelineIntervalLength(
      settings,
      1,
      rows[1].length + 30,
    );
    expect(migrated.timeline.focus).toBeNull();
    expect(
      migrated.timeline.segments?.map((segment) => segment.endOffset),
    ).toEqual(rows.map((row) => row.endOffset));
  });

  it("validates sorted positive nonoverlapping weights, preserves gaps, and gives explicit uniform segments precedence over focus", () => {
    const settings = threeHours();
    settings.timeline.focus = { startOffset: 30, endOffset: 90, scale: 4 };
    for (const segments of [null, []]) {
      const explicit = {
        ...settings,
        timeline: { ...settings.timeline, segments },
      };
      expect(timelinePosition(60, explicit)).toBeCloseTo(1 / 3);
      expect(readBoardAxes(serializeBoardAxes(explicit))).toEqual(explicit);
    }
    const segments = [
      { startOffset: 20, endOffset: 40, scale: 0.5 },
      { startOffset: 80, endOffset: 100, scale: 3 },
    ];
    const sparse = {
      ...settings,
      timeline: { ...settings.timeline, segments },
    };
    expect(readBoardAxes(serializeBoardAxes(sparse))).toEqual(sparse);
    for (const offset of [0, 10, 20, 30.5, 40, 60, 80, 90, 100, 179.5, 180])
      expect(
        timelineOffset(timelinePosition(offset, sparse), sparse),
      ).toBeCloseTo(offset, 10);
    const invalid = [
      {},
      [{ startOffset: -1, endOffset: 10, scale: 1 }],
      [{ startOffset: 10.5, endOffset: 20, scale: 1 }],
      [{ startOffset: 0, endOffset: 181, scale: 1 }],
      [{ startOffset: 0, endOffset: 10, scale: 0 }],
      [{ startOffset: 0, endOffset: 10, scale: 1e-7 }],
      [{ startOffset: 0, endOffset: 10, scale: 10001 }],
      [{ startOffset: 0, endOffset: 10, scale: NaN }],
      [
        { startOffset: 20, endOffset: 40, scale: 1 },
        { startOffset: 30, endOffset: 60, scale: 1 },
      ],
      [
        { startOffset: 60, endOffset: 70, scale: 1 },
        { startOffset: 20, endOffset: 30, scale: 1 },
      ],
      Array.from({ length: 97 }, (_, index) => ({
        startOffset: index,
        endOffset: index + 1,
        scale: 1,
      })),
    ];
    for (const value of invalid) {
      const candidate = {
        ...settings,
        timeline: { ...settings.timeline, segments: value },
      };
      expect(validateBoardAxes(candidate)).toContain("时间段");
      expect(() => serializeBoardAxes(candidate as BoardAxesSettings)).toThrow(
        "时间段",
      );
      expect(readBoardAxes(JSON.stringify(candidate))).toEqual(settings);
    }
    expect(
      validateBoardAxes({
        ...settings,
        timeline: {
          ...settings.timeline,
          segments: [
            { startOffset: 0, endOffset: 1, scale: 1e-6 },
            { startOffset: 1, endOffset: 2, scale: 10000 },
          ],
        },
      }),
    ).toBeNull();
  });

  it("changes one actual pixel length and grows only the timeline axis while retaining every other interval", () => {
    for (const axis of ["x", "y"] as const) {
      const settings = threeHours(axis),
        before = structuredClone(settings);
      const changed = withTimelineIntervalLength(settings, 1, 450);
      const dimensions = boardSize(changed);
      expect(dimensions[axis === "x" ? "width" : "height"]).toBe(1050);
      expect(dimensions[axis === "x" ? "height" : "width"]).toBe(700);
      for (const [index, expected] of [300, 450, 300].entries())
        expect(timelineIntervals(changed)[index].length).toBeCloseTo(
          expected,
          9,
        );
      expect(changed.timeline.focus).toBeNull();
      expect(changed.timeline.segments).toHaveLength(3);
      expect(settings).toEqual(before);
      expect(withTimelineIntervalLength(settings, 0, 300)).toBe(settings);
    }
  });

  it("moves an interior tick using only its two adjacent intervals and clamps both to 24px", () => {
    const settings = threeHours();
    const moved = moveTimelineTick(settings, 60, 100);
    expect(boardSize(moved)).toEqual(boardSize(settings));
    for (const [index, expected] of [400, 200, 300].entries())
      expect(timelineIntervals(moved)[index].length).toBeCloseTo(expected, 9);
    for (const [index, expected] of [576, 24, 300].entries())
      expect(
        timelineIntervals(moveTimelineTick(settings, 60, 10000))[index].length,
      ).toBeCloseTo(expected, 9);
    for (const [index, expected] of [300, 24, 576].entries())
      expect(
        timelineIntervals(moveTimelineTick(settings, 120, -10000))[index]
          .length,
      ).toBeCloseTo(expected, 9);
    expect(moveTimelineTick(settings, 60, 0)).toBe(settings);
  });

  it("allows the final tick to resize the last interval including a single-hour timeline and reports size limits", () => {
    const settings = threeHours();
    const longer = moveTimelineTick(settings, 180, 150);
    expect(boardSize(longer).width).toBe(1050);
    for (const [index, expected] of [300, 300, 450].entries())
      expect(timelineIntervals(longer)[index].length).toBeCloseTo(expected, 9);
    const single = {
      ...settings,
      timeline: { ...settings.timeline, endMinute: 600 },
    };
    expect(boardSize(moveTimelineTick(single, 60, 50)).width).toBe(950);
    expect(() => withTimelineIntervalLength(settings, 1, 23)).toThrow("24");
    expect(() => withTimelineIntervalLength(settings, 1, 2400)).toThrow(
      "320–2400",
    );
    expect(() => withTimelineIntervalLength(single, 0, 24)).toThrow("320–2400");
    expect(() => withTimelineIntervalLength(settings, -1, 300)).toThrow(
      "时间段",
    );
    expect(() => moveTimelineTick(settings, 0, 10)).toThrow("刻度");
    expect(() => moveTimelineTick(settings, 60, NaN)).toThrow("有效");
  });

  it("retains old sub-24px intervals until touched and rounds only the total canvas length", () => {
    const settings = enabled();
    settings.timeline = {
      enabled: true,
      startMinute: 30,
      endMinute: 29,
      axis: "x",
    };
    settings.canvas = { width: 320, height: 700 };
    const rows = timelineIntervals(settings);
    expect(rows[0].length).toBeLessThan(24);
    expect(() => moveTimelineTick(settings, rows[0].endOffset, 1)).toThrow(
      "相邻时间段太窄",
    );
    const changed = withTimelineIntervalLength(settings, 0, 24.4);
    expect(boardSize(changed).width).toBe(
      Math.round(320 - rows[0].length + 24.4),
    );
    for (const [index, row] of timelineIntervals(changed).entries())
      expect(
        Math.abs(row.length - (index === 0 ? 24.4 : rows[index].length)),
      ).toBeLessThan(1);
  });
});

describe("optional board axes", () => {
  it("reaches both travel endpoints and the midpoint for either axis and every movable module size", () => {
    for (const axis of ["x", "y"] as const) {
      const settings = enabled();
      settings.timeline.axis = axis;
      settings.priority.axis = axis === "x" ? "y" : "x";
      for (const size of [
        { width: 32 / 2400, height: 32 / 2400 },
        { width: 0.2, height: 0.2 },
        { width: 0.8, height: 0.8 },
        { width: 0.2, height: 0.8 },
      ])
        for (const [progress, time, priority] of [
          [0, "09:00", "优先做"],
          [0.5, "13:30", "正常安排"],
          [1, "18:00", "可以稍后"],
        ] as const) {
          const position = {
            x: progress * (1 - size.width),
            y: progress * (1 - size.height),
          };
          expect(moduleAxisLabels(position, size, settings)).toEqual({
            time,
            priority,
          });
        }
    }
  });

  it("uses three priority bands over the available travel for either axis and small or large modules", () => {
    for (const axis of ["x", "y"] as const) {
      const settings = enabled();
      settings.priority.axis = axis;
      settings.timeline.axis = axis === "x" ? "y" : "x";
      for (const dimension of [32 / 2400, 0.2, 0.8])
        for (const [progress, priority] of [
          [0, "优先做"],
          [1 / 3 - 1e-7, "优先做"],
          [1 / 3, "正常安排"],
          [0.5, "正常安排"],
          [2 / 3 - 1e-7, "正常安排"],
          [2 / 3, "可以稍后"],
          [1, "可以稍后"],
        ] as const) {
          const position = { x: 0, y: 0, [axis]: progress * (1 - dimension) };
          expect(
            moduleAxisLabels(
              position,
              { width: dimension, height: dimension },
              settings,
            ).priority,
          ).toBe(priority);
        }
    }
  });

  it("keeps real frame-to-normalized thirds stable when modules almost fill the board", () => {
    for (const axis of ["x", "y"] as const) {
      const settings = enabled();
      settings.priority.axis = axis;
      settings.timeline.axis = axis === "x" ? "y" : "x";
      for (const board of [320, 820, 2400])
        for (const fraction of [0.999, 0.99999999]) {
          const frameSize = board * fraction;
          const size = { width: frameSize / board, height: frameSize / board };
          for (const [third, exact, before] of [
            [1, "正常安排", "优先做"],
            [2, "可以稍后", "正常安排"],
          ] as const) {
            const origin = ((board - frameSize) * third) / 3 / board;
            expect(
              moduleAxisLabels({ x: 0, y: 0, [axis]: origin }, size, settings)
                .priority,
            ).toBe(exact);
            expect(
              moduleAxisLabels(
                { x: 0, y: 0, [axis]: origin - 2e-15 },
                size,
                settings,
              ).priority,
            ).toBe(before);
          }
        }
    }
  });

  it("recalculates travel progress when a module is resized and defines a full-board module at the start", () => {
    const settings = enabled();
    const position = { x: 0.1, y: 0.1 };
    expect(
      moduleAxisLabels(position, { width: 0.2, height: 0.2 }, settings),
    ).toEqual({
      time: "10:08",
      priority: "优先做",
    });
    expect(
      moduleAxisLabels(position, { width: 0.6, height: 0.8 }, settings),
    ).toEqual({
      time: "11:15",
      priority: "正常安排",
    });
    for (const size of [1, 1 - 5e-10, 1.2])
      for (const origin of [0, 0.1, 1, NaN, Infinity])
        expect(
          moduleAxisLabels(
            { x: origin, y: origin },
            { width: size, height: size },
            settings,
          ),
        ).toEqual({
          time: "09:00",
          priority: "优先做",
        });
  });

  it("clamps travel endpoints and safely handles nonfinite positions or malformed module sizes", () => {
    const settings = enabled();
    for (const dimension of [32 / 2400, 0.2, 0.8]) {
      const size = { width: dimension, height: dimension };
      for (const origin of [-1e-8, -2, NaN, Infinity, -Infinity])
        expect(
          moduleAxisLabels({ x: origin, y: origin }, size, settings),
        ).toEqual({
          time: "09:00",
          priority: "优先做",
        });
      for (const origin of [1 - dimension + 1e-8, 2])
        expect(
          moduleAxisLabels({ x: origin, y: origin }, size, settings),
        ).toEqual({
          time: "18:00",
          priority: "可以稍后",
        });
    }
    for (const dimension of [NaN, Infinity, -Infinity])
      expect(
        moduleAxisLabels(
          { x: 0.4, y: 0.4 },
          { width: dimension, height: dimension },
          settings,
        ),
      ).toEqual({
        time: "13:30",
        priority: "正常安排",
      });
    expect(
      moduleAxisLabels({ x: 0.5, y: 0.5 }, { width: -1, height: -1 }, settings),
    ).toEqual({
      time: "13:30",
      priority: "正常安排",
    });
  });

  it("maps overnight times across the full movable travel on either axis", () => {
    for (const axis of ["x", "y"] as const) {
      const settings = enabled();
      settings.timeline = {
        enabled: true,
        axis,
        startMinute: 1380,
        endMinute: 60,
      };
      settings.priority.axis = axis === "x" ? "y" : "x";
      for (const dimension of [32 / 2400, 0.2, 0.8])
        for (const [progress, time] of [
          [0, "23:00"],
          [0.25, "23:30"],
          [0.5, "次日 00:00"],
          [0.75, "次日 00:30"],
          [1, "次日 01:00"],
        ] as const) {
          const position = { x: 0, y: 0, [axis]: progress * (1 - dimension) };
          expect(
            moduleAxisLabels(
              position,
              { width: dimension, height: dimension },
              settings,
            ).time,
          ).toBe(time);
        }
    }
  });

  it("keeps absent board dimensions implicit and round-trips explicit rectangles and resets", () => {
    const original = enabled();
    const read = readBoardAxes(serializeBoardAxes(original));
    expect(read.canvas).toBeUndefined();
    expect(JSON.parse(serializeBoardAxes(read))).not.toHaveProperty("canvas");
    expect(boardSize(read)).toEqual(DEFAULT_BOARD_SIZE);
    const size = boardSize(read);
    size.width = 1000;
    expect(DEFAULT_BOARD_SIZE.width).toBe(820);
    for (const canvas of [
      { width: 1800, height: 600 },
      { width: 480, height: 1800 },
      { width: 820, height: 820 },
    ]) {
      const settings = { ...original, canvas };
      const restored = readBoardAxes(serializeBoardAxes(settings));
      expect(restored).toEqual(settings);
      expect(boardSize(restored)).toEqual(canvas);
      restored.canvas!.height = 1000;
      expect(settings.canvas.height).toBe(canvas.height);
    }
  });

  it("drops only malformed board dimensions when reading but rejects them when writing", () => {
    const original = enabled();
    for (const canvas of [
      null,
      [],
      {},
      { width: 319, height: 820 },
      { width: 820, height: 2401 },
      { width: 820.5, height: 820 },
      { width: "820", height: 820 },
    ]) {
      const settings = { ...original, canvas };
      expect(readBoardAxes(JSON.stringify(settings))).toEqual(original);
      expect(validateBoardAxes(settings)).toContain("宽和高");
      expect(validateBoardSize(canvas)).toContain("整数");
      expect(() => serializeBoardAxes(settings as BoardAxesSettings)).toThrow(
        "宽和高",
      );
    }
    expect(
      validateBoardSize({ width: MIN_BOARD_SIZE, height: MAX_BOARD_SIZE }),
    ).toBeNull();
    expect(clampBoardSize({ width: 100.5, height: 3000.2 })).toEqual({
      width: MIN_BOARD_SIZE,
      height: MAX_BOARD_SIZE,
    });
    expect(clampBoardSize({ width: 1000.4, height: 999.7 })).toEqual({
      width: 1000,
      height: 1000,
    });
    expect(clampBoardSize({ width: NaN, height: Infinity })).toEqual(
      DEFAULT_BOARD_SIZE,
    );
  });

  it("fits normal boards by width and retains readable height for wide boards using internal scroll", () => {
    expect(boardDisplaySize(DEFAULT_BOARD_SIZE, 1000)).toEqual({
      width: 820,
      height: 820,
      scale: 1,
    });
    expect(boardDisplaySize(DEFAULT_BOARD_SIZE, 410)).toEqual({
      width: 410,
      height: 410,
      scale: 0.5,
    });
    const wide = boardDisplaySize({ width: 2400, height: 320 }, 360);
    expect(wide).toEqual({ width: 1800, height: 240, scale: 0.75 });
    expect(wide.width).toBeGreaterThan(360);
    expect(boardDisplaySize({ width: 820, height: 2400 }, 410)).toEqual({
      width: 410,
      height: 1200,
      scale: 0.5,
    });
    const narrowViewport = boardDisplaySize({ width: 2400, height: 320 }, 200);
    expect(narrowViewport.height).toBe(200);
    expect(narrowViewport.scale).toBeLessThanOrEqual(1);
    expect(boardDisplaySize(DEFAULT_BOARD_SIZE, 0)).toEqual({
      width: 0,
      height: 0,
      scale: 0,
    });
  });

  it("preserves board dimensions while axes are changed without affecting coordinate-derived labels", () => {
    const settings = { ...enabled(), canvas: { width: 1600, height: 400 } };
    settings.timeline.axis = "y";
    settings.priority.axis = "x";
    const changed = readBoardAxes(serializeBoardAxes(settings));
    expect(changed.canvas).toEqual(settings.canvas);
    expect(
      moduleAxisLabels(
        { x: 0.1, y: 0.6 },
        { width: 0.2, height: 0.2 },
        changed,
      ),
    ).toEqual({ time: "15:45", priority: "优先做" });
    changed.timeline.enabled = false;
    expect(readBoardAxes(serializeBoardAxes(changed)).canvas).toEqual(
      settings.canvas,
    );
  });

  it("fills old axis settings and infers a single missing direction without changing enabled choices", () => {
    const legacy = {
      version: 1,
      timeline: { enabled: true, startMinute: 540, endMinute: 1080 },
      priority: { enabled: true },
    };
    expect(validateBoardAxes(legacy)).toBeNull();
    expect(readBoardAxes(JSON.stringify(legacy))).toEqual(enabled());
    expect(JSON.parse(serializeBoardAxes(legacy as BoardAxesSettings))).toEqual(
      enabled(),
    );
    expect(
      readBoardAxes(
        JSON.stringify({
          ...legacy,
          timeline: { ...legacy.timeline, axis: "y" },
        }),
      ),
    ).toEqual({
      ...enabled(),
      timeline: { ...enabled().timeline, axis: "y" },
      priority: { enabled: true, axis: "x" },
    });
    expect(
      readBoardAxes(
        JSON.stringify({
          ...legacy,
          priority: { enabled: false, axis: "x" },
        }),
      ),
    ).toEqual({
      ...enabled(),
      timeline: { ...enabled().timeline, axis: "y" },
      priority: { enabled: false, axis: "x" },
    });
  });

  it("rejects invalid or colliding enabled directions while retaining disabled-axis choices", () => {
    for (const axis of [null, "z", 0, false])
      expect(
        validateBoardAxes({
          ...enabled(),
          timeline: { ...enabled().timeline, axis },
        }),
      ).toContain("横向或纵向");
    const same = {
      ...enabled(),
      priority: { enabled: true, axis: "x" as const },
    };
    expect(validateBoardAxes(same)).toContain("分别");
    expect(readBoardAxes(JSON.stringify(same))).toEqual(DEFAULT_BOARD_AXES);
    same.priority.enabled = false;
    expect(validateBoardAxes(same)).toBeNull();
    expect(readBoardAxes(serializeBoardAxes(same))).toEqual(same);
    expect(
      moduleAxisLabels({ x: 0, y: 0.75 }, { width: 0.2, height: 0.2 }, same),
    ).toEqual({ time: "09:00" });
  });

  it("maps swapped axes to their independent movable ranges", () => {
    const settings = enabled();
    settings.timeline.axis = "y";
    settings.priority.axis = "x";
    expect(
      moduleAxisLabels(
        { x: 0.1, y: 0.6 },
        { width: 0.2, height: 0.2 },
        settings,
      ),
    ).toEqual({
      time: "15:45",
      priority: "优先做",
    });
    expect(
      moduleAxisLabels(
        { x: 0.6, y: 0.1 },
        { width: 0.2, height: 0.2 },
        settings,
      ),
    ).toEqual({
      time: "10:08",
      priority: "可以稍后",
    });
    expect(
      moduleAxisLabels(
        { x: 0.1, y: 0.1 },
        { width: 0.6, height: 0.8 },
        settings,
      ),
    ).toEqual({
      time: "13:30",
      priority: "优先做",
    });
    settings.timeline.startMinute = 1380;
    settings.timeline.endMinute = 60;
    expect(
      moduleAxisLabels(
        { x: 0.1, y: 0.4 },
        { width: 0.2, height: 0.2 },
        settings,
      ).time,
    ).toBe("次日 00:00");
    expect(timelineTicks(settings, 3)).toEqual([
      { position: 0, label: "23:00" },
      { position: 0.5, label: "次日 00:00" },
      { position: 1, label: "次日 01:00" },
    ]);
  });

  it("keeps old and malformed settings off without sharing mutable defaults", () => {
    for (const raw of [undefined, null, "", "{", "null", "[]", "{}", "42"])
      expect(readBoardAxes(raw)).toEqual(DEFAULT_BOARD_AXES);
    expect(readBoardAxes(JSON.stringify({ ...enabled(), version: 2 }))).toEqual(
      DEFAULT_BOARD_AXES,
    );
    expect(
      readBoardAxes(
        JSON.stringify({
          ...enabled(),
          timeline: { enabled: true, startMinute: 120, endMinute: 120 },
        }),
      ),
    ).toEqual(DEFAULT_BOARD_AXES);
    const first = readBoardAxes();
    first.timeline.enabled = true;
    first.priority.enabled = true;
    expect(readBoardAxes()).toEqual(DEFAULT_BOARD_AXES);
    expect(DEFAULT_BOARD_AXES.timeline.enabled).toBe(false);
    expect(DEFAULT_BOARD_AXES.priority.enabled).toBe(false);
  });

  it("validates integer clock times, rejects equal endpoints and round-trips configuration", () => {
    const settings = enabled();
    expect(validateBoardAxes(settings)).toBeNull();
    expect(readBoardAxes(serializeBoardAxes(settings))).toEqual(settings);
    expect(validateBoardAxes({ ...settings, version: 3 })).not.toBeNull();
    expect(
      validateBoardAxes({ ...settings, priority: { enabled: "yes" } }),
    ).not.toBeNull();
    for (const startMinute of [-1, 1440, 540.5, NaN, Infinity])
      expect(
        validateBoardAxes({
          ...settings,
          timeline: { ...settings.timeline, startMinute },
        }),
      ).toContain("00:00");
    const equal = {
      ...settings,
      timeline: { ...settings.timeline, endMinute: 540 },
    };
    expect(validateBoardAxes(equal)).toContain("不能相同");
    expect(() => serializeBoardAxes(equal)).toThrow("不能相同");
    const overnight = {
      ...settings,
      timeline: { ...settings.timeline, startMinute: 1380, endMinute: 60 },
    };
    expect(validateBoardAxes(overnight)).toBeNull();
    expect(readBoardAxes(serializeBoardAxes(overnight))).toEqual(overnight);
  });

  it("rounds minutes from travel progress while retaining overnight endpoint ticks", () => {
    const settings = enabled();
    settings.timeline.endMinute = 541;
    expect(
      moduleAxisLabels(
        { x: 0.49 * 0.8, y: 0 },
        { width: 0.2, height: 0.2 },
        settings,
      ).time,
    ).toBe("09:00");
    expect(
      moduleAxisLabels(
        { x: 0.5 * 0.8, y: 0 },
        { width: 0.2, height: 0.2 },
        settings,
      ).time,
    ).toBe("09:01");
    settings.timeline.startMinute = 1380;
    settings.timeline.endMinute = 60;
    expect(timelineTicks(settings, 3)).toEqual([
      { position: 0, label: "23:00" },
      { position: 0.5, label: "次日 00:00" },
      { position: 1, label: "次日 01:00" },
    ]);
    expect(timelineTicks(settings, 2)).toEqual(timelineTicks(settings, 3));
  });

  it("always includes every actual clock hour plus partial start and end ticks", () => {
    const settings = enabled();
    const hours = [
      "09:00",
      "10:00",
      "11:00",
      "12:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
      "17:00",
      "18:00",
    ];
    expect(timelineTicks(settings, 5).map((tick) => tick.label)).toEqual(hours);
    expect(timelineTicks(settings, 3).map((tick) => tick.label)).toEqual(hours);
    for (const [start, end] of [
      [551, 1087],
      [1439, 0],
      [120, 119],
    ] as const) {
      settings.timeline.startMinute = start;
      settings.timeline.endMinute = end;
      const ticks = timelineTicks(settings);
      expect(ticks[0].position).toBe(0);
      expect(ticks.at(-1)!.position).toBe(1);
      const { end: unwrappedEnd } = timelineRange(settings);
      const fullHours =
        Math.floor((unwrappedEnd - 1) / 60) - Math.floor(start / 60);
      expect(ticks.length).toBe(fullHours + 2);
      expect(
        ticks.every(
          (tick, index) =>
            index === 0 || tick.position > ticks[index - 1].position,
        ),
      ).toBe(true);
    }
  });

  it("keeps a nearby full hour visible beside a partial endpoint", () => {
    const settings = enabled();
    settings.timeline.startMinute = 541;
    settings.timeline.endMinute = 1081;
    const ticks = timelineTicks(settings, 5);
    expect(ticks[0]).toEqual({ position: 0, label: "09:01" });
    expect(ticks.at(-1)).toEqual({ position: 1, label: "18:01" });
    expect(ticks.map((tick) => tick.label)).toContain("18:00");
  });

  it("keeps either axis independently optional and places priority ticks in band centers", () => {
    const settings = enabled();
    settings.timeline.enabled = false;
    expect(
      moduleAxisLabels({ x: 0, y: 0 }, { width: 0.2, height: 0.2 }, settings),
    ).toEqual({ priority: "优先做" });
    expect(timelineTicks(settings)).toEqual([]);
    expect(priorityTicks(settings)).toEqual([
      { position: 1 / 6, label: "优先做" },
      { position: 0.5, label: "正常安排" },
      { position: 5 / 6, label: "可以稍后" },
    ]);
    settings.timeline.enabled = true;
    settings.priority.enabled = false;
    expect(
      moduleAxisLabels({ x: 0, y: 0 }, { width: 0.2, height: 0.2 }, settings),
    ).toEqual({ time: "09:00" });
    expect(priorityTicks(settings)).toEqual([]);
    expect(
      moduleAxisLabels(
        { x: 0, y: 0 },
        { width: 0.2, height: 0.2 },
        DEFAULT_BOARD_AXES,
      ),
    ).toEqual({});
  });
});
