import type {
  Workflow,
  WorkflowContent,
  WorkflowDetailDocument,
  WorkflowModule,
  WorkflowStep,
} from "../../types";
export const workflowKey = (org: string) => ["workflows", org];
export const normalizeName = (name: string) => name.normalize("NFC").trim();
export function readSteps(value: string): WorkflowStep[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
export function readWorkflow(value: string): WorkflowContent {
  const modules: WorkflowModule[] = [],
    details: WorkflowDetailDocument[] = [];
  for (const [index, step] of readSteps(value).entries()) {
    if (step.kind === "MODULE")
      modules.push({
        ...step,
        kind: "MODULE",
        id: step.id || `module-${index}`,
      } as WorkflowModule);
    else if (step.kind === "DETAIL")
      details.push({
        ...step,
        kind: "DETAIL",
        id: step.id || `detail-${index}`,
        items: Array.isArray(step.items) ? step.items : [],
      } as WorkflowDetailDocument);
    else {
      const id = step.id || `legacy-${index}`;
      modules.push({
        ...step,
        kind: "MODULE",
        id: `module-${id}`,
        title: step.title,
      } as WorkflowModule);
      details.push({
        ...step,
        kind: "DETAIL",
        id: `detail-${id}`,
        items: [{ id: `item-${id}`, text: step.description || "" }],
      });
    }
  }
  return { modules, details };
}
export function reorderModuleEntries(value: string, orderedIds: string[]) {
  const steps = readSteps(value);
  const entries = steps.flatMap((step, index) =>
    step.kind === "DETAIL"
      ? []
      : [
          {
            id:
              step.kind === "MODULE"
                ? step.id || `module-${index}`
                : `module-${step.id || `legacy-${index}`}`,
            step,
          },
        ],
  );
  const byId = new Map(entries.map((entry) => [entry.id, entry.step]));
  if (
    orderedIds.length !== entries.length ||
    byId.size !== entries.length ||
    new Set(orderedIds).size !== entries.length ||
    orderedIds.some((id) => !byId.has(id))
  )
    throw new Error("工作内容已经变了，请重新打开流程再调整。");
  let index = 0;
  return steps.map((step) =>
    step.kind === "DETAIL" ? step : byId.get(orderedIds[index++])!,
  );
}
export function appendModuleEntries(value: string, module: WorkflowModule) {
  const title = normalizeName(module.title);
  if (!title) throw new Error("请填写工作名称。");
  const modules = readWorkflow(value).modules;
  if (modules.length >= 100) throw new Error("一个流程最多添加 100 项工作。");
  if (modules.some((entry) => normalizeName(entry.title) === title))
    throw new Error(`已经有一项工作叫“${title}”了，请换个名称。`);
  return [...readSteps(value), { ...module, title }];
}
export function matchDetail(name: string, details: WorkflowDetailDocument[]) {
  const matches = details.filter(
    (detail) => normalizeName(detail.title) === normalizeName(name),
  );
  return {
    status:
      matches.length === 1
        ? "MATCHED"
        : matches.length === 0
          ? "MISSING"
          : "AMBIGUOUS",
    detail: matches.length === 1 ? matches[0] : undefined,
  } as const;
}
export const detailHref = (
  workflowId: string,
  name: string,
  detailId?: string,
) =>
  `/workflows/${workflowId}/steps?name=${encodeURIComponent(normalizeName(name))}${detailId ? `&detailId=${encodeURIComponent(detailId)}` : ""}`;
type ModuleLink = {
  status: "MATCHED" | "MISSING" | "AMBIGUOUS";
  detail?: WorkflowDetailDocument;
  targetWorkflow?: Workflow;
};
export function resolveModuleLink(
  workflow: Workflow,
  module: WorkflowModule,
  workflows: Workflow[],
): ModuleLink {
  const detailName =
    typeof module.detailName === "string" && normalizeName(module.detailName)
      ? normalizeName(module.detailName)
      : module.title;
  if (module.detailId !== undefined) {
    const targetWorkflow =
      module.detailWorkflowId === undefined ||
      module.detailWorkflowId === workflow.id
        ? workflow
        : workflows.find((entry) => entry.id === module.detailWorkflowId);
    if (!targetWorkflow) return { status: "MISSING" };
    const result = matchDetailId(
      module.detailId,
      readWorkflow(targetWorkflow.draft).details,
    );
    return { ...result, targetWorkflow };
  }
  if (typeof module.detailWorkflowId === "string") {
    const targetWorkflow =
      module.detailWorkflowId === workflow.id
        ? workflow
        : workflows.find((entry) => entry.id === module.detailWorkflowId);
    if (!targetWorkflow) return { status: "MISSING" };
    const result = matchDetail(
      detailName,
      readWorkflow(targetWorkflow.draft).details,
    );
    return { ...result, targetWorkflow };
  }
  const local = matchDetail(detailName, readWorkflow(workflow.draft).details);
  if (local.status !== "MISSING")
    return local.status === "MATCHED"
      ? { ...local, targetWorkflow: workflow }
      : local;
  const candidates = workflows.flatMap((targetWorkflow) =>
    targetWorkflow.id === workflow.id
      ? []
      : readWorkflow(targetWorkflow.draft)
          .details.filter(
            (detail) =>
              normalizeName(detail.title) === normalizeName(detailName),
          )
          .map((detail) => ({ detail, targetWorkflow })),
  );
  if (candidates.length === 1) return { status: "MATCHED", ...candidates[0] };
  return { status: candidates.length ? "AMBIGUOUS" : "MISSING" };
}
export function moduleHref(
  workflow: Workflow,
  module: WorkflowModule,
  workflows: Workflow[],
) {
  const result = resolveModuleLink(workflow, module, workflows);
  if (result.status !== "MATCHED" || !result.targetWorkflow)
    return `${detailHref(workflow.id, module.title)}&module=${encodeURIComponent(module.id)}`;
  const href = detailHref(
    result.targetWorkflow.id,
    result.detail?.title ?? module.title,
    result.detail?.id,
  );
  return result.targetWorkflow.id === workflow.id
    ? href
    : `${href}&from=${encodeURIComponent(workflow.id)}`;
}
export function resolveInstructionLink(
  workflow: Workflow,
  name: string,
  workflows: Workflow[],
  moduleId?: string | null,
  detailId?: string | null,
): ModuleLink {
  const content = readWorkflow(workflow.draft);
  const selectedModule = content.modules.find(
    (module) =>
      module.id === moduleId &&
      normalizeName(module.title) === normalizeName(name),
  );
  if (selectedModule)
    return resolveModuleLink(workflow, selectedModule, workflows);
  if (detailId !== undefined && detailId !== null)
    return {
      ...matchDetailId(detailId, content.details),
      targetWorkflow: workflow,
    };
  const local = matchDetail(name, content.details);
  if (local.status !== "MISSING") return { ...local, targetWorkflow: workflow };
  return resolveModuleLink(
    workflow,
    { kind: "MODULE", id: "lookup", title: name },
    workflows,
  );
}

function matchDetailId(id: unknown, details: WorkflowDetailDocument[]) {
  const matches =
    typeof id === "string" && normalizeName(id)
      ? details.filter((detail) => detail.id === id)
      : [];
  return {
    status:
      matches.length === 1
        ? "MATCHED"
        : matches.length
          ? "AMBIGUOUS"
          : "MISSING",
    detail: matches.length === 1 ? matches[0] : undefined,
  } as const;
}
export function newModule(title = ""): WorkflowModule {
  return { kind: "MODULE", id: crypto.randomUUID(), title };
}
export function newDetail(title = ""): WorkflowDetailDocument {
  return {
    kind: "DETAIL",
    id: crypto.randomUUID(),
    title,
    items: [{ id: crypto.randomUUID(), text: "" }],
    materials: "",
    safetyNotice: "",
    imageUrl: "",
    videoUrl: "",
  };
}
export function validateContent(content: WorkflowContent): string | null {
  if (content.modules.length > 100 || content.details.length > 100)
    return "一个流程最多添加 100 项工作和 100 份做法。";
  for (const [entries, label] of [
    [content.modules, "工作"],
    [content.details, "做法"],
  ] as const) {
    const names = new Set<string>();
    for (const entry of entries) {
      const name = normalizeName(entry.title);
      if (!name)
        return label === "工作"
          ? "请填写工作名称。"
          : "请填写这份做法对应的工作名称。";
      if (names.has(name)) return `已经有${label}叫“${name}”了，请换个名称。`;
      names.add(name);
    }
  }
  for (const detail of content.details) {
    if (
      detail.legacyEmpty === true &&
      !detail.items.length &&
      !(detail.description || "").trim()
    )
      continue;
    if (!detail.items.length || detail.items.length > 100)
      return `“${detail.title}”需要 1–100 条具体步骤。`;
    if (detail.items.some((item) => !item.text.trim()))
      return `请填写“${detail.title}”列表中每条步骤的内容。`;
  }
  return null;
}
export function serializeWorkflow(content: WorkflowContent) {
  return [
    ...content.modules.map((module) => ({
      ...module,
      title: normalizeName(module.title),
    })),
    ...content.details.map((detail) => ({
      ...detail,
      title: normalizeName(detail.title),
    })),
  ];
}
export const exampleWorkflow = {
  title: "会议准备流程",
  category: "日常工作",
  modules: [
    newModule("确认会议安排"),
    newModule("整理会议资料"),
    newModule("检查场地与设备"),
  ],
  details: [
    {
      ...newDetail("确认会议安排"),
      items: [
        {
          id: crypto.randomUUID(),
          text: "与发起人确认会议时间、地点、议题和参加人员。",
        },
        {
          id: crypto.randomUUID(),
          text: "把会议目的写入邀请，再发送给参会人员。",
        },
      ],
    },
    {
      ...newDetail("整理会议资料"),
      items: [
        {
          id: crypto.randomUUID(),
          text: "根据议题收集文件，检查是否为最新版本。",
        },
        {
          id: crypto.randomUUID(),
          text: "按讨论顺序整理资料，把阅读链接放在会议邀请中。",
        },
      ],
      safetyNotice: "分享前检查资料权限。",
    },
    {
      ...newDetail("检查场地与设备"),
      items: [
        { id: crypto.randomUUID(), text: "检查座位、网络、屏幕和音频设备。" },
        { id: crypto.randomUUID(), text: "提前打开远程会议链接并测试声音。" },
      ],
    },
  ],
};
