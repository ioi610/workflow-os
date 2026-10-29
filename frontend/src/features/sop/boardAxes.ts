import type { Position, Size } from "./canvas";

export type BoardAxis = "x" | "y";
export type BoardSize = { width: number; height: number };
export const DEFAULT_BOARD_SIZE: BoardSize = { width: 820, height: 820 };
export const MIN_BOARD_SIZE = 320;
export const MAX_BOARD_SIZE = 2400;
export type TimelineFocus = {
  startOffset: number;
  endOffset: number;
  scale: number;
};
export type TimelineSegment = TimelineFocus;
export type TimelineInterval = {
  startOffset: number;
  endOffset: number;
  startLabel: string;
  endLabel: string;
  length: number;
};
export const MIN_TIMELINE_INTERVAL_LENGTH = 24;
export type BoardAxesSettings = {
  version: 1;
  timeline: {
    enabled: boolean;
    startMinute: number;
    endMinute: number;
    axis?: BoardAxis;
    focus?: TimelineFocus | null;
    segments?: TimelineSegment[] | null;
  };
  priority: { enabled: boolean; axis?: BoardAxis };
  canvas?: BoardSize;
  referenceCanvas?: BoardSize;
};
export type BoardAxisTick = { position: number; label: string };

export const DEFAULT_BOARD_AXES: BoardAxesSettings = {
  version: 1,
  timeline: { enabled: false, startMinute: 540, endMinute: 1080, axis: "x" },
  priority: { enabled: false, axis: "y" },
};

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const validMinute = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 1439;

export function validateBoardSize(size: unknown): string | null {
  const value = object(size);
  if (
    !value ||
    [value.width, value.height].some(
      (edge) =>
        typeof edge !== "number" ||
        !Number.isInteger(edge) ||
        edge < MIN_BOARD_SIZE ||
        edge > MAX_BOARD_SIZE,
    )
  )
    return `流程图的宽和高需要是 ${MIN_BOARD_SIZE}–${MAX_BOARD_SIZE} 之间的整数。`;
  return null;
}

export function clampBoardSize(size: BoardSize): BoardSize {
  const edge = (value: number | undefined) =>
    Math.max(
      MIN_BOARD_SIZE,
      Math.min(
        MAX_BOARD_SIZE,
        Math.round(Number.isFinite(value) ? value! : 820),
      ),
    );
  return { width: edge(size?.width), height: edge(size?.height) };
}

export function boardSize(settings: BoardAxesSettings): BoardSize {
  return settings.canvas && !validateBoardSize(settings.canvas)
    ? { ...settings.canvas }
    : { ...DEFAULT_BOARD_SIZE };
}

export function boardDisplaySize(
  size: BoardSize,
  availableWidth: number,
): BoardSize & { scale: number } {
  const logical = clampBoardSize(size);
  const available = Number.isFinite(availableWidth)
    ? Math.max(0, availableWidth)
    : logical.width;
  const scale = Math.min(
    1,
    Math.max(
      available / logical.width,
      Math.min(240, available) / logical.height,
    ),
  );
  return {
    width: logical.width * scale,
    height: logical.height * scale,
    scale,
  };
}

const opposite = (axis: BoardAxis): BoardAxis => (axis === "x" ? "y" : "x");
function directions(settings: BoardAxesSettings) {
  const timeline = settings.timeline.axis;
  const priority = settings.priority.axis;
  return {
    timeline: timeline ?? (priority ? opposite(priority) : "x"),
    priority: priority ?? (timeline ? opposite(timeline) : "y"),
  };
}

export function timelineRange(settings: BoardAxesSettings) {
  const start = settings.timeline.startMinute;
  const end =
    settings.timeline.endMinute +
    (settings.timeline.endMinute < start ? 1440 : 0);
  return { start, end, duration: end - start };
}

