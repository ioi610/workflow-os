import type {
  ConnectionPorts,
  ModuleFrame,
  WorkflowDetailDocument,
  WorkflowModule,
  WorkflowStep,
} from "../../types";
import {
  DEFAULT_BOARD_AXES,
  MAX_BOARD_SIZE,
  MIN_BOARD_SIZE,
  serializeBoardAxes,
} from "./boardAxes";
import { normalizeName } from "./workflows";

export type TextDiagramNode = {
  id: string;
  name: string;
  details: string[];
  nextIds: string[];
};

export type TextDiagram = { title: string; nodes: TextDiagramNode[] };

type Cell = { column: number; row: number; band: number };
const MAX_NODES = 60;
const ROWS_PER_LEVEL = 6;
const COLUMNS_PER_BAND = 9;
const BOX = { width: 200, height: 96 };
const GAP = { x: 48, y: 32, band: 96 };
const MARGIN = 32;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reject a partial response instead of saving a diagram with missing prose or edges. */
function validateDiagram(value: unknown): asserts value is TextDiagram {
  if (
    !record(value) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    !Array.isArray(value.nodes) ||
    value.nodes.length < 1 ||
    value.nodes.length > MAX_NODES
  )
    throw new Error(
      "生成结果不完整，需要包含流程名称和 1–60 项工作，请重新生成。",
    );

  const ids = new Set<string>(),
    names = new Set<string>();
  for (const node of value.nodes) {
    if (
      !record(node) ||
      typeof node.id !== "string" ||
      !node.id.trim() ||
      typeof node.name !== "string" ||
      !normalizeName(node.name) ||
      !Array.isArray(node.details) ||
      node.details.length > 100 ||
      !Array.isArray(node.nextIds)
    )
      throw new Error("有一项工作的名称、具体做法或箭头不完整，请重新生成。");
    if (ids.has(node.id) || names.has(normalizeName(node.name)))
      throw new Error("生成结果中有重复的工作名称或编号，请重新生成。");
    for (const detail of node.details)
      if (typeof detail !== "string" || !detail.trim())
        throw new Error("生成结果中有一条做法为空或格式不对，请重新生成。");
    ids.add(node.id);
    names.add(normalizeName(node.name));
  }
  for (const node of value.nodes) {
    const targets = new Set<string>();
    for (const target of node.nextIds) {
      if (
        typeof target !== "string" ||
        !ids.has(target) ||
        target === node.id ||
        targets.has(target)
      )
        throw new Error(
          "生成结果中有箭头重复或没有连到另一项工作，请重新生成。",
        );
      targets.add(target);
    }
  }
}

/** Condense cycles so every dependency outside a cycle advances to a later level. */
function graphLevels(nodes: TextDiagramNode[]): number[][] {
  const indexes = new Map(nodes.map((node, index) => [node.id, index])),
    edges = nodes.map((node) => node.nextIds.map((id) => indexes.get(id)!)),
    visited = new Map<number, number>(),
    low = new Map<number, number>(),
    stack: number[] = [],
    stacked = new Set<number>(),
    components: number[][] = [];
  let nextIndex = 0;
  function visit(node: number) {
    visited.set(node, nextIndex);
    low.set(node, nextIndex++);
    stack.push(node);
    stacked.add(node);
    for (const target of edges[node]) {
      if (!visited.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node)!, low.get(target)!));
      } else if (stacked.has(target))
        low.set(node, Math.min(low.get(node)!, visited.get(target)!));
    }
    if (low.get(node) !== visited.get(node)) return;
    const members: number[] = [];
    let member: number;
    do {
      member = stack.pop()!;
      stacked.delete(member);
      members.push(member);
    } while (member !== node);
    components.push(members.sort((a, b) => a - b));
  }
  nodes.forEach((_, index) => {
    if (!visited.has(index)) visit(index);
  });
  components.sort((a, b) => a[0] - b[0]);
  const componentOf = new Map(
      components.flatMap((members, index) =>
        members.map((member) => [member, index] as const),
      ),
    ),
    outgoing = components.map(() => new Set<number>()),
    incoming = components.map(() => new Set<number>());
  edges.forEach((targets, node) => {
    const source = componentOf.get(node)!;
    for (const target of targets) {
      const destination = componentOf.get(target)!;
      if (source === destination) continue;
      outgoing[source].add(destination);
      incoming[destination].add(source);
    }
  });
  const ranks = components.map(() => 0),
    remaining = incoming.map((sources) => sources.size),
    ready = components.flatMap((_, index) => (remaining[index] ? [] : [index]));
  while (ready.length) {
    ready.sort((a, b) => components[a][0] - components[b][0]);
    const source = ready.shift()!;
    for (const target of outgoing[source]) {
      ranks[target] = Math.max(ranks[target], ranks[source] + 1);
      if (--remaining[target] === 0) ready.push(target);
    }
  }

  const levels: number[][] = [],
    rows = new Map<number, number>();
  for (let rank = 0; rank <= Math.max(...ranks); rank++) {
    const atRank = components.flatMap((_, index) =>
      ranks[index] === rank ? [index] : [],
    );
    const preferredRow = (component: number) => {
      const predecessors = [...incoming[component]].flatMap(
        (source) => components[source],
      );
      return predecessors.length
        ? predecessors.reduce((sum, node) => sum + rows.get(node)!, 0) /
            predecessors.length
        : components[component][0];
    };
    atRank.sort(
      (a, b) =>
        preferredRow(a) - preferredRow(b) ||
        components[a][0] - components[b][0],
    );
    const members = atRank.flatMap((component) => components[component]);
    members.forEach((node, index) => rows.set(node, index % ROWS_PER_LEVEL));
    levels.push(members);
  }
  return levels;
}

