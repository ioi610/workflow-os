import type {
  Workflow,
  WorkflowDetailDocument,
  WorkflowStep,
} from "../../types";
import { boardSize, readBoardAxes, validateBoardAxes } from "./boardAxes";
import { normalizeName, readWorkflow, resolveModuleLink } from "./workflows";

export const WORKFLOW_TRANSFER_START = "-----BEGIN WORKFLOW OS RESTORE-----";
export const WORKFLOW_TRANSFER_END = "-----END WORKFLOW OS RESTORE-----";
export const WORKFLOW_TRANSFER_MAX_LENGTH = 2 * 1024 * 1024;

export type WorkflowTransferDetail = {
  moduleId: string;
  sourceWorkflowId: string;
  detail: WorkflowDetailDocument;
};

export type WorkflowTransfer = {
  title: string;
  category: string;
  steps: WorkflowStep[];
  boardSettings: string | null;
  prose: string;
  order?: string[];
  sourceWorkflowId: string;
  referencedDetails: WorkflowTransferDetail[];
};

type TransferEnvelope = WorkflowTransfer & {
  format: "workflow-os";
  version: 1;
};

function invalid(message = "还原文字不完整或已损坏，请重新复制。 "): never {
  throw new Error(message.trim());
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const owns = (value: object, key: string) => Object.hasOwn(value, key);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && !!normalizeName(value) && value.length <= 255;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function checkLength(text: string) {
  if (text.length > WORKFLOW_TRANSFER_MAX_LENGTH)
    invalid("还原文字太长，最多支持 2 MB，请减少内容后重试。");
}

/** JSON remains inert data. Reject dangerous property names before a caller copies it. */
function checkJson(value: unknown) {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let entries = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++entries > 100_000 || current.depth > 64)
      invalid("还原文字内容太复杂，请重新复制。");
    if (typeof current.value === "number" && !Number.isFinite(current.value))
      invalid();
    if (current.value !== null && typeof current.value === "object") {
      for (const [key, child] of Object.entries(current.value)) {
        if (["__proto__", "prototype", "constructor"].includes(key))
          invalid("还原文字包含不支持的字段，请重新复制。");
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else if (
      current.value !== null &&
      !["string", "number", "boolean"].includes(typeof current.value)
    )
      invalid();
  }
}

function checkMedia(entry: Record<string, unknown>) {
  for (const key of ["imageUrl", "videoUrl"]) {
    if (!owns(entry, key)) continue;
    const value = entry[key];
    if (
      typeof value !== "string" ||
      (value &&
        !value.startsWith("https://") &&
        !/^\/api\/orgs\/[^/]+\/files\//.test(value))
    )
      invalid("还原文字中的图片或视频链接格式不正确。");
  }
}

function checkDetail(value: unknown): asserts value is WorkflowDetailDocument {
  if (
    !record(value) ||
    value.kind !== "DETAIL" ||
    !identifier(value.id) ||
    typeof value.title !== "string" ||
    !Array.isArray(value.items) ||
    value.items.length > 100
  )
    invalid("还原文字中的具体做法不完整，一份做法最多保留 100 条步骤。");
  const ids = new Set<string>();
  for (const item of value.items) {
    if (!record(item) || typeof item.text !== "string")
      invalid("还原文字中的具体步骤格式不正确。");
    if (owns(item, "id")) {
      if (!identifier(item.id) || ids.has(item.id))
        invalid("还原文字中的具体步骤编号缺失或重复。");
      ids.add(item.id);
    }
  }
  checkMedia(value);
}

function checkSteps(steps: unknown, boardSettings: string | null) {
  if (!Array.isArray(steps) || steps.length > 200)
    invalid("一个流程最多保留 100 项工作和 100 份做法。");
  const size = boardSize(readBoardAxes(boardSettings));
  for (const step of steps) {
    if (
      !record(step) ||
      typeof step.title !== "string" ||
      (owns(step, "kind") && step.kind !== "MODULE" && step.kind !== "DETAIL")
    )
      invalid("还原文字中的工作或具体做法格式不正确。");
    checkMedia(step);
    if (step.kind === "DETAIL") {
      checkDetail(step);
      continue;
    }
    if (!normalizeName(step.title)) invalid("还原文字中有工作没有名称。");
    if (owns(step, "id") && !identifier(step.id))
      invalid("还原文字中的工作编号不正确。");
    for (const key of ["detailId", "detailWorkflowId"])
      if (owns(step, key) && !identifier(step[key]))
        invalid("还原文字中的做法对应关系不完整。");
    if (owns(step, "detailName") && typeof step.detailName !== "string")
      invalid("还原文字中的做法名称格式不正确。");
    if (owns(step, "frame")) {
      const frame = step.frame;
      if (
        !record(frame) ||
        ![frame.x, frame.y, frame.width, frame.height].every(finite) ||
        (frame.x as number) < 0 ||
        (frame.y as number) < 0 ||
        (frame.width as number) < 32 ||
        (frame.height as number) < 32 ||
        (frame.x as number) + (frame.width as number) > size.width + 0.000001 ||
        (frame.y as number) + (frame.height as number) > size.height + 0.000001
      )
        invalid("还原文字中的方框太小或超出流程图范围。");
    } else {
      const dimensions = { width: 0.2, height: 0.2 };
      if (owns(step, "size")) {
        if (!record(step.size)) invalid("还原文字中的方框大小不正确。");
        for (const key of ["width", "height"] as const) {
          const edge = step.size[key];
          if (!finite(edge) || edge < 0.12 || edge > 1)
            invalid("还原文字中的方框大小不正确。");
          dimensions[key] = edge;
        }
      }
      if (owns(step, "position")) {
        if (!record(step.position)) invalid("还原文字中的方框位置不正确。");
        for (const [key, edge] of [
          ["x", dimensions.width],
          ["y", dimensions.height],
        ] as const) {
          const origin = step.position[key];
          if (!finite(origin) || origin < 0 || origin + edge > 1)
            invalid("还原文字中的方框位置不正确。");
        }
      }
    }
  }
  const content = readWorkflow(JSON.stringify(steps));
  if (content.modules.length > 100 || content.details.length > 100)
    invalid("一个流程最多保留 100 项工作和 100 份做法。");
  for (const entries of [content.modules, content.details]) {
    const ids = new Set<string>(),
      names = new Set<string>();
    for (const entry of entries) {
      const name = normalizeName(entry.title);
      if (
        !identifier(entry.id) ||
        ids.has(entry.id) ||
        (name && names.has(name))
      )
        invalid("还原文字中的工作或做法名称、编号有重复。");
      ids.add(entry.id);
      if (name) names.add(name);
    }
  }
  const ids = new Set(content.modules.map((module) => module.id));
  const sides = ["top", "right", "bottom", "left"];
  for (const module of content.modules) {
    if (owns(module, "nextModuleIds")) {
      if (
        !Array.isArray(module.nextModuleIds) ||
        module.nextModuleIds.length > 100 ||
        new Set(module.nextModuleIds).size !== module.nextModuleIds.length ||
        module.nextModuleIds.some(
          (id) => typeof id !== "string" || !ids.has(id) || id === module.id,
        )
      )
        invalid("还原文字中的箭头没有连到有效的工作，或有重复。");
    }
    if (owns(module, "connectionPorts")) {
      if (!record(module.connectionPorts))
        invalid("还原文字中的箭头位置不正确。");
      for (const [target, ports] of Object.entries(module.connectionPorts))
        if (
          !ids.has(target) ||
          target === module.id ||
          !record(ports) ||
          !sides.includes(ports.source as string) ||
          (owns(ports, "target") && !sides.includes(ports.target as string))
        )
          invalid("还原文字中的箭头位置不正确。");
    }
  }
  return content;
}

function checkTransfer(value: unknown): asserts value is TransferEnvelope {
  if (!record(value) || value.format !== "workflow-os") invalid();
  if (value.version !== 1)
    invalid("这份还原文字的版本暂不支持，请使用同一版本的程序重新复制。");
  if (
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.trim().length > 200 ||
    typeof value.category !== "string" ||
    value.category.trim().length > 100 ||
    typeof value.prose !== "string" ||
    !identifier(value.sourceWorkflowId) ||
    !(value.boardSettings === null || typeof value.boardSettings === "string")
  )
    invalid("还原文字中的流程名称、分类或设置不完整。");
  if (value.boardSettings !== null) {
    if (value.boardSettings.length > 8192)
      invalid("还原文字中的流程图设置太长。");
    let settings: unknown;
    try {
      settings = JSON.parse(value.boardSettings);
    } catch {
      invalid("还原文字中的流程图设置已损坏。");
    }
    checkJson(settings);
    const error = validateBoardAxes(settings);
    if (error) invalid(error);
  }
  const content = checkSteps(value.steps, value.boardSettings);
  if (owns(value, "order")) {
    if (
      !Array.isArray(value.order) ||
      value.order.length !== content.modules.length ||
      new Set(value.order).size !== content.modules.length ||
      value.order.some(
        (id) =>
          typeof id !== "string" ||
          !content.modules.some((module) => module.id === id),
      )
    )
      invalid("还原文字中的完整流程顺序不完整。");
  }
  if (
    !Array.isArray(value.referencedDetails) ||
    value.referencedDetails.length > 100
  )
    invalid("还原文字中的做法来源不完整。");
  const referencedModules = new Set<string>();
  const documents = new Map<string, string>();
  for (const reference of value.referencedDetails) {
    if (
      !record(reference) ||
      !identifier(reference.moduleId) ||
      !identifier(reference.sourceWorkflowId) ||
      !content.modules.some((module) => module.id === reference.moduleId) ||
      referencedModules.has(reference.moduleId)
    )
      invalid("还原文字中的做法对应关系有误。");
    checkDetail(reference.detail);
    const detail = reference.detail;
    const module = content.modules.find(
      (module) => module.id === reference.moduleId,
    )!;
    const detailName =
      typeof module.detailName === "string" && normalizeName(module.detailName)
        ? module.detailName
        : module.title;
    if (
      (module.detailId !== undefined &&
        module.detailId !== reference.detail.id) ||
      (module.detailWorkflowId !== undefined &&
        module.detailWorkflowId !== reference.sourceWorkflowId) ||
      (module.detailId === undefined &&
        normalizeName(detailName) !== normalizeName(reference.detail.title))
    )
      invalid("还原文字中的做法来源与工作对应不上。");
    if (reference.sourceWorkflowId === value.sourceWorkflowId) {
      const original = content.details.find((entry) => entry.id === detail.id);
      if (!original || JSON.stringify(original) !== JSON.stringify(detail))
        invalid("还原文字中的本地做法副本不一致。");
    }
    const key = JSON.stringify([
      reference.sourceWorkflowId,
      reference.detail.id,
    ]);
    const encoded = JSON.stringify(reference.detail);
    if (documents.has(key) && documents.get(key) !== encoded)
      invalid("还原文字中同一份做法有不同内容，请重新复制。");
    documents.set(key, encoded);
    referencedModules.add(reference.moduleId);
  }
}

/** Copy data only: no changes to workflows, browser storage, or the server. */
export function serializeWorkflowTransfer(
  workflow: Workflow,
  workflows: Workflow[],
  prose: string,
  order?: string[],
): string {
  let steps: unknown;
  try {
    steps = JSON.parse(workflow.draft);
  } catch {
    invalid("流程内容无法读取，请重新打开后再复制。");
  }
  const referencedDetails = readWorkflow(workflow.draft).modules.flatMap(
    (module) => {
      const match = resolveModuleLink(workflow, module, workflows);
      return match.status === "MATCHED" && match.detail && match.targetWorkflow
        ? [
            {
              moduleId: module.id,
              sourceWorkflowId: match.targetWorkflow.id,
              detail: match.detail,
            },
          ]
        : [];
    },
  );
  const envelope = {
    format: "workflow-os",
    version: 1,
    sourceWorkflowId: workflow.id,
    title: workflow.title,
    category: workflow.category,
    boardSettings: workflow.boardSettings ?? null,
    steps,
    prose,
    ...(order !== undefined ? { order } : {}),
    referencedDetails,
  };
  checkJson(envelope);
  checkTransfer(envelope);
  const text = `${prose}\n\n${WORKFLOW_TRANSFER_START}\n${JSON.stringify(envelope)}\n${WORKFLOW_TRANSFER_END}`;
  checkLength(text);
  return text;
}

/** Null means ordinary prose. A damaged marked document must never fall back to guessing. */
export function parseWorkflowTransfer(text: string): WorkflowTransfer | null {
  const lines = [
    ...text.matchAll(
      new RegExp(`(^|\\n)${WORKFLOW_TRANSFER_START}\\r?\\n`, "g"),
    ),
  ];
  const marker = lines.at(-1);
  if (!marker) {
    if (text.includes(WORKFLOW_TRANSFER_START)) invalid();
    if (text.includes(WORKFLOW_TRANSFER_END)) invalid();
    return null;
  }
  checkLength(text);
  const start = marker.index! + marker[1].length;
  const suffix = text.slice(start + WORKFLOW_TRANSFER_START.length);
  const ending = new RegExp(`\\r?\\n${WORKFLOW_TRANSFER_END}\\s*$`).exec(
    suffix,
  );
  if (!ending) invalid();
  const end = ending.index;
  let value: unknown;
  try {
    value = JSON.parse(suffix.slice(0, end).trim());
  } catch {
    invalid();
  }
  checkJson(value);
  checkTransfer(value);
  const comparable = (value: string) => value.replace(/\r\n?/g, "\n").trim();
  if (comparable(text.slice(0, start)) !== comparable(value.prose))
    invalid(
      "上方流程文字与还原内容不一致，请重新复制还原文字；修改普通文字后请使用普通文字生成。",
    );
  const { format: _format, version: _version, ...result } = value;
  return result;
}

export type WorkflowTransferImport = Pick<
  WorkflowTransfer,
  "title" | "category" | "steps" | "boardSettings" | "prose" | "order"
>;

/** A new diagram owns copies of its referenced documents; original workflows stay untouched. */
export function prepareWorkflowTransferImport(
  transfer: WorkflowTransfer,
): WorkflowTransferImport {
  const envelope = { ...transfer, format: "workflow-os", version: 1 };
  checkJson(envelope);
  checkTransfer(envelope);
  const steps = JSON.parse(JSON.stringify(transfer.steps)) as WorkflowStep[];
  const content = readWorkflow(JSON.stringify(steps));
  const references = new Map(
    transfer.referencedDetails.map((entry) => [entry.moduleId, entry]),
  );
  const localDocuments = new Map(
    content.details.map((detail) => [detail.id, detail]),
  );
  const names = new Set(
    content.details
      .map((detail) => normalizeName(detail.title))
      .filter(Boolean),
  );
  const copied = new Map<string, WorkflowDetailDocument>();
  const append: WorkflowDetailDocument[] = [];
  let moduleIndex = 0;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (step.kind === "DETAIL") continue;
    const module = content.modules[moduleIndex++];
    const reference = references.get(module.id);
    const { detailWorkflowId: _oldSource, ...local } = step;
    if (reference && reference.sourceWorkflowId !== transfer.sourceWorkflowId) {
      const key = JSON.stringify([
        reference.sourceWorkflowId,
        reference.detail.id,
      ]);
      let document = copied.get(key);
      if (!document) {
        if (localDocuments.size + append.length >= 100)
          invalid("复制来源做法后会超过 100 份，请减少做法后再还原。");
        const baseId = `restored-${reference.detail.id}`.slice(0, 240);
        let id = baseId,
          number = 2;
        while (
          localDocuments.has(id) ||
          append.some((detail) => detail.id === id)
        )
          id = `${baseId}-${number++}`;
        const originalName = reference.detail.title;
        let title = originalName;
        number = 2;
        while (normalizeName(title) && names.has(normalizeName(title)))
          title = `${originalName}（还原 ${number++}）`;
        document = {
          ...JSON.parse(JSON.stringify(reference.detail)),
          id,
          title,
        };
        copied.set(key, document!);
        append.push(document!);
        if (normalizeName(title)) names.add(normalizeName(title));
      }
      steps[index] = { ...local, detailId: document!.id };
    } else {
      if (
        (module.detailWorkflowId !== undefined &&
          module.detailWorkflowId !== transfer.sourceWorkflowId) ||
        (module.detailId !== undefined &&
          !localDocuments.has(module.detailId)) ||
        (module.detailWorkflowId === transfer.sourceWorkflowId && !reference)
      )
        invalid(
          `“${module.title}”引用的具体做法没有完整副本，请回到原流程修复对应关系后重新复制。`,
        );
      // Explicit local IDs keep their identity. A previous workflow ID must never
      // make a copied diagram depend on the workflow it was copied from.
      if (owns(step, "detailWorkflowId")) steps[index] = local;
    }
  }
  const result: WorkflowTransferImport = {
    title: transfer.title,
    category: transfer.category,
    steps: [...steps, ...append],
    boardSettings: transfer.boardSettings,
    prose: transfer.prose,
    ...(transfer.order !== undefined ? { order: [...transfer.order] } : {}),
  };
  checkSteps(result.steps, result.boardSettings);
  return result;
}
