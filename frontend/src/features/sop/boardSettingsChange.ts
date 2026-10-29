import type { WorkflowStep } from "../../types";
import { moduleFrame, resizeBoardEntries } from "./canvas";
import { readWorkflow } from "./workflows";
import {
  boardSize,
  readBoardAxes,
  serializeBoardAxes,
  timelineOffset,
  timelinePosition,
  type BoardAxis,
} from "./boardAxes";

function progress(origin: number, size: number, length: number) {
  const travel = 1 - Math.max(0, Math.min(1, size / length));
  return travel <= 1e-9
    ? 0
    : Math.max(0, Math.min(1, origin / length / travel));
}
function originAt(position: number, size: number, length: number) {
  const travel = Math.max(0, length - size);
  if (travel / length <= 1e-9 && position > 1e-9)
    throw new Error("模版太小，无法保留已安排的时间和优先级，请调大模版。");
  return Math.max(0, Math.min(travel, position * travel));
}

export function boardSettingsChange(
  draft: string,
  previous: string | null | undefined,
  next: string,
): { steps: WorkflowStep[]; boardSettings: string } {
  const before = readBoardAxes(previous);
  const after = readBoardAxes(next);
  const oldSize = boardSize(before);
  const newSize = boardSize(after);
  const resized =
    oldSize.width !== newSize.width || oldSize.height !== newSize.height;
  const remap =
    before.timeline.enabled &&
    after.timeline.enabled &&
    before.timeline.axis === after.timeline.axis &&
    before.timeline.startMinute === after.timeline.startMinute &&
    before.timeline.endMinute === after.timeline.endMinute &&
    JSON.stringify([
      before.timeline.segments,
      before.timeline.segments === undefined ? before.timeline.focus : null,
    ]) !==
      JSON.stringify([
        after.timeline.segments,
        after.timeline.segments === undefined ? after.timeline.focus : null,
      ]);
  // Timeline edits may shrink through old positions; remap first, then validate.
  let steps =
    resized || remap
      ? resizeBoardEntries(draft, oldSize, remap ? oldSize : newSize)
      : (JSON.parse(draft) as WorkflowStep[]);
  if (remap) {
    const modules = readWorkflow(draft).modules;
    const axis = before.timeline.axis || "x";
    const otherAxis: BoardAxis = axis === "x" ? "y" : "x";
    const extent = axis === "x" ? "width" : "height";
    const otherExtent = axis === "x" ? "height" : "width";
    const preservePriority =
      before.priority.enabled &&
      after.priority.enabled &&
      before.priority.axis === after.priority.axis &&
      after.priority.axis === otherAxis;
    let index = 0;
    steps = steps.map((step) => {
      if (step.kind === "DETAIL") return step;
      const frame = moduleFrame(modules[index], index++, oldSize);
      const originalOffset = timelineOffset(
        progress(frame[axis], frame[extent], oldSize[extent]),
        before,
      );
      const next = {
        ...frame,
        [axis]: originAt(
          timelinePosition(originalOffset, after),
          frame[extent],
          newSize[extent],
        ),
      };
      if (preservePriority && oldSize[otherExtent] !== newSize[otherExtent])
        next[otherAxis] = originAt(
          progress(frame[otherAxis], frame[otherExtent], oldSize[otherExtent]),
          frame[otherExtent],
          newSize[otherExtent],
        );
      if (
        next.x + next.width > newSize.width + 1e-6 ||
        next.y + next.height > newSize.height + 1e-6
      )
        throw new Error("时间轴太短，放不下现有工作方框，请保留更长的长度。");
      return { ...step, frame: next };
    });
  }
  const reference =
    before.referenceCanvas || (resized ? oldSize : after.referenceCanvas);
  return {
    steps,
    boardSettings: serializeBoardAxes({
      ...after,
      ...(reference ? { referenceCanvas: reference } : {}),
    }),
  };
}