function layout(nodes: TextDiagramNode[]) {
  const cells = new Map<number, Cell>();
  let column = 0;
  for (const members of graphLevels(nodes)) {
    members.forEach((node, index) => {
      const unwrapped = column + Math.floor(index / ROWS_PER_LEVEL);
      cells.set(node, {
        column: unwrapped % COLUMNS_PER_BAND,
        row: index % ROWS_PER_LEVEL,
        band: Math.floor(unwrapped / COLUMNS_PER_BAND),
      });
    });
    column += Math.ceil(members.length / ROWS_PER_LEVEL);
  }
  const bandRows = Array.from(
    { length: Math.ceil(column / COLUMNS_PER_BAND) },
    (_, band) =>
      Math.max(
        ...[...cells.values()]
          .filter((cell) => cell.band === band)
          .map((cell) => cell.row + 1),
      ),
  );
  let y = MARGIN;
  const bandTops = bandRows.map((rows) => {
    const top = y;
    y += rows * BOX.height + (rows - 1) * GAP.y + GAP.band;
    return top;
  });
  const nominalWidth =
      2 * MARGIN +
      (Math.min(column, COLUMNS_PER_BAND) - 1) * (BOX.width + GAP.x) +
      BOX.width,
    nominalHeight = y - GAP.band + MARGIN,
    scale = Math.min(1, MAX_BOARD_SIZE / Math.max(nominalWidth, nominalHeight)),
    canvas = {
      width: Math.max(
        MIN_BOARD_SIZE,
        Math.min(MAX_BOARD_SIZE, Math.ceil(nominalWidth * scale)),
      ),
      height: Math.max(
        MIN_BOARD_SIZE,
        Math.min(MAX_BOARD_SIZE, Math.ceil(nominalHeight * scale)),
      ),
    },
    frames = nodes.map((_, index): ModuleFrame => {
      const cell = cells.get(index)!;
      return {
        x: (MARGIN + cell.column * (BOX.width + GAP.x)) * scale,
        y: (bandTops[cell.band] + cell.row * (BOX.height + GAP.y)) * scale,
        width: BOX.width * scale,
        height: BOX.height * scale,
      };
    });
  return { cells, frames, canvas };
}

function ports(source: Cell, target: Cell): ConnectionPorts {
  if (target.band !== source.band)
    return target.band > source.band
      ? { source: "bottom", target: "top" }
      : { source: "top", target: "bottom" };
  if (target.column !== source.column)
    return target.column > source.column
      ? { source: "right", target: "left" }
      : { source: "left", target: "right" };
  return target.row > source.row
    ? { source: "bottom", target: "top" }
    : { source: "top", target: "bottom" };
}

/** Build an isolated new draft; never resolve names against the existing library. */
export function createTextDiagramDraft(diagram: TextDiagram): {
  title: string;
  steps: WorkflowStep[];
  boardSettings: string;
} {
  validateDiagram(diagram);
  const { cells, frames, canvas } = layout(diagram.nodes),
    identifiers = new Map(
      diagram.nodes.map((node, index) => [
        node.id,
        { module: crypto.randomUUID(), detail: crypto.randomUUID(), index },
      ]),
    ),
    modules: WorkflowModule[] = diagram.nodes.map((node, index) => ({
      kind: "MODULE",
      id: identifiers.get(node.id)!.module,
      title: node.name,
      detailId: identifiers.get(node.id)!.detail,
      detailName: node.name,
      frame: frames[index],
      nextModuleIds: node.nextIds.map((id) => identifiers.get(id)!.module),
      connectionPorts: Object.fromEntries(
        node.nextIds.map((id) => {
          const target = identifiers.get(id)!;
          return [
            target.module,
            ports(cells.get(index)!, cells.get(target.index)!),
          ];
        }),
      ),
    })),
    details: WorkflowDetailDocument[] = diagram.nodes.map((node) => ({
      kind: "DETAIL",
      id: identifiers.get(node.id)!.detail,
      title: node.name,
      items: node.details.map((text) => ({ id: crypto.randomUUID(), text })),
      ...(node.details.length ? {} : { legacyEmpty: true }),
    }));
  return {
    title: diagram.title,
    steps: [...modules, ...details],
    boardSettings: serializeBoardAxes({
      ...DEFAULT_BOARD_AXES,
      timeline: { ...DEFAULT_BOARD_AXES.timeline, enabled: false },
      priority: { ...DEFAULT_BOARD_AXES.priority, enabled: false },
      canvas,
    }),
  };
}