function validateFocus(focus: unknown, duration: number): string | null {
  if (focus === undefined || focus === null) return null;
  const value = object(focus);
  if (
    !value ||
    !Number.isInteger(value.startOffset) ||
    !Number.isInteger(value.endOffset) ||
    (value.startOffset as number) < 0 ||
    (value.endOffset as number) <= (value.startOffset as number) ||
    (value.endOffset as number) > duration ||
    typeof value.scale !== "number" ||
    !Number.isFinite(value.scale) ||
    value.scale < 1 ||
    value.scale > 10
  )
    return "请选择时间范围内的一个时段，拉宽比例需要在 1–10 倍之间。";
  return null;
}

function validateSegments(segments: unknown, duration: number): string | null {
  if (segments === undefined || segments === null) return null;
  if (!Array.isArray(segments) || segments.length > 96)
    return "时间段最多设置 96 段。";
  let previousEnd = 0;
  for (const segment of segments) {
    const value = object(segment);
    if (
      !value ||
      !Number.isInteger(value.startOffset) ||
      !Number.isInteger(value.endOffset) ||
      (value.startOffset as number) < previousEnd ||
      (value.endOffset as number) <= (value.startOffset as number) ||
      (value.endOffset as number) > duration ||
      typeof value.scale !== "number" ||
      !Number.isFinite(value.scale) ||
      value.scale < 1e-6 ||
      value.scale > 10000
    )
      return "时间段需要按先后排列且不能重叠，长度比例需要是有效的正数。";
    previousEnd = value.endOffset as number;
  }
  return null;
}

export function validateBoardAxes(settings: unknown): string | null {
  const value = object(settings);
  const timeline = object(value?.timeline),
    priority = object(value?.priority);
  if (
    value?.version !== 1 ||
    !timeline ||
    !priority ||
    typeof timeline.enabled !== "boolean" ||
    typeof priority.enabled !== "boolean"
  )
    return "时间和优先顺序的设置有误，请重新设置。";
  if (!validMinute(timeline.startMinute) || !validMinute(timeline.endMinute))
    return "时间需要在 00:00 到 23:59 之间。";
  if (timeline.startMinute === timeline.endMinute)
    return "开始和结束时间不能相同。";
  const focusError = validateFocus(
    timeline.focus,
    timelineRange(settings as BoardAxesSettings).duration,
  );
  if (focusError) return focusError;
  const segmentsError = validateSegments(
    timeline.segments,
    timelineRange(settings as BoardAxesSettings).duration,
  );
  if (segmentsError) return segmentsError;
  for (const axis of [timeline.axis, priority.axis])
    if (axis !== undefined && axis !== "x" && axis !== "y")
      return "请选择横向或纵向。";
  const axes = directions(settings as BoardAxesSettings);
  if (timeline.enabled && priority.enabled && axes.timeline === axes.priority)
    return "时间和优先级需要分别放在横向和纵向。";
  if (value.canvas !== undefined) {
    const error = validateBoardSize(value.canvas);
    if (error) return error;
  }
  if (value.referenceCanvas !== undefined)
    return validateBoardSize(value.referenceCanvas);
  return null;
}

function copy(settings: BoardAxesSettings): BoardAxesSettings {
  const axes = directions(settings);
  return {
    version: 1,
    timeline: {
      enabled: settings.timeline.enabled,
      startMinute: settings.timeline.startMinute,
      endMinute: settings.timeline.endMinute,
      axis: axes.timeline,
      ...(settings.timeline.focus !== undefined
        ? {
            focus: settings.timeline.focus
              ? { ...settings.timeline.focus }
              : null,
          }
        : {}),
      ...(settings.timeline.segments !== undefined
        ? {
            segments:
              settings.timeline.segments?.map((segment) => ({ ...segment })) ??
              null,
          }
        : {}),
    },
    priority: { enabled: settings.priority.enabled, axis: axes.priority },
    ...(settings.canvas ? { canvas: { ...settings.canvas } } : {}),
    ...(settings.referenceCanvas
      ? { referenceCanvas: { ...settings.referenceCanvas } }
      : {}),
  };
}

