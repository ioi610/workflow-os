import { describe, expect, it } from "vitest";
import {
  MAX_BOARD_SCALE,
  MIN_BOARD_SCALE,
  boardZoomStorageKey,
  clampBoardScale,
  readBoardZoom,
  serializeBoardZoom,
  stepBoardScale,
} from "./boardZoom";

describe("local board zoom", () => {
  it("defaults to manual 100 percent and retires stored automatic fit preferences", () => {
    for (const raw of [
      undefined,
      null,
      "",
      '{"version":1,"mode":"fit"}',
      '{"version":1,"mode":"fit","scale":0.5}',
    ])
      expect(readBoardZoom(raw)).toEqual({
        version: 1,
        mode: "manual",
        scale: 1,
      });
  });

  it("keeps manual scales within 5–200 percent", () => {
    expect(clampBoardScale(0)).toBe(MIN_BOARD_SCALE);
    expect(clampBoardScale(-1)).toBe(MIN_BOARD_SCALE);
    expect(clampBoardScale(5)).toBe(MAX_BOARD_SCALE);
    expect(clampBoardScale(0.12345)).toBe(0.12345);
    expect(clampBoardScale(NaN)).toBe(1);
    expect(clampBoardScale(Infinity)).toBe(1);
  });

  it("steps by percentage points rather than multiplying the existing zoom", () => {
    expect(stepBoardScale(0.5, 10)).toBe(0.6);
    expect(stepBoardScale(0.5, -10)).toBe(0.4);
    expect(stepBoardScale(0.2345, 10)).toBe(0.33);
    expect(stepBoardScale(0.1, -10)).toBe(MIN_BOARD_SCALE);
    expect(stepBoardScale(1.99, 10)).toBe(MAX_BOARD_SCALE);
    expect(stepBoardScale(2, -10)).toBe(1.9);
  });

  it("preserves existing manual preferences under the same per-workflow storage key", () => {
    expect(serializeBoardZoom({ version: 1, mode: "manual", scale: 1 })).toBe(
      '{"version":1,"mode":"manual","scale":1}',
    );
    for (const scale of [MIN_BOARD_SCALE, 0.655, 1, MAX_BOARD_SCALE]) {
      const preference = {
        version: 1 as const,
        mode: "manual" as const,
        scale,
      };
      expect(readBoardZoom(serializeBoardZoom(preference))).toEqual(preference);
    }
    expect(boardZoomStorageKey("first")).toBe("workflow-os:board-zoom:first");
    expect(boardZoomStorageKey("first")).not.toBe(
      boardZoomStorageKey("second"),
    );
  });

  it("falls back to manual 100 percent for corrupt, unsupported, or out-of-range storage", () => {
    for (const raw of [
      undefined,
      null,
      "",
      "{",
      "null",
      "[]",
      "42",
      "{}",
      '{"version":2,"mode":"manual","scale":1}',
      '{"version":1,"mode":"unknown","scale":1}',
      '{"version":1,"mode":"manual"}',
      '{"version":1,"mode":"manual","scale":"1"}',
      '{"version":1,"mode":"manual","scale":null}',
      '{"version":1,"mode":"manual","scale":0.049}',
      '{"version":1,"mode":"manual","scale":2.001}',
      '{"version":1,"mode":"manual","scale":1e999}',
    ])
      expect(readBoardZoom(raw)).toEqual({
        version: 1,
        mode: "manual",
        scale: 1,
      });
    const first = readBoardZoom();
    first.scale = 0.5;
    expect(readBoardZoom()).not.toBe(first);
  });
});
