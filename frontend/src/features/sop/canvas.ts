import type {
  ConnectionPorts,
  ConnectionSide,
  ModuleFrame,
  WorkflowModule,
  WorkflowStep,
} from "../../types";
export type { ConnectionPorts, ConnectionSide, ModuleFrame } from "../../types";
import { readSteps, readWorkflow } from "./workflows";

export type Position = { x: number; y: number };
export type Size = { width: number; height: number };
export const MODULE_SIZE = 0.2;
export const MIN_MODULE_SIZE = 0.12;
export const MIN_FRAME_SIZE = 32;
const defaultSize = { width: MODULE_SIZE, height: MODULE_SIZE };
const referenceBoard = { width: 820, height: 820 };
const defaultMinimum = { width: MIN_MODULE_SIZE, height: MIN_MODULE_SIZE };
function minimumSize(minimum: Size) {
  const limit = (value: number) =>
    Number.isFinite(value) && value > 0 ? Math.min(1, value) : MIN_MODULE_SIZE;
  return { width: limit(minimum.width), height: limit(minimum.height) };
}
export function clampSize(
  size: Size,
  position?: Position,
  minimum: Size = defaultMinimum,
): Size {
  const min = minimumSize(minimum);
  const limit = (origin: number | undefined, smallest: number) =>
    1 -
    Math.max(0, Math.min(1 - smallest, Number.isFinite(origin) ? origin! : 0));
  return {
    width: Math.max(
      min.width,
      Math.min(
        limit(position?.x, min.width),
        Number.isFinite(size?.width) ? size.width : MODULE_SIZE,
      ),
    ),
    height: Math.max(
      min.height,
      Math.min(
        limit(position?.y, min.height),
        Number.isFinite(size?.height) ? size.height : MODULE_SIZE,
      ),
    ),
  };
}
function fixedFrame(module: WorkflowModule): ModuleFrame | undefined {
  const frame = module.frame;
  return frame &&
    [frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) &&
    frame.x >= 0 &&
    frame.y >= 0 &&
    frame.width > 0 &&
    frame.height > 0
    ? frame
    : undefined;
}
function requireBoard(board: Size): Size {
  if (
    !Number.isFinite(board.width) ||
    !Number.isFinite(board.height) ||
    board.width < MIN_FRAME_SIZE ||
    board.height < MIN_FRAME_SIZE
  )
    throw new Error("模版大小有问题，请重新设置。");
  return board;
}
function frameMinimum(board: Size): Size {
  return {
    width: MIN_FRAME_SIZE / board.width,
    height: MIN_FRAME_SIZE / board.height,
  };
}
export function moduleSize(
  module: WorkflowModule,
  board: Size = referenceBoard,
): Size {
  const frame = fixedFrame(module);
  if (frame) {
    const dimensions = requireBoard(board);
    return {
      width: frame.width / dimensions.width,
      height: frame.height / dimensions.height,
    };
  }
  return clampSize(module.size || defaultSize);
}
export const clampPosition = (
  position: Position,
  size: Size = defaultSize,
  minimum: Size = defaultMinimum,
): Position => {
  const bounded = clampSize(size, undefined, minimum);
  return {
    x: Math.max(
      0,
      Math.min(1 - bounded.width, Number.isFinite(position.x) ? position.x : 0),
    ),
    y: Math.max(
      0,
      Math.min(
        1 - bounded.height,
        Number.isFinite(position.y) ? position.y : 0,
      ),
    ),
  };
};
export function modulePosition(
  module: WorkflowModule,
  index: number,
  board: Size = referenceBoard,
): Position {
  const frame = fixedFrame(module);
  if (frame) {
    const dimensions = requireBoard(board);
    return { x: frame.x / dimensions.width, y: frame.y / dimensions.height };
  }
  if (
    module.position &&
    Number.isFinite(module.position.x) &&
    Number.isFinite(module.position.y)
  )
    return clampPosition(module.position, moduleSize(module));
  return clampPosition(
    {
      x: 0.04 + (index % 3) * 0.3,
      y: Math.min(0.76, 0.04 + Math.floor(index / 3) * 0.3),
    },
    moduleSize(module),
  );
}
export function moduleFrame(
  module: WorkflowModule,
  index: number,
  board: Size,
): ModuleFrame {
  const dimensions = requireBoard(board);
  const frame = fixedFrame(module);
  if (frame) return { ...frame };
  const position = modulePosition(module, index),
    size = moduleSize(module);
  return {
    x: position.x * dimensions.width,
    y: position.y * dimensions.height,
    width: size.width * dimensions.width,
    height: size.height * dimensions.height,
  };
}
export function minimumBoardSize(modules: WorkflowModule[], board: Size): Size {
  return modules.reduce(
    (minimum, module, index) => {
      const frame = moduleFrame(module, index, board);
      return {
        width: Math.max(
          minimum.width,
          Math.ceil(frame.x + frame.width - 0.000001),
        ),
        height: Math.max(
          minimum.height,
          Math.ceil(frame.y + frame.height - 0.000001),
        ),
      };
    },
    { width: 320, height: 320 },
  );
}
export function availablePosition(
  modules: WorkflowModule[],
  board?: Size,
  newSize?: Size,
): Position {
  if (board) {
    const dimensions = requireBoard(board),
      minimum = frameMinimum(dimensions);
    const size = clampSize(newSize || defaultSize, undefined, minimum);
    const width = size.width * dimensions.width,
      height = size.height * dimensions.height;
    const rectangles = modules.map((module, index) =>
      moduleFrame(module, index, dimensions),
    );
    const clear = (x: number, y: number) =>
      rectangles.every(
        (rectangle) =>
          x + width + 8 <= rectangle.x ||
          y + height + 8 <= rectangle.y ||
          x >= rectangle.x + rectangle.width + 8 ||
          y >= rectangle.y + rectangle.height + 8,
      );
    for (
      let y = dimensions.height * 0.04;
      y + height <= dimensions.height;
      y += height + 32
    )
      for (
        let x = dimensions.width * 0.04;
        x + width <= dimensions.width;
        x += width + 32
      )
        if (clear(x, y))
          return { x: x / dimensions.width, y: y / dimensions.height };
    const candidates = (
      axis: "x" | "y",
      extent: "width" | "height",
      maximum: number,
      edge: number,
    ) =>
      [
        ...new Set([
          0,
          maximum - edge,
          ...rectangles.flatMap((rectangle) => [
            rectangle[axis] + rectangle[extent] + 8,
            rectangle[axis] - edge - 8,
          ]),
        ]),
      ].filter((coordinate) => coordinate >= 0 && coordinate + edge <= maximum);
    for (const y of candidates("y", "height", dimensions.height, height))
      for (const x of candidates("x", "width", dimensions.width, width))
        if (clear(x, y))
          return { x: x / dimensions.width, y: y / dimensions.height };
    return clampPosition({ x: 0.4, y: 0.4 }, size, minimum);
  }
  const rectangles = modules.map((module, index) => ({
    ...modulePosition(module, index),
    ...moduleSize(module),
  }));
  const clear = (x: number, y: number) =>
    rectangles.every(
      (rectangle) =>
        x + MODULE_SIZE + 0.01 <= rectangle.x ||
        y + MODULE_SIZE + 0.01 <= rectangle.y ||
        x >= rectangle.x + rectangle.width + 0.01 ||
        y >= rectangle.y + rectangle.height + 0.01,
    );
  for (let y = 0.04; y <= 0.79; y += 0.24)
    for (let x = 0.04; x <= 0.79; x += 0.24) if (clear(x, y)) return { x, y };
  const candidates = (axis: "x" | "y", extent: "width" | "height") =>
    [
      ...new Set([
        0,
        1 - MODULE_SIZE,
        ...rectangles.flatMap((rectangle) => [
          rectangle[axis] + rectangle[extent] + 0.02,
          rectangle[axis] - MODULE_SIZE - 0.02,
        ]),
      ]),
    ].filter((coordinate) => coordinate >= 0 && coordinate <= 1 - MODULE_SIZE);
  for (const y of candidates("y", "height"))
    for (const x of candidates("x", "width")) if (clear(x, y)) return { x, y };
  return { x: 0.4, y: 0.4 };
}
function storedModuleId(step: WorkflowStep, index: number) {
  return step.kind === "MODULE"
    ? step.id || `module-${index}`
    : `module-${step.id || `legacy-${index}`}`;
}
// Stabilize identifiers before removing an entry, so old index-based IDs do not shift.
function stableSteps(value: string): WorkflowStep[] {
  return readSteps(value).map((step, index) => ({
    ...step,
    id:
      step.id ||
      `${step.kind === "MODULE" ? "module" : step.kind === "DETAIL" ? "detail" : "legacy"}-${index}`,
  }));
}
export function patchModuleEntries(
  value: string,
  id: string,
  patch: Partial<WorkflowModule>,
) {
  const original = readSteps(value);
  const index = original.findIndex(
    (step, index) =>
      step.kind !== "DETAIL" && storedModuleId(step, index) === id,
  );
  if (index < 0) throw new Error("工作内容已经变了，请重新打开流程。");
  const steps = stableSteps(value);
  const { id: _id, kind: _kind, ...fields } = patch;
  steps[index] = { ...steps[index], ...fields };
  return steps;
}
export function moveModuleEntries(
  value: string,
  id: string,
  position: Position,
  board?: Size,
) {
  const modules = readWorkflow(value).modules;
  const index = modules.findIndex((entry) => entry.id === id);
  const module = modules[index];
  if (!module) throw new Error("工作内容已经变了，请重新打开流程。");
  if (board) {
    const dimensions = requireBoard(board),
      frame = moduleFrame(module, index, dimensions);
    const width = Math.max(MIN_FRAME_SIZE, frame.width),
      height = Math.max(MIN_FRAME_SIZE, frame.height);
    if (width > dimensions.width || height > dimensions.height)
      throw new Error("模版太小，放不下这项工作，请先调大模版。");
    const next = clampPosition(
      position,
      { width: width / dimensions.width, height: height / dimensions.height },
      frameMinimum(dimensions),
    );
    return patchFrameEntries(value, id, {
      x: Math.max(
        0,
        Math.min(dimensions.width - width, next.x * dimensions.width),
      ),
      y: Math.max(
        0,
        Math.min(dimensions.height - height, next.y * dimensions.height),
      ),
      width,
      height,
    });
  }
  return patchModuleEntries(value, id, {
    position: clampPosition(position, moduleSize(module)),
  });
}
function patchFrameEntries(value: string, id: string, frame: ModuleFrame) {
  return patchModuleEntries(value, id, { frame }).map((step, index) => {
    if (step.kind === "DETAIL" || storedModuleId(step, index) !== id)
      return step;
    const { position: _position, size: _size, ...fixed } = step;
    return fixed;
  });
}
export function resizeModuleEntries(
  value: string,
  id: string,
  size: Size,
  board?: Size,
) {
  const modules = readWorkflow(value).modules;
  const index = modules.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error("工作内容已经变了，请重新打开流程。");
  if (board) {
    const dimensions = requireBoard(board),
      frame = moduleFrame(modules[index], index, dimensions);
    if (
      frame.x > dimensions.width - MIN_FRAME_SIZE ||
      frame.y > dimensions.height - MIN_FRAME_SIZE
    )
      throw new Error("模版太小，放不下这项工作，请先调大模版。");
    const bounded = clampSize(
      size,
      { x: frame.x / dimensions.width, y: frame.y / dimensions.height },
      frameMinimum(dimensions),
    );
    return patchFrameEntries(value, id, {
      x: frame.x,
      y: frame.y,
      width: Math.max(
        MIN_FRAME_SIZE,
        Math.min(dimensions.width - frame.x, bounded.width * dimensions.width),
      ),
      height: Math.max(
        MIN_FRAME_SIZE,
        Math.min(
          dimensions.height - frame.y,
          bounded.height * dimensions.height,
        ),
      ),
    });
  }
  const position = modulePosition(modules[index], index);
  return patchModuleEntries(value, id, {
    position,
    size: clampSize(size, position),
  });
}
export function resizeBoardEntries(
  value: string,
  from: Size,
  to: Size,
): WorkflowStep[] {
  requireBoard(from);
  const dimensions = requireBoard(to),
    modules = readWorkflow(value).modules;
  return stableSteps(value).map((step, stepIndex) => {
    if (step.kind === "DETAIL") return step;
    const id = storedModuleId(step, stepIndex),
      index = modules.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("工作内容已经变了，请重新打开流程。");
    const frame = moduleFrame(modules[index], index, from);
    if (
      frame.x + frame.width > dimensions.width + 0.000001 ||
      frame.y + frame.height > dimensions.height + 0.000001
    )
      throw new Error(
        "模版太小，放不下现有工作，请先把工作移到里面或调大模版。",
      );
    const { position: _position, size: _size, ...fixed } = step;
    return { ...fixed, frame };
  });
}
const connectionSides: ConnectionSide[] = ["top", "right", "bottom", "left"];
const validSide = (value: unknown): value is ConnectionSide =>
  connectionSides.includes(value as ConnectionSide);
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function readPorts(value: unknown): ConnectionPorts | undefined {
  const ports = record(value);
  return ports &&
    validSide(ports.source) &&
    (ports.target === undefined || validSide(ports.target))
    ? {
        source: ports.source,
        ...(ports.target !== undefined ? { target: ports.target } : {}),
      }
    : undefined;
}
function removeTargetPorts(value: unknown, targetId: string) {
  const ports = record(value);
  if (!ports || !Object.hasOwn(ports, targetId)) return undefined;
  return Object.fromEntries(
    Object.entries(ports).filter(([id]) => id !== targetId),
  );
}
export function connectModuleEntries(
  value: string,
  sourceId: string,
  targetId: string,
  ports?: ConnectionPorts,
) {
  const modules = readWorkflow(value).modules;
  const source = modules.find((module) => module.id === sourceId);
  if (!source || !modules.some((module) => module.id === targetId))
    throw new Error("要连接的工作已经不在这里了。");
  if (sourceId === targetId) throw new Error("请选择接下来要做的另一项工作。");
  if (source.nextModuleIds?.includes(targetId))
    throw new Error("这条箭头已经存在。");
  const selected = ports === undefined ? undefined : readPorts(ports);
  if (ports !== undefined && !selected)
    throw new Error("请选择工作方框上的连线位置。");
  return patchModuleEntries(value, sourceId, {
    nextModuleIds: [...(source.nextModuleIds || []), targetId],
    ...(selected
      ? {
          connectionPorts: {
            ...record(source.connectionPorts),
            [targetId]: selected,
          } as Record<string, ConnectionPorts>,
        }
      : {}),
  });
}
export function disconnectModuleEntries(
  value: string,
  sourceId: string,
  targetId: string,
) {
  const source = readWorkflow(value).modules.find(
    (module) => module.id === sourceId,
  );
  if (!source) throw new Error("这项工作已经不在这里了。");
  const connectionPorts = removeTargetPorts(source.connectionPorts, targetId);
  return patchModuleEntries(value, sourceId, {
    nextModuleIds: (source.nextModuleIds || []).filter((id) => id !== targetId),
    ...(connectionPorts !== undefined
      ? { connectionPorts: connectionPorts as Record<string, ConnectionPorts> }
      : {}),
  });
}
export function removeModuleEntries(value: string, id: string) {
  const original = readSteps(value);
  const index = original.findIndex(
    (step, index) =>
      step.kind !== "DETAIL" && storedModuleId(step, index) === id,
  );
  if (index < 0) throw new Error("这项工作已经不在这里了。");
  const detail = readWorkflow(value).details.find(
    (entry) => entry.id === `detail-${original[index].id || `legacy-${index}`}`,
  );
  const preservedDetail =
    detail && detail.items.every((item) => !item.text.trim())
      ? { ...detail, items: [], legacyEmpty: true }
      : detail;
  return stableSteps(value).flatMap((step, currentIndex) => {
    if (currentIndex === index)
      return step.kind === "MODULE" ? [] : [preservedDetail!];
    if (step.kind === "DETAIL") return [step];
    const connectionPorts = removeTargetPorts(step.connectionPorts, id);
    return [
      {
        ...step,
        ...(Array.isArray(step.nextModuleIds)
          ? {
              nextModuleIds: step.nextModuleIds.filter((entry) => entry !== id),
            }
          : {}),
        ...(connectionPorts !== undefined ? { connectionPorts } : {}),
      },
    ];
  });
}
export function canvasArrows(modules: WorkflowModule[]) {
  const ids = new Set(modules.map((module) => module.id));
  return modules.flatMap((source) =>
    [...new Set(source.nextModuleIds || [])]
      .filter((targetId) => ids.has(targetId) && targetId !== source.id)
      .map((targetId) => {
        const ports = readPorts(record(source.connectionPorts)?.[targetId]);
        return { sourceId: source.id, targetId, ...(ports ? { ports } : {}) };
      }),
  );
}
function canvasDimensions(dimensions: Size): Size {
  return {
    width:
      Number.isFinite(dimensions.width) && dimensions.width > 0
        ? dimensions.width
        : 1,
    height:
      Number.isFinite(dimensions.height) && dimensions.height > 0
        ? dimensions.height
        : 1,
  };
}
function geometrySize(size: Size): Size {
  const edge = (value: number) =>
    Number.isFinite(value) && value > 0 ? Math.min(1, value) : MODULE_SIZE;
  return { width: edge(size.width), height: edge(size.height) };
}
const sideVector = (side: ConnectionSide): Position => ({
  x: side === "right" ? 1 : side === "left" ? -1 : 0,
  y: side === "bottom" ? 1 : side === "top" ? -1 : 0,
});
type Rectangle = { left: number; right: number; top: number; bottom: number };
const rectangle = (position: Position, size: Size): Rectangle => ({
  left: position.x * 1000,
  right: (position.x + size.width) * 1000,
  top: position.y * 1000,
  bottom: (position.y + size.height) * 1000,
});
const inside = (point: Position, box: Rectangle) =>
  point.x > box.left + 0.000001 &&
  point.x < box.right - 0.000001 &&
  point.y > box.top + 0.000001 &&
  point.y < box.bottom - 0.000001;