export function readBoardAxes(value?: string | null): BoardAxesSettings {
  try {
    let parsed: unknown = value ? JSON.parse(value) : null;
    let candidate = object(parsed);
    if (
      candidate?.canvas !== undefined &&
      validateBoardSize(candidate.canvas)
    ) {
      const { canvas: _invalidCanvas, ...withoutCanvas } = candidate;
      parsed = withoutCanvas;
      candidate = withoutCanvas;
    }
    if (
      candidate?.referenceCanvas !== undefined &&
      validateBoardSize(candidate.referenceCanvas)
    ) {
      const { referenceCanvas: _invalidReference, ...withoutReference } =
        candidate;
      parsed = withoutReference;
      candidate = withoutReference;
    }
    let timeline = object(candidate?.timeline);
    if (
      timeline?.focus !== undefined &&
      validateFocus(
        timeline.focus,
        validMinute(timeline.startMinute) && validMinute(timeline.endMinute)
          ? timeline.endMinute +
              (timeline.endMinute < timeline.startMinute ? 1440 : 0) -
              timeline.startMinute
          : 0,
      )
    ) {
      const { focus: _invalidFocus, ...withoutFocus } = timeline;
      parsed = { ...candidate, timeline: withoutFocus };
      candidate = object(parsed);
      timeline = withoutFocus;
    }
    if (
      timeline?.segments !== undefined &&
      validateSegments(
        timeline.segments,
        validMinute(timeline.startMinute) && validMinute(timeline.endMinute)
          ? timeline.endMinute +
              (timeline.endMinute < timeline.startMinute ? 1440 : 0) -
              timeline.startMinute
          : 0,
      )
    ) {
      const { segments: _invalidSegments, ...withoutSegments } = timeline;
      parsed = { ...candidate, timeline: withoutSegments };
    }
    if (validateBoardAxes(parsed) === null)
      return copy(parsed as BoardAxesSettings);
  } catch {}
  return copy(DEFAULT_BOARD_AXES);
}

export function serializeBoardAxes(settings: BoardAxesSettings): string {
  const error = validateBoardAxes(settings);
  if (error) throw new Error(error);
  return JSON.stringify(copy(settings));
}

const withinBoard = (value: number) => Math.max(0, Math.min(1, value));
const axisTravel = (dimension: number) =>
  1 - withinBoard(Number.isFinite(dimension) ? dimension : 0.2);
function axisProgress(origin: number, dimension: number): number {
  const travel = axisTravel(dimension);
  return travel <= 1e-9
    ? 0
    : withinBoard((Number.isFinite(origin) ? origin : 0) / travel);
}

function timelinePieces(settings: BoardAxesSettings): TimelineSegment[] {
  const { duration } = timelineRange(settings);
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const explicit = settings.timeline.segments;
  const focus = settings.timeline.focus;
  const overrides =
    explicit !== undefined && !validateSegments(explicit, duration)
      ? explicit || []
      : focus && !validateFocus(focus, duration)
        ? [focus]
        : [];
  const pieces: TimelineSegment[] = [];
  let previousEnd = 0;
  for (const segment of overrides) {
    if (segment.startOffset > previousEnd)
      pieces.push({
        startOffset: previousEnd,
        endOffset: segment.startOffset,
        scale: 1,
      });
    pieces.push({ ...segment });
    previousEnd = segment.endOffset;
  }
  if (previousEnd < duration)
    pieces.push({ startOffset: previousEnd, endOffset: duration, scale: 1 });
  return pieces;
}

export function timelinePosition(
  offset: number,
  settings: BoardAxesSettings,
): number {
  const { duration } = timelineRange(settings);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const value = Math.max(
    0,
    Math.min(duration, Number.isFinite(offset) ? offset : 0),
  );
  if (value === 0 || value === duration) return value / duration;
  const pieces = timelinePieces(settings);
  const total = pieces.reduce(
    (sum, piece) => sum + (piece.endOffset - piece.startOffset) * piece.scale,
    0,
  );
  const weighted = pieces.reduce(
    (sum, piece) =>
      sum +
      Math.max(0, Math.min(value, piece.endOffset) - piece.startOffset) *
        piece.scale,
    0,
  );
  return total > 0 ? withinBoard(weighted / total) : value / duration;
}

