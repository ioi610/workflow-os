import { describe, expect, it } from "vitest";
import {
  arrowPath,
  availablePosition,
  canvasArrows,
  clampPosition,
  clampSize,
  connectModuleEntries,
  connectionPreviewPath,
  disconnectModuleEntries,
  modulePosition,
  moduleFrame,
  moduleSize,
  minimumBoardSize,
  moveModuleEntries,
  removeModuleEntries,
  resizeModuleEntries,
  resizeBoardEntries,
  MIN_FRAME_SIZE,
} from "./canvas";
import { newModule, readWorkflow, validateContent } from "./workflows";
import type {
  ConnectionPorts,
  ConnectionSide,
  WorkflowModule,
} from "../../types";

describe("free canvas storage", () => {
  it("freezes old and existing module geometry in pixels when the board is resized", () => {
    const from = { width: 820, height: 620 },
      to = { width: 1600, height: 1000 };
    const legacy = {
      title: "旧工作",
      description: "原来的详细做法",
      position: { x: 0.1, y: 0.2 },
      size: { width: 0.2, height: 0.3 },
      nextModuleIds: ["module-3"],
      connectionPorts: { "module-3": { source: "top", target: "left" } },
      custom: { keep: true },
    };
    const detail = {
      kind: "DETAIL",
      id: "manual",
      title: "说明",
      items: [{ id: "i", text: "保留图片和原文" }],
      imageUrl: "https://example.com/original.png",
      position: { x: 0.1, y: 0.2 },
      size: { width: 0.3, height: 0.4 },
    };
    const framed = {
      ...newModule("已固定"),
      frame: { x: 500, y: 350, width: 64, height: 96 },
      position: { x: 0.7, y: 0.6 },
      size: { width: 0.4, height: 0.4 },
      custom: "unchanged",
    };
    const unnamedId = { kind: "MODULE", title: "还没有存编号的工作" };
    const raw = JSON.stringify([legacy, detail, framed, unnamedId]);
    const originalModules = readWorkflow(raw).modules;
    const resized = resizeBoardEntries(raw, from, to);
    const modules = readWorkflow(JSON.stringify(resized)).modules;
    expect(modules.map((module) => module.id)).toEqual(
      originalModules.map((module) => module.id),
    );
    modules.forEach((module, index) => {
      expect(moduleFrame(module, index, to)).toEqual(
        moduleFrame(originalModules[index], index, from),
      );
      expect(module).not.toHaveProperty("position");
      expect(module).not.toHaveProperty("size");
    });
    expect(resized[1]).toEqual(detail);
    expect(modules[0]).toMatchObject({
      frame: { x: 82, y: 124, width: 164, height: 186 },
      connectionPorts: legacy.connectionPorts,
      custom: legacy.custom,
    });
    expect(modules[1].frame).toEqual(framed.frame);
    expect(
      readWorkflow(JSON.stringify(resized)).details.find(
        (entry) => entry.title === legacy.title,
      )?.items[0].text,
    ).toBe(legacy.description);
    const again = resizeBoardEntries(JSON.stringify(resized), to, {
      width: 2000,
      height: 1400,
    });
    expect(
      readWorkflow(JSON.stringify(again)).modules.map((module) => module.frame),
    ).toEqual(modules.map((module) => module.frame));
    expect(modulePosition(modules[0], 0, to)).toEqual({
      x: 82 / 1600,
      y: 124 / 1000,
    });
    expect(moduleSize(modules[0], to)).toEqual({
      width: 164 / 1600,
      height: 186 / 1000,
    });
    expect(moduleSize(modules[0])).toEqual({
      width: 164 / 820,
      height: 186 / 820,
    });
  });

  it("rejects boards that cannot fit fixed frames and tolerates floating point bounds", () => {
    const board = { width: 2400, height: 1000 };
    const module = {
      ...newModule("边缘工作"),
      frame: { x: 2200, y: 100, width: 200.00000000001, height: 400.25 },
    };
    expect(minimumBoardSize([module], board)).toEqual({
      width: 2400,
      height: 501,
    });
    expect(minimumBoardSize([], board)).toEqual({ width: 320, height: 320 });
    const raw = JSON.stringify([module]);
    expect(
      resizeBoardEntries(raw, board, { width: 2400, height: 501 })[0].frame,
    ).toEqual(module.frame);
    expect(() =>
      resizeBoardEntries(raw, board, { width: 2399, height: 501 }),
    ).toThrow("放不下现有工作");
    expect(() =>
      resizeBoardEntries(raw, board, { width: 2400, height: 500 }),
    ).toThrow("放不下现有工作");
    const oldSmall = {
      ...newModule("小工作"),
      size: { width: 0.12, height: 0.12 },
      position: { x: 0, y: 0 },
    };
    const converted = resizeBoardEntries(
      JSON.stringify([oldSmall]),
      { width: 320, height: 320 },
      board,
    );
    expect((converted[0].frame as { width: number }).width).toBeCloseTo(38.4);
    expect((converted[0].frame as { height: number }).height).toBeCloseTo(38.4);
  });

  it("moves and resizes fixed frames with a 32 pixel minimum and preserves every unrelated field", () => {
    const board = { width: 2000, height: 1000 };
    const module = {
      ...newModule("固定工作"),
      frame: { x: 100, y: 200, width: 64, height: 96 },
      position: { x: 0.1, y: 0.1 },
      size: { width: 0.2, height: 0.2 },
      nextModuleIds: ["another"],
      connectionPorts: { another: { source: "left" } },
      custom: { workId: "keep" },
    };
    const detail = {
      kind: "DETAIL",
      id: "d",
      title: "固定工作",
      items: [{ id: "i", text: "手写做法" }],
    };
    const moved = moveModuleEntries(
      JSON.stringify([module, detail]),
      module.id,
      { x: 1, y: -1 },
      board,
    );
    expect(moved[0]).toMatchObject({
      id: module.id,
      frame: { x: 1936, y: 0, width: 64, height: 96 },
      nextModuleIds: module.nextModuleIds,
      connectionPorts: module.connectionPorts,
      custom: module.custom,
    });
    expect(moved[0]).not.toHaveProperty("position");
    expect(moved[0]).not.toHaveProperty("size");
    expect(moved[1]).toEqual(detail);
    const resized = resizeModuleEntries(
      JSON.stringify(moved),
      module.id,
      { width: 0.001, height: 2 },
      board,
    );
    expect(resized[0].frame).toEqual({
      x: 1936,
      y: 0,
      width: MIN_FRAME_SIZE,
      height: 1000,
    });
    expect(resized[1]).toEqual(detail);
    const min = { width: 32 / board.width, height: 32 / board.height };
    expect(clampSize({ width: 0.001, height: 0.001 }, undefined, min)).toEqual(
      min,
    );
    expect(clampPosition({ x: 1, y: 1 }, min, min)).toEqual({
      x: 1 - min.width,
      y: 1 - min.height,
    });
    const old = {
      ...newModule("未转换"),
      position: { x: 0.1, y: 0.2 },
      size: { width: 0.2, height: 0.3 },
    };
    const firstMove = moveModuleEntries(
      JSON.stringify([old]),
      old.id,
      { x: 0.2, y: 0.3 },
      board,
    );
    expect(firstMove[0].frame).toEqual({
      x: 400,
      y: 300,
      width: 400,
      height: 300,
    });
    expect(firstMove[0]).not.toHaveProperty("position");
    expect(firstMove[0]).not.toHaveProperty("size");
  });

  it("finds room using fixed pixel frame occupancy and the requested new module size", () => {
    const board = { width: 2000, height: 1000 };
    const existing = {
      ...newModule("长工作"),
      frame: { x: 80, y: 40, width: 1600, height: 100 },
    };
    const size = { width: 164 / board.width, height: 164 / board.height };
    const position = availablePosition([existing], board, size);
    const x = position.x * board.width,
      y = position.y * board.height;
    expect(x + 164 <= 72 || y + 164 <= 32 || x >= 1688 || y >= 148).toBe(true);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + 164).toBeLessThanOrEqual(board.width);
    expect(y + 164).toBeLessThanOrEqual(board.height);
  });

  it("anchors arrows and previews to small fixed frames without inflating normalized ratios to twelve percent", () => {
    const board = { width: 2400, height: 2400 },
      size = { width: 32 / 2400, height: 32 / 2400 };
    const points = (path: string) =>
      path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
    for (const ports of [
      undefined,
      { source: "right", target: "left" } as const,
    ]) {
      const arrow = points(
        arrowPath(
          { x: 0.1, y: 0.1 },
          { x: 0.6, y: 0.6 },
          size,
          size,
          board,
          ports,
        ),
      );
      expect(arrow[0]).toBeCloseTo(100 + size.width * 1000);
      expect(arrow[1]).toBeCloseTo(100 + size.height * 500);
    }
    const preview = points(
      connectionPreviewPath(
        { x: 0.1, y: 0.1 },
        size,
        { x: 0.9, y: 0.9 },
        "bottom",
        board,
      ),
    );
    expect(preview[0]).toBeCloseTo(100 + size.width * 500);
    expect(preview[1]).toBeCloseTo(100 + size.height * 1000);
    expect(preview.at(-2)).toBeCloseTo(900);
    expect(preview.at(-1)).toBeCloseTo(900);
  });

  it("chooses arrow anchor edges using the rendered rectangular board dimensions", () => {
    const square = { width: 0.2, height: 0.2 };
    const points = (path: string) =>
      path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
    const start = { x: 0.1, y: 0.1 };
    const belowRight = { x: 0.3, y: 0.7 };
    const normalVertical = points(arrowPath(start, belowRight, square, square));
    expect(normalVertical[0]).toBeCloseTo(200);
    expect(normalVertical[1]).toBeCloseTo(300);
    const wideHorizontal = points(
      arrowPath(start, belowRight, square, square, {
        width: 2000,
        height: 400,
      }),
    );
    expect(wideHorizontal[0]).toBeCloseTo(300);
    expect(wideHorizontal[1]).toBeCloseTo(200);
    expect(wideHorizontal[6]).toBeCloseTo(294);
    expect(wideHorizontal[7]).toBeCloseTo(800);
    const rightBelow = { x: 0.7, y: 0.3 };
    const normalHorizontal = points(
      arrowPath(start, rightBelow, square, square),
    );
    expect(normalHorizontal[0]).toBeCloseTo(300);
    expect(normalHorizontal[1]).toBeCloseTo(200);
    const tallVertical = points(
      arrowPath(start, rightBelow, square, square, {
        width: 400,
        height: 2000,
      }),
    );
    expect(tallVertical[0]).toBeCloseTo(200);
    expect(tallVertical[1]).toBeCloseTo(300);
    expect(tallVertical[6]).toBeCloseTo(800);
    expect(tallVertical[7]).toBeCloseTo(294);
    expect(arrowPath(start, belowRight)).toBe(
      arrowPath(start, belowRight, square, square, { width: 820, height: 820 }),
    );
  });

  it("reads old squares and independently bounds malformed width and height", () => {
    const module = newModule("A");
    expect(moduleSize(module)).toEqual({ width: 0.2, height: 0.2 });
    expect(
      moduleSize({ ...module, size: { width: 0.7, height: 0.12 } }),
    ).toEqual({
      width: 0.7,
      height: 0.12,
    });
    expect(moduleSize({ ...module, size: { width: 0, height: 2 } })).toEqual({
      width: 0.12,
      height: 1,
    });
    expect(
      moduleSize({ ...module, size: { width: NaN, height: Infinity } }),
    ).toEqual({ width: 0.2, height: 0.2 });
    expect(clampSize({ width: 0.8, height: 0.3 }, { x: 0.6, y: 0.7 })).toEqual({
      width: 0.4,
      height: 0.3,
    });
  });
  it("keeps the entire rectangle inside the board when reading or moving", () => {
    const module = {
      ...newModule("A"),
      size: { width: 0.6, height: 0.12 },
      position: { x: 0.9, y: -1 },
    };
    expect(modulePosition(module, 0)).toEqual({ x: 0.4, y: 0 });
    expect(modulePosition({ ...module, position: undefined }, 8)).toEqual({
      x: 0.4,
      y: 0.64,
    });
    const moved = readWorkflow(
      JSON.stringify(
        moveModuleEntries(JSON.stringify([module]), module.id, {
          x: 1,
          y: 1,
        }),
      ),
    ).modules[0];
    expect(moved.position).toEqual({ x: 0.4, y: 0.88 });
    expect(moved.size).toEqual(module.size);
    expect(clampPosition({ x: 1, y: 1 }, { width: 1, height: 1 })).toEqual({
      x: 0,
      y: 0,
    });
  });
  it("resizes each axis from the same corner without altering identities, arrows or written instructions", () => {
    const b = newModule("B");
    const a = {
      ...newModule("A"),
      position: { x: 0.6, y: 0.7 },
      nextModuleIds: [b.id],
      custom: { preserve: true },
    };
    const detail = {
      kind: "DETAIL",
      id: "written-a",
      title: "A",
      items: [{ id: "instruction-1", text: "手动编写的具体做法" }],
      imageUrl: "https://example.com/original.png",
    };
    const resized = resizeModuleEntries(JSON.stringify([a, detail, b]), a.id, {
      width: 0.9,
      height: 0.15,
    });
    expect(resized).toEqual([
      { ...a, size: { width: 0.4, height: 0.15 } },
      detail,
      b,
    ]);
    expect(
      readWorkflow(JSON.stringify(resized)).modules.map((module) => module.id),
    ).toEqual([a.id, b.id]);
    const shrunk = readWorkflow(
      JSON.stringify(
        resizeModuleEntries(JSON.stringify(resized), a.id, {
          width: -1,
          height: 0.25,
        }),
      ),
    ).modules[0];
    expect(shrunk.size).toEqual({ width: 0.12, height: 0.25 });
    expect(shrunk.position).toEqual(a.position);
    expect(() =>
      resizeModuleEntries(JSON.stringify(resized), "missing", {
        width: 0.3,
        height: 0.3,
      }),
    ).toThrow("重新打开");
  });
  it("places new squares clear of the actual widths and heights of existing rectangles", () => {
    const rectangle = {
      ...newModule("长条"),
      position: { x: 0.04, y: 0.04 },
      size: { width: 0.7, height: 0.2 },
    };
    const added = availablePosition([rectangle]);
    expect(added.x >= 0.75 || added.y >= 0.25).toBe(true);
    expect(added.x + 0.2).toBeLessThanOrEqual(1);
    expect(added.y + 0.2).toBeLessThanOrEqual(1);
  });
  it("anchors arrows on resized rectangle edges and retains old square defaults", () => {
    const points = (path: string) =>
      path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
    const horizontal = points(
      arrowPath(
        { x: 0.1, y: 0.1 },
        { x: 0.7, y: 0.2 },
        { width: 0.4, height: 0.12 },
        { width: 0.2, height: 0.5 },
      ),
    );
    expect(horizontal[0]).toBeCloseTo(500);
    expect(horizontal[1]).toBeCloseTo(160);
    expect(horizontal[6]).toBeCloseTo(694);
    expect(horizontal[7]).toBeCloseTo(450);
    const vertical = points(
      arrowPath(
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.6 },
        { width: 0.6, height: 0.12 },
        { width: 0.2, height: 0.3 },
      ),
    );
    expect(vertical[0]).toBeCloseTo(400);
    expect(vertical[1]).toBeCloseTo(220);
    expect(vertical[6]).toBeCloseTo(300);
    expect(vertical[7]).toBeCloseTo(594);
    expect(arrowPath({ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.4 })).toBe(
      arrowPath(
        { x: 0.1, y: 0.1 },
        { x: 0.6, y: 0.4 },
        { width: 0.2, height: 0.2 },
        { width: 0.2, height: 0.2 },
      ),
    );
  });
  it("retains arbitrary positions and arrows on a raw legacy module after reload", () => {
    const legacy = {
        title: "旧工作",
        description: "旧说明",
        custom: { keep: true },
      },
      b = newModule("B");
    const moved = JSON.stringify(
      moveModuleEntries(JSON.stringify([legacy, b]), "module-legacy-0", {
        x: 0.317,
        y: 0.421,
      }),
    );
    const linked = readWorkflow(
      JSON.stringify(connectModuleEntries(moved, "module-legacy-0", b.id)),
    );
    expect(linked.modules[0].position).toEqual({ x: 0.317, y: 0.421 });
    expect(linked.modules[0].nextModuleIds).toEqual([b.id]);
    expect(linked.details[0].items[0].text).toBe("旧说明");
    expect(linked.details[0].custom).toEqual({ keep: true });
  });
  it("keeps an empty legacy document and media when its module is removed", () => {
    const raw = JSON.stringify([
      {
        title: "未填写正文的旧工作",
        description: "",
        imageUrl: "https://example.com/old.png",
        custom: { preserved: true },
      },
    ]);
    const content = readWorkflow(
      JSON.stringify(removeModuleEntries(raw, "module-legacy-0")),
    );
    expect(content.modules).toEqual([]);
    expect(content.details[0]).toMatchObject({
      title: "未填写正文的旧工作",
      legacyEmpty: true,
      items: [],
      imageUrl: "https://example.com/old.png",
      custom: { preserved: true },
    });
    expect(validateContent(content)).toBeNull();
    expect(
      validateContent({
        modules: [],
        details: [{ ...content.details[0], legacyEmpty: false }],
      }),
    ).toContain("具体步骤");
  });
  it("moves to arbitrary fractional coordinates without changing creation order, identifiers or manual details", () => {
    const a = { ...newModule("A"), custom: { original: true } },
      b = newModule("B");
    const detail = {
      kind: "DETAIL",
      id: "d",
      title: "A",
      items: [{ id: "i", text: "手写做法" }],
      imageUrl: "https://example.com/a.png",
    };
    const moved = moveModuleEntries(JSON.stringify([a, detail, b]), a.id, {
      x: 0.317,
      y: 0.629,
    });
    expect(moved).toEqual([
      { ...a, position: { x: 0.317, y: 0.629 } },
      detail,
      b,
    ]);
    expect(
      modulePosition(readWorkflow(JSON.stringify(moved)).modules[0], 0),
    ).toEqual({ x: 0.317, y: 0.629 });
    expect(clampPosition({ x: 2, y: -1 })).toEqual({ x: 0.8, y: 0 });
  });
  it("persists arrows, supports explicit removal and rejects invalid endpoints", () => {
    const a = newModule("A"),
      b = newModule("B"),
      c = newModule("C");
    const raw = JSON.stringify([a, b, c]);
    const connected = JSON.stringify(connectModuleEntries(raw, a.id, c.id));
    expect(canvasArrows(readWorkflow(connected).modules)).toEqual([
      { sourceId: a.id, targetId: c.id },
    ]);
    expect(() => connectModuleEntries(raw, a.id, a.id)).toThrow("另一项");
    expect(() => connectModuleEntries(raw, a.id, "missing")).toThrow(
      "不在这里",
    );
    expect(() => connectModuleEntries(connected, a.id, c.id)).toThrow(
      "已经存在",
    );
    expect(
      canvasArrows(
        readWorkflow(
          JSON.stringify(disconnectModuleEntries(connected, a.id, c.id)),
        ).modules,
      ),
    ).toEqual([]);
    expect(arrowPath({ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.4 })).toMatch(
      /^M .* C /,
    );
  });
  it("deletes one module and its incoming arrows while retaining detailed lists and legacy stable identities", () => {
    const old = { title: "旧工作", description: "保留手写原文", custom: 9 };
    const a = newModule("A");
    const raw = JSON.stringify([
      old,
      { ...a, nextModuleIds: ["module-legacy-0"] },
      { title: "旧工作二", description: "另一份" },
    ]);
    const removed = readWorkflow(
      JSON.stringify(removeModuleEntries(raw, "module-legacy-0")),
    );
    expect(removed.modules.map((module) => module.id)).toEqual([
      a.id,
      "module-legacy-2",
    ]);
    expect(removed.modules[0].nextModuleIds).toEqual([]);
    expect(
      removed.details.find((detail) => detail.title === "旧工作")?.items[0]
        .text,
    ).toBe(old.description);
    expect(
      removed.details.find((detail) => detail.title === "旧工作")?.custom,
    ).toBe(9);
  });
});

