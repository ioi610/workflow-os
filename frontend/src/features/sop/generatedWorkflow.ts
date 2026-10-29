import type {
  Workflow,
  WorkflowDetailDocument,
  WorkflowModule,
} from "../../types";
import { modulePosition, moduleSize } from "./canvas";
import {
  boardSize,
  moduleAxisLabels,
  readBoardAxes,
  timelineOffset,
  timelineRange,
} from "./boardAxes";
import { readWorkflow, resolveModuleLink } from "./workflows";

export type GeneratedWorkflowEntry = {
  id: string;
  name: string;
  module: WorkflowModule;
  sourceIndex: number;
  minute?: number;
  time?: string;
  priority?: string;
  from: string[];
  to: string[];
  isolated: boolean;
  cycleId?: string;
  status: "MATCHED" | "MISSING" | "AMBIGUOUS";
  sourceMissing: boolean;
  contentStatus?: "READY" | "EMPTY" | "INCOMPLETE";
  detail?: WorkflowDetailDocument;
  targetWorkflow?: Workflow;
};
export type GeneratedWorkflowGroup = {
  id: string;
  label: string;
  kind: "dependencies" | "timeline" | "source";
  entryIds: string[];
  cycleIds: string[];
};
export type GeneratedWorkflowEdge = { sourceId: string; targetId: string };
export type GeneratedWorkflowCycle = { id: string; entryIds: string[] };
export type GeneratedWorkflow = {
  mode: "arrows" | "timeline" | "source";
  entries: GeneratedWorkflowEntry[];
  groups: GeneratedWorkflowGroup[];
  edges: GeneratedWorkflowEdge[];
  cycles: GeneratedWorkflowCycle[];
  warnings: string[];
};

function clockLabel(minute: number) {
  const clock = minute % 1440;
  return `${minute >= 1440 ? "次日 " : ""}${String(Math.floor(clock / 60)).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}`;
}

function instructionStatus(
  detail: WorkflowDetailDocument,
): GeneratedWorkflowEntry["contentStatus"] {
  const filled = detail.items.filter(
    (item) => typeof item?.text === "string" && item.text.trim(),
  ).length;
  return filled === 0
    ? "EMPTY"
    : filled < detail.items.length
      ? "INCOMPLETE"
      : "READY";
}

