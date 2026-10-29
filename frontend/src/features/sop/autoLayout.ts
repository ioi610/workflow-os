import type { ModuleFrame, Workflow, WorkflowStep } from "../../types";
import {
  boardSize,
  moduleAxisLabels,
  priorityTicks,
  readBoardAxes,
  type BoardAxis,
} from "./boardAxes";
import { moduleFrame } from "./canvas";
import { connectProcedure } from "./connectedProcedure";
import { generateWorkflow } from "./generatedWorkflow";
import { readSteps, readWorkflow } from "./workflows";

export type AutoLayoutPlan = {
  steps: WorkflowStep[];
  changed: number;
  unplaced: string[];
};

const GAP = 24;
const EPSILON = 1e-7;
type Range = { minimum: number; maximum: number };
const overlaps = (a: ModuleFrame, b: ModuleFrame, gap = 0) =>
  a.x < b.x + b.width + gap - EPSILON &&
  a.x + a.width + gap > b.x + EPSILON &&
  a.y < b.y + b.height + gap - EPSILON &&
  a.y + a.height + gap > b.y + EPSILON;
const moved = (a: ModuleFrame, b: ModuleFrame) =>
  Math.abs(a.x - b.x) > EPSILON || Math.abs(a.y - b.y) > EPSILON;

/** Plan positions locally; neither workflow content nor persistence is changed. */
export function autoLayoutWorkflow(
  workflow: Workflow,
  workflows: Workflow[],
): AutoLayoutPlan {
  const steps = readSteps(workflow.draft);
  const modules = readWorkflow(workflow.draft).modules;
  if (!modules.length) return { steps, changed: 0, unplaced: [] };
  const settings = readBoardAxes(workflow.boardSettings);
  const board = boardSize(settings);
  const order = connectProcedure(
    generateWorkflow(workflow, workflows),
  ).entryOrder;
  const originals = new Map(
    modules.map((module, index) => [
      module.id,
      moduleFrame(module, index, board),
    ]),
  );
  const labels = (frame: ModuleFrame) =>
    moduleAxisLabels(
      { x: frame.x / board.width, y: frame.y / board.height },
      { width: frame.width / board.width, height: frame.height / board.height },
      settings,
    );
  const originalLabels = new Map(
    order.map((id) => [id, labels(originals.get(id)!)]),
  );
  const timeAxis = settings.timeline.axis || "x";
  const priorityAxis = settings.priority.axis || "y";
  const priorities = priorityTicks(settings).map((tick) => tick.label);

  function range(id: string, axis: BoardAxis): Range {
    const frame = originals.get(id)!;
    const extent = axis === "x" ? "width" : "height";
    const travel = Math.max(0, board[extent] - frame[extent]);
    // Fixed board and box dimensions make this coordinate the exact original
    // time progress, including focused or non-linear timeline segments.
    if (settings.timeline.enabled && timeAxis === axis)
      return { minimum: frame[axis], maximum: frame[axis] };
    if (settings.priority.enabled && priorityAxis === axis && travel > 0) {
      const band = priorities.indexOf(originalLabels.get(id)!.priority!);
      if (band >= 0) {
        const minimum = (travel * band) / priorities.length;
        return {
          minimum,
          maximum: Math.max(
            minimum,
            band === priorities.length - 1
              ? travel
              : (travel * (band + 1)) / priorities.length - EPSILON,
          ),
        };
      }
    }
    return { minimum: 0, maximum: travel };
  }

  function candidates(id: string, axis: BoardAxis, occupied: ModuleFrame[]) {
    const frame = originals.get(id)!;
    const extent = axis === "x" ? "width" : "height";
    const allowed = range(id, axis);
    return [
      ...new Set([
        allowed.minimum,
        allowed.maximum,
        frame[axis],
        ...occupied.flatMap((other) => [
          other[axis] + other[extent] + GAP,
          other[axis] - frame[extent] - GAP,
        ]),
      ]),
    ]
      .filter((value) => value >= allowed.minimum && value <= allowed.maximum)
      .sort((a, b) => a - b)
      .filter(
        (value, index, values) => !index || value - values[index - 1] > EPSILON,
      );
  }
  const withinBoard = (frame: ModuleFrame) =>
    frame.x >= 0 &&
    frame.y >= 0 &&
    frame.x + frame.width <= board.width + EPSILON &&
    frame.y + frame.height <= board.height + EPSILON;
  const unplaced = new Set(
    order.filter((id) => !withinBoard(originals.get(id)!)),
  );
  let placed = new Map(originals);
  // When a box cannot move, its original position becomes an obstacle. Replan
  // earlier boxes as well so a newly retained box never gains a new overlap.
  for (let attempt = 0; attempt <= modules.length; attempt++) {
    placed = new Map([...unplaced].map((id) => [id, originals.get(id)!]));
    const failed: string[] = [];
    for (const id of order) {
      if (unplaced.has(id)) continue;
      const original = originals.get(id)!;
      const occupied = [...placed.values()];
      let selected: ModuleFrame | undefined;
      const xs = candidates(id, "x", occupied);
      const ys = candidates(id, "y", occupied);
      for (const y of ys) {
        for (const x of xs) {
          const frame = { ...original, x, y };
          if (!withinBoard(frame)) continue;
          const nextLabels = labels(frame),
            beforeLabels = originalLabels.get(id)!;
          if (
            nextLabels.time !== beforeLabels.time ||
            nextLabels.priority !== beforeLabels.priority
          )
            continue;
          if (!occupied.some((other) => overlaps(frame, other, GAP))) {
            selected = moved(frame, original) ? frame : original;
            break;
          }
        }
        if (selected) break;
      }
      if (!selected) failed.push(id);
      placed.set(id, selected || original);
    }
    if (!failed.length) break;
    failed.forEach((id) => unplaced.add(id));
  }
  const changedIds = order.filter((id) =>
    moved(originals.get(id)!, placed.get(id)!),
  );
  // Defensive whole-plan rollback: preserve every originally separate pair,
  // even if future candidate or constraint changes introduce a packing error.
  for (let first = 0; first < order.length; first++)
    for (let second = first + 1; second < order.length; second++) {
      const a = order[first],
        b = order[second];
      if (
        !overlaps(originals.get(a)!, originals.get(b)!) &&
        overlaps(placed.get(a)!, placed.get(b)!)
      )
        return {
          steps,
          changed: 0,
          unplaced: order.filter(
            (id) => unplaced.has(id) || changedIds.includes(id),
          ),
        };
    }
  if (!changedIds.length)
    return {
      steps,
      changed: 0,
      unplaced: order.filter((id) => unplaced.has(id)),
    };
  const changedSet = new Set(changedIds);
  let moduleIndex = 0;
  return {
    steps: steps.map((step) => {
      if (step.kind === "DETAIL") return step;
      const id = modules[moduleIndex++].id;
      return changedSet.has(id) ? { ...step, frame: placed.get(id)! } : step;
    }),
    changed: changedIds.length,
    unplaced: order.filter((id) => unplaced.has(id)),
  };
}