describe("four-sided connections", () => {
  const coordinates = (path: string) =>
    path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
  const square = { width: 0.2, height: 0.2 };
  const board = { width: 820, height: 820 };
  const sides: ConnectionSide[] = ["top", "right", "bottom", "left"];
  const outward = (points: number[], side: ConnectionSide, first = true) => {
    const anchor = first ? points.slice(0, 2) : points.slice(-2);
    const control = first ? points.slice(2, 4) : points.slice(-4, -2);
    if (side === "left" || side === "right") {
      expect(control[1]).toBeCloseTo(anchor[1]);
      expect(
        (control[0] - anchor[0]) * (side === "right" ? 1 : -1),
      ).toBeGreaterThan(0);
    } else {
      expect(control[0]).toBeCloseTo(anchor[0]);
      expect(
        (control[1] - anchor[1]) * (side === "bottom" ? 1 : -1),
      ).toBeGreaterThan(0);
    }
  };

  it("stores the selected sides without changing identifiers, other connections or manual content", () => {
    const b = newModule("B"),
      c = newModule("C");
    const a = {
      ...newModule("A"),
      custom: { keep: true },
      nextModuleIds: [c.id],
      connectionPorts: { [c.id]: { source: "left", target: "bottom" } },
    };
    const detail = {
      kind: "DETAIL",
      id: "manual-b",
      title: "B",
      items: [{ id: "step-1", text: "保留手写步骤" }],
      imageUrl: "https://example.com/keep.png",
    };
    const raw = JSON.stringify([a, detail, b, c]);
    const selected: ConnectionPorts = { source: "top", target: "left" };
    const connected = connectModuleEntries(raw, a.id, b.id, selected);
    expect(connected).toEqual([
      {
        ...a,
        nextModuleIds: [c.id, b.id],
        connectionPorts: { ...a.connectionPorts, [b.id]: selected },
      },
      detail,
      b,
      c,
    ]);
    const moved = moveModuleEntries(JSON.stringify(connected), a.id, {
      x: 0.45,
      y: 0.35,
    });
    const resized = resizeModuleEntries(JSON.stringify(moved), a.id, {
      width: 0.4,
      height: 0.15,
    });
    expect(readWorkflow(JSON.stringify(resized)).modules[0]).toMatchObject({
      id: a.id,
      custom: a.custom,
      nextModuleIds: [c.id, b.id],
      connectionPorts: { ...a.connectionPorts, [b.id]: selected },
    });
    expect(resized.find((step) => step.id === detail.id)).toEqual(detail);
    expect(() =>
      connectModuleEntries(raw, a.id, b.id, {
        source: "middle",
      } as unknown as ConnectionPorts),
    ).toThrow("连线位置");
  });

  it("removes only disconnected or deleted target metadata and preserves existing records and details", () => {
    const b = newModule("B"),
      c = newModule("C");
    const a = {
      ...newModule("A"),
      nextModuleIds: [b.id, c.id],
      connectionPorts: {
        [b.id]: { source: "top" as const },
        [c.id]: { source: "right" as const },
      },
      custom: "unchanged",
    };
    const linkedC = {
      ...c,
      nextModuleIds: [b.id],
      connectionPorts: {
        [b.id]: { source: "bottom" as const, target: "left" as const },
      },
    };
    const detail = {
      kind: "DETAIL",
      id: "d",
      title: "B",
      items: [{ id: "i", text: "仍然保留" }],
      custom: 7,
    };
    const raw = JSON.stringify([a, detail, b, linkedC]);
    const disconnected = disconnectModuleEntries(raw, a.id, b.id);
    expect(disconnected[0]).toEqual({
      ...a,
      nextModuleIds: [c.id],
      connectionPorts: { [c.id]: a.connectionPorts[c.id] },
    });
    expect(disconnected.slice(1)).toEqual([detail, b, linkedC]);
    const removed = removeModuleEntries(raw, b.id);
    expect(removed).toEqual([
      {
        ...a,
        nextModuleIds: [c.id],
        connectionPorts: { [c.id]: a.connectionPorts[c.id] },
      },
      detail,
      { ...linkedC, nextModuleIds: [], connectionPorts: {} },
    ]);
  });

  it("keeps old arrow storage and path shapes unchanged and exposes only valid side metadata", () => {
    const a = newModule("A"),
      b = newModule("B"),
      c = newModule("C");
    const connected = connectModuleEntries(
      JSON.stringify([a, b, c]),
      a.id,
      b.id,
    );
    expect(connected[0]).not.toHaveProperty("connectionPorts");
    expect(
      disconnectModuleEntries(JSON.stringify(connected), a.id, b.id)[0],
    ).not.toHaveProperty("connectionPorts");
    const modules = [
      {
        ...a,
        nextModuleIds: [b.id, c.id],
        connectionPorts: {
          [b.id]: { source: "left", target: "top", unknown: true },
          [c.id]: { source: "right", target: "invalid" },
        },
      },
      b,
      c,
    ] as unknown as WorkflowModule[];
    expect(canvasArrows(modules)).toEqual([
      {
        sourceId: a.id,
        targetId: b.id,
        ports: { source: "left", target: "top" },
      },
      { sourceId: a.id, targetId: c.id },
    ]);
    const start = { x: 0.1, y: 0.1 },
      end = { x: 0.6, y: 0.4 };
    expect(arrowPath(start, end)).toBe("M 300 200 C 447 200, 447 500, 594 500");
    expect(arrowPath(start, end, square, square, board, undefined)).toBe(
      arrowPath(start, end),
    );
  });

  it("fixes all four source sides and both endpoint tangents regardless of the destination direction", () => {
    const anchors = {
      top: [500, 400],
      right: [600, 500],
      bottom: [500, 600],
      left: [400, 500],
    };
    for (const source of sides) {
      const points = coordinates(
        arrowPath(
          { x: 0.4, y: 0.4 },
          { x: 0.05, y: 0.05 },
          square,
          square,
          board,
          { source, target: "right" },
        ),
      );
      expect(points[0]).toBeCloseTo(anchors[source][0]);
      expect(points[1]).toBeCloseTo(anchors[source][1]);
      expect(points.at(-2)).toBeCloseTo(256);
      expect(points.at(-1)).toBeCloseTo(150);
      outward(points, source);
      outward(points, "right", false);
    }
    const targetAnchors = {
      top: [700, 594],
      right: [806, 700],
      bottom: [700, 806],
      left: [594, 700],
    };
    for (const target of sides) {
      const points = coordinates(
        arrowPath(
          { x: 0.05, y: 0.1 },
          { x: 0.6, y: 0.6 },
          square,
          square,
          board,
          { source: "right", target },
        ),
      );
      expect(points.at(-2)).toBeCloseTo(targetAnchors[target][0]);
      expect(points.at(-1)).toBeCloseTo(targetAnchors[target][1]);
      outward(points, "right");
      outward(points, target, false);
    }
  });

  it("automatically chooses the closest target port by actual pixel distance", () => {
    const start = { x: 0, y: 0 },
      end = { x: 0.4, y: 0.4 };
    const normal = coordinates(
      arrowPath(start, end, square, square, board, { source: "top" }),
    );
    expect(normal.at(-2)).toBeCloseTo(500);
    expect(normal.at(-1)).toBeCloseTo(394);
    const wide = coordinates(
      arrowPath(
        start,
        end,
        square,
        square,
        { width: 2000, height: 400 },
        { source: "top" },
      ),
    );
    expect(wide.at(-2)).toBeCloseTo(397);
    expect(wide.at(-1)).toBeCloseTo(500);
  });

  it("previews from every selected side and routes opposite-direction paths clear of their endpoint rectangles", () => {
    const start = { x: 0.4, y: 0.2 },
      end = { x: 0.4, y: 0.7 };
    const path = arrowPath(start, end, square, square, board, {
      source: "top",
      target: "bottom",
    });
    expect(path).toContain(" L ");
    const points = coordinates(path);
    outward(points, "top");
    outward(points, "bottom", false);
    const boxes = [
      { left: 400, right: 600, top: 200, bottom: 400 },
      { left: 400, right: 600, top: 700, bottom: 900 },
    ];
    for (let i = 0; i < points.length - 2; i += 2) {
      const [x, y, nextX, nextY] = points.slice(i, i + 4);
      for (let sample = 1; sample < 20; sample++) {
        const px = x + ((nextX - x) * sample) / 20,
          py = y + ((nextY - y) * sample) / 20;
        expect(
          boxes.some(
            (box) =>
              px > box.left + 0.0001 &&
              px < box.right - 0.0001 &&
              py > box.top + 0.0001 &&
              py < box.bottom - 0.0001,
          ),
        ).toBe(false);
      }
    }
    for (const source of sides) {
      const preview = coordinates(
        connectionPreviewPath(
          { x: 0.4, y: 0.4 },
          square,
          { x: 0.8, y: 0.7 },
          source,
          board,
        ),
      );
      outward(preview, source);
      expect(preview.at(-2)).toBeCloseTo(800);
      expect(preview.at(-1)).toBeCloseTo(700);
    }
    expect(
      connectionPreviewPath(
        { x: 0.4, y: 0.4 },
        square,
        { x: 0.8, y: 0.5 },
        "left",
        board,
      ),
    ).toContain(" L ");
  });

  it("keeps top-edge curves and routed corners within twelve physical pixels of the board", () => {
    for (const dimensions of [
      board,
      { width: 2400, height: 320 },
      { width: 320, height: 2400 },
    ]) {
      for (const side of ["top", "left", "bottom", "right"] as const) {
        const start =
          side === "top" || side === "bottom"
            ? { x: 0, y: side === "top" ? 0 : 0.8 }
            : { x: side === "left" ? 0 : 0.8, y: 0 };
        const end =
          side === "top" || side === "bottom"
            ? { x: 0.8, y: start.y }
            : { x: start.x, y: 0.8 };
        const points = coordinates(
          arrowPath(start, end, square, square, dimensions, {
            source: side,
            target: side,
          }),
        );
        for (let index = 0; index < points.length; index += 2) {
          expect(
            (points[index] * dimensions.width) / 1000,
          ).toBeGreaterThanOrEqual(-12.00001);
          expect((points[index] * dimensions.width) / 1000).toBeLessThanOrEqual(
            dimensions.width + 12.00001,
          );
          expect(
            (points[index + 1] * dimensions.height) / 1000,
          ).toBeGreaterThanOrEqual(-12.00001);
          expect(
            (points[index + 1] * dimensions.height) / 1000,
          ).toBeLessThanOrEqual(dimensions.height + 12.00001);
        }
        outward(points, side);
        outward(points, side, false);
      }
    }
  });
});