export function generateWorkflow(
  workflow: Workflow,
  workflows: Workflow[],
): GeneratedWorkflow {
  const library = [
    workflow,
    ...workflows.filter((entry) => entry.id !== workflow.id),
  ];
  const modules = readWorkflow(workflow.draft).modules;
  const settings = readBoardAxes(workflow.boardSettings),
    dimensions = boardSize(settings);
  const entries: GeneratedWorkflowEntry[] = modules.map(
    (module, sourceIndex) => {
      const position = modulePosition(module, sourceIndex, dimensions),
        size = moduleSize(module, dimensions);
      const labels = moduleAxisLabels(position, size, settings);
      const match = resolveModuleLink(workflow, module, library);
      const sourceMissing =
        typeof module.detailWorkflowId === "string" &&
        module.detailWorkflowId !== workflow.id &&
        !library.some((record) => record.id === module.detailWorkflowId);
      let minute: number | undefined;
      if (settings.timeline.enabled) {
        const axis = settings.timeline.axis || "x";
        const dimension = axis === "x" ? size.width : size.height;
        const travel =
          1 -
          Math.max(
            0,
            Math.min(1, Number.isFinite(dimension) ? dimension : 0.2),
          );
        const progress =
          travel <= 1e-9
            ? 0
            : Math.max(
                0,
                Math.min(
                  1,
                  (Number.isFinite(position[axis]) ? position[axis] : 0) /
                    travel,
                ),
              );
        const clock =
          timelineRange(settings).start + timelineOffset(progress, settings);
        minute = Math.round(Math.round(clock * 1e9) / 1e9);
      }
      return {
        id: module.id,
        name: module.title,
        module,
        sourceIndex,
        ...(minute !== undefined ? { minute, time: clockLabel(minute) } : {}),
        ...(labels.priority ? { priority: labels.priority } : {}),
        from: [],
        to: [],
        isolated: true,
        status: match.status,
        sourceMissing,
        ...(match.detail
          ? {
              detail: match.detail,
              contentStatus: instructionStatus(match.detail),
            }
          : {}),
        ...(match.targetWorkflow
          ? { targetWorkflow: match.targetWorkflow }
          : {}),
      };
    },
  );
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const edges: GeneratedWorkflowEdge[] = [];
  let dangling = 0;
  for (const entry of entries) {
    const targets = Array.isArray(entry.module.nextModuleIds)
      ? entry.module.nextModuleIds
      : [];
    for (const targetId of new Set(targets)) {
      const target = byId.get(targetId);
      if (!target) {
        dangling++;
        continue;
      }
      edges.push({ sourceId: entry.id, targetId });
      entry.to.push(targetId);
      target.from.push(entry.id);
      entry.isolated = target.isolated = false;
    }
  }
  const compare = (a: GeneratedWorkflowEntry, b: GeneratedWorkflowEntry) =>
    (a.minute ?? 0) - (b.minute ?? 0) ||
    a.sourceIndex - b.sourceIndex ||
    a.id.localeCompare(b.id);
  const warnings: string[] = [];
  const groups: GeneratedWorkflowGroup[] = [];
  const cycles: GeneratedWorkflowCycle[] = [];
  const mode = edges.length
    ? "arrows"
    : settings.timeline.enabled
      ? "timeline"
      : "source";
  if (mode === "arrows") {
    const components: string[][] = [],
      stack: string[] = [],
      active = new Set<string>();
    const indices = new Map<string, number>(),
      low = new Map<string, number>();
    let sequence = 0;
    function visit(id: string) {
      indices.set(id, sequence);
      low.set(id, sequence++);
      stack.push(id);
      active.add(id);
      for (const target of byId.get(id)!.to) {
        if (!indices.has(target)) {
          visit(target);
          low.set(id, Math.min(low.get(id)!, low.get(target)!));
        } else if (active.has(target))
          low.set(id, Math.min(low.get(id)!, indices.get(target)!));
      }
      if (low.get(id) === indices.get(id)) {
        const component: string[] = [];
        let current: string;
        do {
          current = stack.pop()!;
          active.delete(current);
          component.push(current);
        } while (current !== id);
        components.push(
          component.sort((a, b) => compare(byId.get(a)!, byId.get(b)!)),
        );
      }
    }
    for (const entry of entries) if (!indices.has(entry.id)) visit(entry.id);
    const componentFor = new Map<string, number>();
    for (const [index, component] of components.entries()) {
      component.forEach((id) => componentFor.set(id, index));
      if (
        component.length > 1 ||
        byId.get(component[0])!.to.includes(component[0])
      ) {
        const cycle = {
          id: `cycle-${cycles.length + 1}`,
          entryIds: [...component],
        };
        cycles.push(cycle);
        component.forEach((id) => {
          byId.get(id)!.cycleId = cycle.id;
        });
      }
    }
    const next = components.map(() => new Set<number>()),
      indegree = components.map(() => 0);
    for (const edge of edges) {
      const from = componentFor.get(edge.sourceId)!,
        to = componentFor.get(edge.targetId)!;
      if (from !== to && !next[from].has(to)) {
        next[from].add(to);
        indegree[to]++;
      }
    }
    const ready = components
      .map((_, index) => index)
      .filter((index) => indegree[index] === 0);
    while (ready.length) {
      ready.sort((a, b) =>
        compare(byId.get(components[a][0])!, byId.get(components[b][0])!),
      );
      // Release each component's successors immediately so an early newly
      // available task is considered before unrelated later work.
      const index = ready.shift()!;
      const entryIds = components[index];
      groups.push({
        id: `group-${groups.length + 1}`,
        label: `第 ${groups.length + 1} 组`,
        kind: "dependencies",
        entryIds,
        cycleIds: [
          ...new Set(
            entryIds.flatMap((id) =>
              byId.get(id)!.cycleId ? [byId.get(id)!.cycleId!] : [],
            ),
          ),
        ],
      });
      for (const target of next[index])
        if (--indegree[target] === 0) ready.push(target);
    }
    if (entries.some((entry) => entry.isolated))
      warnings.push(
        "部分工作没有连线，已保留在汇总中；它们与其他工作未指定先后。",
      );
    if (entries.some((entry) => entry.from.length > 1 || entry.to.length > 1))
      warnings.push(
        "分支和汇合保留原有连接；框架没有注明分支条件或是否同时进行。",
      );
    if (cycles.length)
      warnings.push(
        "框架存在回路，已保留连接关系；重复次数和退出条件尚未注明。",
      );
    if (
      edges.some((edge) => {
        const source = byId.get(edge.sourceId)!,
          target = byId.get(edge.targetId)!;
        return (
          source.minute !== undefined &&
          target.minute !== undefined &&
          source.minute > target.minute &&
          !(source.cycleId && source.cycleId === target.cycleId)
        );
      })
    )
      warnings.push(
        "部分箭头的先后与安排时间不一致，汇总以箭头为准，时间仍按框架显示。",
      );
  } else if (mode === "timeline") {
    for (const entry of [...entries].sort(compare)) {
      let group = groups.at(-1);
      if (!group || group.id !== `time-${entry.minute}`) {
        group = {
          id: `time-${entry.minute}`,
          label: entry.time!,
          kind: "timeline",
          entryIds: [],
          cycleIds: [],
        };
        groups.push(group);
      }
      group.entryIds.push(entry.id);
    }
    if (groups.some((group) => group.entryIds.length > 1))
      warnings.push("同一分钟的工作放在同一组，组内尚未指定先后。");
  } else if (entries.length) {
    groups.push({
      id: "source-order",
      label: "已安排的工作",
      kind: "source",
      entryIds: entries.map((entry) => entry.id),
      cycleIds: [],
    });
    warnings.push(
      "未设置时间或箭头，按画板列表顺序展示；这些工作尚未指定先后。",
    );
  }
  if (dangling)
    warnings.push(
      `有 ${dangling} 条连线指向不存在的工作，未将这些连线加入汇总。`,
    );
  const unavailable = entries.filter(
    (entry) => entry.status !== "MATCHED",
  ).length;
  if (unavailable)
    warnings.push(`有 ${unavailable} 项工作尚未找到唯一对应的做法。`);
  const unfinished = entries.filter(
    (entry) =>
      entry.contentStatus === "EMPTY" || entry.contentStatus === "INCOMPLETE",
  ).length;
  if (unfinished)
    warnings.push(
      `有 ${unfinished} 项工作的具体步骤尚未写完整，已保留原有内容。`,
    );
  return {
    mode,
    entries: groups.flatMap((group) =>
      group.entryIds.map((id) => byId.get(id)!),
    ),
    groups,
    edges,
    cycles,
    warnings,
  };
}