export function timelineOffset(
  position: number,
  settings: BoardAxesSettings,
): number {
  const { duration } = timelineRange(settings);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const value = withinBoard(Number.isFinite(position) ? position : 0);
  if (value === 0 || value === 1) return value * duration;
  const pieces = timelinePieces(settings);
  const total = pieces.reduce(
    (sum, piece) => sum + (piece.endOffset - piece.startOffset) * piece.scale,
    0,
  );
  let remaining = value * total;
  for (const piece of pieces) {
    const length = (piece.endOffset - piece.startOffset) * piece.scale;
    if (remaining <= length)
      return Math.max(
        0,
        Math.min(duration, piece.startOffset + remaining / piece.scale),
      );
    remaining -= length;
  }
  return duration;
}

export function timelineIntervals(
  settings: BoardAxesSettings,
): TimelineInterval[] {
  if (validateBoardAxes(settings)) return [];
  const { start, end, duration } = timelineRange(settings);
  const boundaries = new Set([0, duration]);
  for (
    let minute = Math.floor(start / 60) * 60 + 60;
    minute < end;
    minute += 60
  )
    boundaries.add(minute - start);
  for (const piece of timelinePieces(settings)) {
    boundaries.add(piece.startOffset);
    boundaries.add(piece.endOffset);
  }
  const offsets = [...boundaries].sort((a, b) => a - b);
  const board = boardSize(settings),
    axis = directions(settings).timeline;
  const length = axis === "x" ? board.width : board.height;
  return offsets.slice(0, -1).map((startOffset, index) => {
    const endOffset = offsets[index + 1];
    return {
      startOffset,
      endOffset,
      startLabel: clockLabel(start + startOffset),
      endLabel: clockLabel(start + endOffset),
      length:
        (timelinePosition(endOffset, settings) -
          timelinePosition(startOffset, settings)) *
        length,
    };
  });
}

function settingsWithIntervalLengths(
  settings: BoardAxesSettings,
  rows: TimelineInterval[],
  lengths: number[],
): BoardAxesSettings {
  const total = lengths.reduce((sum, value) => sum + value, 0);
  const rounded = Math.round(total);
  if (
    !Number.isFinite(total) ||
    rounded < MIN_BOARD_SIZE ||
    rounded > MAX_BOARD_SIZE
  )
    throw new Error(
      `时间轴总长度需要在 ${MIN_BOARD_SIZE}–${MAX_BOARD_SIZE} 像素之间。`,
    );
  const weights = lengths.map(
    (length, index) =>
      length / (rows[index].endOffset - rows[index].startOffset),
  );
  const factor = Math.max(1, 1e-6 / Math.min(...weights));
  const segments = rows.map((row, index) => ({
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    scale: weights[index] * factor,
  }));
  const next: BoardAxesSettings = {
    ...settings,
    timeline: { ...settings.timeline, focus: null, segments },
    canvas: {
      ...boardSize(settings),
      [directions(settings).timeline === "x" ? "width" : "height"]: rounded,
    },
  };
  const error = validateBoardAxes(next);
  if (error) throw new Error(error);
  return next;
}

export function withTimelineIntervalLength(
  settings: BoardAxesSettings,
  index: number,
  length: number,
): BoardAxesSettings {
  const rows = timelineIntervals(settings);
  if (!Number.isInteger(index) || !rows[index])
    throw new Error("这个时间段已经变了，请重新打开设置。");
  if (!Number.isFinite(length) || length < MIN_TIMELINE_INTERVAL_LENGTH)
    throw new Error(
      `每个时间段至少需要 ${MIN_TIMELINE_INTERVAL_LENGTH} 像素。`,
    );
  if (Math.abs(rows[index].length - length) < 1e-9) return settings;
  return settingsWithIntervalLengths(
    settings,
    rows,
    rows.map((row, current) => (current === index ? length : row.length)),
  );
}

