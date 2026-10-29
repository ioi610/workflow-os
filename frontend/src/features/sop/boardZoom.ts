export const MIN_BOARD_SCALE = 0.05;
export const MAX_BOARD_SCALE = 2;
export type BoardZoomPreference = {
  version: 1;
  mode: "manual";
  scale: number;
};

export const boardZoomStorageKey = (workflowId: string) =>
  `workflow-os:board-zoom:${workflowId}`;

export function clampBoardScale(scale: number): number {
  return Math.max(
    MIN_BOARD_SCALE,
    Math.min(MAX_BOARD_SCALE, Number.isFinite(scale) ? scale : 1),
  );
}

export function stepBoardScale(
  scale: number,
  percentagePoints: number,
): number {
  return clampBoardScale(
    (Math.round(clampBoardScale(scale) * 100) + percentagePoints) / 100,
  );
}

export function readBoardZoom(value?: string | null): BoardZoomPreference {
  try {
    const parsed: unknown = value ? JSON.parse(value) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { version: 1, mode: "manual", scale: 1 };
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.version === 1 &&
      candidate.mode === "manual" &&
      typeof candidate.scale === "number" &&
      Number.isFinite(candidate.scale) &&
      candidate.scale >= MIN_BOARD_SCALE &&
      candidate.scale <= MAX_BOARD_SCALE
    )
      return { version: 1, mode: "manual", scale: candidate.scale };
  } catch {}
  return { version: 1, mode: "manual", scale: 1 };
}

export function serializeBoardZoom(preference: BoardZoomPreference): string {
  return JSON.stringify({
    version: 1,
    mode: "manual",
    scale: clampBoardScale(preference.scale),
  });
}