function orthogonalRoute(
  start: Position,
  end: Position,
  boxes: Rectangle[],
  gap: Size,
  dimensions: Size,
) {
  const xs = [
    ...new Set([
      start.x,
      end.x,
      ...boxes.flatMap((box) => [box.left - gap.width, box.right + gap.width]),
    ]),
  ];
  const ys = [
    ...new Set([
      start.y,
      end.y,
      ...boxes.flatMap((box) => [
        box.top - gap.height,
        box.bottom + gap.height,
      ]),
    ]),
  ];
  const nodes = xs
    .flatMap((x) => ys.map((y) => ({ x, y })))
    .filter((point) => !boxes.some((box) => inside(point, box)));
  const indexOf = (point: Position) =>
    nodes.findIndex((node) => node.x === point.x && node.y === point.y);
  const first = indexOf(start),
    last = indexOf(end);
  if (first < 0 || last < 0) return null;
  const clear = (a: Position, b: Position) =>
    !boxes.some((box) =>
      a.x === b.x
        ? a.x > box.left &&
          a.x < box.right &&
          Math.max(Math.min(a.y, b.y), box.top) <
            Math.min(Math.max(a.y, b.y), box.bottom)
        : a.y > box.top &&
          a.y < box.bottom &&
          Math.max(Math.min(a.x, b.x), box.left) <
            Math.min(Math.max(a.x, b.x), box.right),
    );
  const distances = nodes.map(() => Infinity),
    previous = nodes.map(() => -1),
    visited = new Set<number>();
  distances[first] = 0;
  for (;;) {
    let current = -1;
    for (let index = 0; index < nodes.length; index++)
      if (
        !visited.has(index) &&
        (current < 0 || distances[index] < distances[current])
      )
        current = index;
    if (current < 0 || !Number.isFinite(distances[current])) return null;
    if (current === last) break;
    visited.add(current);
    nodes.forEach((next, index) => {
      const from = nodes[current];
      if (
        visited.has(index) ||
        (from.x !== next.x && from.y !== next.y) ||
        !clear(from, next)
      )
        return;
      const distance =
        distances[current] +
        Math.abs(next.x - from.x) * dimensions.width +
        Math.abs(next.y - from.y) * dimensions.height;
      if (distance < distances[index]) {
        distances[index] = distance;
        previous[index] = current;
      }
    });
  }
  const points: Position[] = [];
  for (let index = last; index >= 0; index = previous[index]) {
    points.unshift(nodes[index]);
    if (index === first) break;
  }
  return points;
}
function sideAnchor(
  position: Position,
  size: Size,
  side: ConnectionSide,
  gap = 0,
): Position {
  const vector = sideVector(side);
  return {
    x:
      (position.x + size.width / 2 + (vector.x * size.width) / 2) * 1000 +
      vector.x * gap,
    y:
      (position.y + size.height / 2 + (vector.y * size.height) / 2) * 1000 +
      vector.y * gap,
  };
}
function portCurve(
  start: Position,
  end: Position,
  sourceSide: ConnectionSide,
  targetSide: ConnectionSide,
  dimensions: Size,
  boxes: Rectangle[] = [],
  freeEnd = false,
) {
  const { width, height } = canvasDimensions(dimensions);
  const distance = Math.hypot(
    (end.x - start.x) * width,
    (end.y - start.y) * height,
  );
  const bend = Math.max(35 * Math.min(width, height), distance * 0.35);
  const from = sideVector(sourceSide),
    to = sideVector(targetSide);
  const gap = {
    width: Math.min(35, 12000 / width),
    height: Math.min(35, 12000 / height),
  };
  const bounded = (point: Position): Position => ({
    x: Math.max(-gap.width, Math.min(1000 + gap.width, point.x)),
    y: Math.max(-gap.height, Math.min(1000 + gap.height, point.y)),
  });
  const c1 = bounded({
    x: start.x + (from.x * bend) / width,
    y: start.y + (from.y * bend) / height,
  });
  const c2 = bounded({
    x: end.x + (to.x * bend) / width,
    y: end.y + (to.y * bend) / height,
  });
  const crosses = Array.from({ length: 79 }, (_, index) => {
    const t = (index + 1) / 80,
      inverse = 1 - t;
    return {
      x:
        inverse ** 3 * start.x +
        3 * inverse ** 2 * t * c1.x +
        3 * inverse * t ** 2 * c2.x +
        t ** 3 * end.x,
      y:
        inverse ** 3 * start.y +
        3 * inverse ** 2 * t * c1.y +
        3 * inverse * t ** 2 * c2.y +
        t ** 3 * end.y,
    };
  }).some(
    (point) =>
      boxes.some((box) => inside(point, box)) ||
      point.x < -gap.width ||
      point.x > 1000 + gap.width ||
      point.y < -gap.height ||
      point.y > 1000 + gap.height,
  );
  if (crosses && !boxes.some((box) => inside(end, box))) {
    const leave = bounded({
      x: start.x + from.x * gap.width,
      y: start.y + from.y * gap.height,
    });
    const arrive = freeEnd
      ? end
      : bounded({ x: end.x + to.x * gap.width, y: end.y + to.y * gap.height });
    const route = orthogonalRoute(leave, arrive, boxes, gap, { width, height });
    if (route)
      return `M ${start.x} ${start.y} L ${(freeEnd ? route : [...route, end]).map((point) => `${point.x} ${point.y}`).join(" L ")}`;
  }
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
}
export function connectionPreviewPath(
  start: Position,
  startSize: Size,
  end: Position,
  sourceSide: ConnectionSide,
  dimensions: Size = { width: 1, height: 1 },
) {
  const side = validSide(sourceSide) ? sourceSide : "right";
  const size = geometrySize(startSize);
  return portCurve(
    sideAnchor(start, size, side),
    { x: end.x * 1000, y: end.y * 1000 },
    side,
    side === "top"
      ? "bottom"
      : side === "right"
        ? "left"
        : side === "bottom"
          ? "top"
          : "right",
    dimensions,
    [rectangle(start, size)],
    true,
  );
}
export function arrowPath(
  start: Position,
  end: Position,
  startSize: Size = defaultSize,
  endSize: Size = defaultSize,
  dimensions: Size = { width: 1, height: 1 },
  ports?: ConnectionPorts,
) {
  const source = geometrySize(startSize),
    target = geometrySize(endSize);
  const selected = readPorts(ports);
  if (selected) {
    const a = sideAnchor(start, source, selected.source);
    const physical = canvasDimensions(dimensions);
    const targetSide =
      selected.target ??
      connectionSides.reduce((closest, side) => {
        const distance = (candidate: ConnectionSide) => {
          const anchor = sideAnchor(end, target, candidate);
          return Math.hypot(
            (anchor.x - a.x) * physical.width,
            (anchor.y - a.y) * physical.height,
          );
        };
        return distance(side) < distance(closest) ? side : closest;
      });
    const targetGap = Math.min(
      6,
      6000 /
        (targetSide === "left" || targetSide === "right"
          ? physical.width
          : physical.height),
    );
    return portCurve(
      a,
      sideAnchor(end, target, targetSide, targetGap),
      selected.source,
      targetSide,
      physical,
      [rectangle(start, source), rectangle(end, target)],
    );
  }
  const a = {
    x: (start.x + source.width / 2) * 1000,
    y: (start.y + source.height / 2) * 1000,
  };
  const b = {
    x: (end.x + target.width / 2) * 1000,
    y: (end.y + target.height / 2) * 1000,
  };
  const { width, height } = canvasDimensions(dimensions);
  if (Math.abs(b.x - a.x) * width >= Math.abs(b.y - a.y) * height) {
    const direction = b.x >= a.x ? 1 : -1;
    a.x += direction * source.width * 500;
    b.x -= direction * (target.width * 500 + 6);
    const bend = Math.max(35, Math.abs(b.x - a.x) * 0.5);
    return `M ${a.x} ${a.y} C ${a.x + direction * bend} ${a.y}, ${b.x - direction * bend} ${b.y}, ${b.x} ${b.y}`;
  }
  const direction = b.y >= a.y ? 1 : -1;
  a.y += direction * source.height * 500;
  b.y -= direction * (target.height * 500 + 6);
  const bend = Math.max(35, Math.abs(b.y - a.y) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x} ${a.y + direction * bend}, ${b.x} ${b.y - direction * bend}, ${b.x} ${b.y}`;
}