export function moveTimelineTick(
  settings: BoardAxesSettings,
  offset: number,
  deltaPx: number,
): BoardAxesSettings {
  if (!Number.isFinite(deltaPx)) throw new Error("请输入有效的时间段长度。");
  const rows = timelineIntervals(settings);
  const index = rows.findIndex((row) => row.endOffset === offset);
  if (index < 0) throw new Error("只能调整现有时间刻度。");
  if (Math.abs(deltaPx) < 1e-9) return settings;
  if (index === rows.length - 1)
    return withTimelineIntervalLength(
      settings,
      index,
      Math.max(MIN_TIMELINE_INTERVAL_LENGTH, rows[index].length + deltaPx),
    );
  const total = rows[index].length + rows[index + 1].length;
  if (total < MIN_TIMELINE_INTERVAL_LENGTH * 2 - 1e-9)
    throw new Error("相邻时间段太窄，请先在设置中调宽到每段至少 24 像素。");
  const left = Math.max(
    MIN_TIMELINE_INTERVAL_LENGTH,
    Math.min(
      total - MIN_TIMELINE_INTERVAL_LENGTH,
      rows[index].length + deltaPx,
    ),
  );
  const lengths = rows.map((row) => row.length);
  lengths[index] = left;
  lengths[index + 1] = total - left;
  return settingsWithIntervalLengths(settings, rows, lengths);
}

function clockLabel(minute: number): string {
  const clock = minute % 1440;
  const hours = String(Math.floor(clock / 60)).padStart(2, "0");
  const minutes = String(clock % 60).padStart(2, "0");
  return `${minute >= 1440 ? "次日 " : ""}${hours}:${minutes}`;
}

const priorities = ["优先做", "正常安排", "可以稍后"] as const;

export function moduleAxisLabels(
  position: Position,
  size: Size,
  settings: BoardAxesSettings,
): { time?: string; priority?: string } {
  if (validateBoardAxes(settings)) return {};
  const progress = {
    x: axisProgress(position.x, size.width),
    y: axisProgress(position.y, size.height),
  };
  const axes = directions(settings);
  const labels: { time?: string; priority?: string } = {};
  if (settings.timeline.enabled) {
    const { start } = timelineRange(settings);
    const clockMinute =
      start + timelineOffset(progress[axes.timeline], settings);
    labels.time = clockLabel(Math.round(Math.round(clockMinute * 1e9) / 1e9));
  }
  if (settings.priority.enabled) {
    const travel = axisTravel(axes.priority === "x" ? size.width : size.height);
    // Frame normalization can amplify coordinate rounding on nearly full boards.
    const tolerance = travel > 1e-9 ? (Number.EPSILON * 8) / travel : 0;
    labels.priority =
      priorities[
        Math.min(2, Math.floor(progress[axes.priority] * 3 + tolerance))
      ];
  }
  return labels;
}

export function timelineTicks(
  settings: BoardAxesSettings,
  _maxTicks?: number,
): BoardAxisTick[] {
  if (validateBoardAxes(settings) || !settings.timeline.enabled) return [];
  const rows = timelineIntervals(settings);
  if (!rows.length) return [];
  const { start } = timelineRange(settings);
  const offsets = [
    ...rows.map((row) => row.startOffset),
    rows.at(-1)!.endOffset,
  ];
  return offsets.map((offset) => ({
    position: timelinePosition(offset, settings),
    label: clockLabel(start + offset),
  }));
}

export function priorityTicks(settings: BoardAxesSettings): BoardAxisTick[] {
  if (validateBoardAxes(settings) || !settings.priority.enabled) return [];
  return priorities.map((label, index) => ({
    position: (index + 0.5) / 3,
    label,
  }));
}
