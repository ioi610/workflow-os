import type {
  GeneratedWorkflow,
  GeneratedWorkflowEntry,
  GeneratedWorkflowGroup,
} from "./generatedWorkflow";

export type ProcedureStep = {
  id: string;
  moduleId: string;
  moduleName: string;
  itemIndex: number | null;
  itemId?: string;
  ordinal: number;
  text: string;
  placeholder: boolean;
  placeholderReason?:
    | "missing"
    | "ambiguous"
    | "source-missing"
    | "empty-document"
    | "blank-step";
};

export type ProcedureConnection = {
  sourceId: string;
  targetId: string;
  kind: "internal" | "dependency" | "sequence";
};

export type ProcedureEntryRange = {
  moduleId: string;
  firstStepId: string;
  lastStepId: string;
  startOrdinal: number;
  endOrdinal: number;
};

export type ProcedureStage = {
  id: string;
  sourceGroupId: string;
  label: string;
  kind: GeneratedWorkflowGroup["kind"];
  entryIds: string[];
  stepIds: string[];
  cycleIds: string[];
  sameTime: boolean;
  requiresOrder: boolean;
};

export type ConnectedProcedure = {
  mode: GeneratedWorkflow["mode"];
  steps: ProcedureStep[];
  connections: ProcedureConnection[];
  stages: ProcedureStage[];
  entryRanges: ProcedureEntryRange[];
  entryOrder: string[];
  suggestedSequence: boolean;
  warnings: string[];
};

// Keep each occurrence's original text. Older documents can contain string
// arrays; the normal reader displays these as separate lines as well.
function instructionText(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .join("\n")
    : "";
}

function validateOrder(generated: GeneratedWorkflow, order: string[]) {
  const entries = new Map(generated.entries.map((entry) => [entry.id, entry]));
  if (
    entries.size !== generated.entries.length ||
    order.length !== entries.size ||
    new Set(order).size !== entries.size ||
    order.some((id) => !entries.has(id))
  )
    throw new Error("工作内容已经变化，请重新打开完整流程后再调整顺序。");

  if (generated.mode === "timeline") {
    const groups = new Map(
      generated.groups.flatMap((group, index) =>
        group.entryIds.map((id) => [id, index] as const),
      ),
    );
    for (let index = 1; index < order.length; index++) {
      const previous = entries.get(order[index - 1])!,
        current = entries.get(order[index])!;
      if (
        previous.minute !== undefined && current.minute !== undefined
          ? previous.minute > current.minute
          : (groups.get(previous.id) ?? Infinity) >
            (groups.get(current.id) ?? Infinity)
      )
        throw new Error(
          "不同时间的工作需要保持原来的时间顺序，同一时间内可以调整。",
        );
    }
  }

  if (generated.mode === "arrows") {
    const position = new Map(order.map((id, index) => [id, index]));
    const component = new Map<string, string[]>();
    for (const entry of generated.entries) component.set(entry.id, [entry.id]);
    for (const cycle of generated.cycles) {
      const members = cycle.entryIds.filter((id) => entries.has(id));
      for (const id of members) component.set(id, members);
    }
    for (const edge of generated.edges) {
      const from = component.get(edge.sourceId),
        to = component.get(edge.targetId);
      if (!from || !to || from === to) continue;
      if (
        Math.max(...from.map((id) => position.get(id)!)) >=
        Math.min(...to.map((id) => position.get(id)!))
      )
        throw new Error(
          "这个顺序与流程图中的箭头不一致，请保留已连接工作的先后。",
        );
    }
  }
}

/**
 * Project the existing documents into step occurrences without modifying them.
 * Display ordinals are references; only dependency connections are saved arrows.
 */
export function connectProcedure(
  generated: GeneratedWorkflow,
  order?: string[],
): ConnectedProcedure {
  const byId = new Map(generated.entries.map((entry) => [entry.id, entry]));
  const entryOrder = order
    ? [...order]
    : generated.entries.map((entry) => entry.id);
  validateOrder(generated, entryOrder);
  const steps: ProcedureStep[] = [],
    connections: ProcedureConnection[] = [],
    entryRanges: ProcedureEntryRange[] = [];
  const ranges = new Map<string, ProcedureEntryRange>();

  function appendStep(
    entry: GeneratedWorkflowEntry,
    itemIndex: number | null,
    text: string,
    placeholderReason?: ProcedureStep["placeholderReason"],
    itemId?: string,
  ) {
    const step: ProcedureStep = {
      id: `procedure:${encodeURIComponent(entry.id)}:${itemIndex ?? "missing"}`,
      moduleId: entry.id,
      moduleName: entry.name,
      itemIndex,
      ...(itemId !== undefined ? { itemId } : {}),
      ordinal: steps.length + 1,
      text,
      placeholder: !!placeholderReason,
      ...(placeholderReason ? { placeholderReason } : {}),
    };
    steps.push(step);
    return step;
  }

  for (const id of entryOrder) {
    const entry = byId.get(id)!;
    const start = steps.length;
    if (entry.sourceMissing) appendStep(entry, null, "", "source-missing");
    else if (entry.status === "AMBIGUOUS")
      appendStep(entry, null, "", "ambiguous");
    else if (entry.status !== "MATCHED" || !entry.detail)
      appendStep(entry, null, "", "missing");
    else if (!Array.isArray(entry.detail.items) || !entry.detail.items.length)
      appendStep(entry, null, "", "empty-document");
    else
      entry.detail.items.forEach((item, index) => {
        const text = instructionText(item?.text);
        appendStep(
          entry,
          index,
          text,
          text.trim() ? undefined : "blank-step",
          typeof item?.id === "string" ? item.id : undefined,
        );
      });
    const first = steps[start],
      last = steps.at(-1)!;
    const range = {
      moduleId: entry.id,
      firstStepId: first.id,
      lastStepId: last.id,
      startOrdinal: first.ordinal,
      endOrdinal: last.ordinal,
    };
    entryRanges.push(range);
    ranges.set(id, range);
    for (let index = start + 1; index < steps.length; index++)
      connections.push({
        sourceId: steps[index - 1].id,
        targetId: steps[index].id,
        kind: "internal",
      });
  }

  if (generated.mode === "arrows") {
    const seen = new Set<string>();
    for (const edge of generated.edges) {
      const from = ranges.get(edge.sourceId),
        to = ranges.get(edge.targetId);
      if (!from || !to) continue;
      const key = JSON.stringify([from.lastStepId, to.firstStepId]);
      if (seen.has(key)) continue;
      seen.add(key);
      connections.push({
        sourceId: from.lastStepId,
        targetId: to.firstStepId,
        kind: "dependency",
      });
    }
  } else
    for (let index = 1; index < entryRanges.length; index++)
      connections.push({
        sourceId: entryRanges[index - 1].lastStepId,
        targetId: entryRanges[index].firstStepId,
        kind: "sequence",
      });

  const groupsByEntry = new Map<string, GeneratedWorkflowGroup>();
  for (const group of generated.groups)
    for (const id of group.entryIds)
      if (byId.has(id) && !groupsByEntry.has(id)) groupsByEntry.set(id, group);
  const fallback: GeneratedWorkflowGroup = {
    id: "other-work",
    label: "其他已安排的工作",
    kind: generated.mode === "arrows" ? "dependencies" : generated.mode,
    entryIds: entryOrder.filter((id) => !groupsByEntry.has(id)),
    cycleIds: [],
  };
  const stages: ProcedureStage[] = [];
  const partCounts = new Map<string, number>();
  for (const id of entryOrder) {
    const group = groupsByEntry.get(id) ?? fallback;
    let stage = stages.at(-1);
    if (!stage || stage.sourceGroupId !== group.id) {
      const part = (partCounts.get(group.id) ?? 0) + 1;
      partCounts.set(group.id, part);
      stage = {
        id: part === 1 ? group.id : `${group.id}-part-${part}`,
        sourceGroupId: group.id,
        label: group.label,
        kind: group.kind,
        entryIds: [],
        stepIds: [],
        cycleIds: [],
        sameTime: group.kind === "timeline" && group.entryIds.length > 1,
        requiresOrder:
          group.entryIds.length > 1 &&
          (group.kind === "timeline" || group.kind === "source"),
      };
      stages.push(stage);
    }
    stage.entryIds.push(id);
    const range = ranges.get(id)!;
    stage.stepIds.push(
      ...steps
        .slice(range.startOrdinal - 1, range.endOrdinal)
        .map((step) => step.id),
    );
    const cycleId = byId.get(id)!.cycleId;
    if (cycleId && !stage.cycleIds.includes(cycleId))
      stage.cycleIds.push(cycleId);
  }
  const suggestedSequence =
    generated.mode !== "arrows" && entryRanges.length > 1;
  const warnings = [...generated.warnings];
  if (suggestedSequence)
    warnings.push(
      "工作之间按当前阅读顺序衔接；这些衔接是阅读建议，没有改动流程图中的箭头。",
    );
  return {
    mode: generated.mode,
    steps,
    connections,
    stages,
    entryRanges,
    entryOrder,
    suggestedSequence,
    warnings,
  };
}
