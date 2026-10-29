import type { WorkflowContent } from "../../types";
import { normalizeName, serializeWorkflow } from "./workflows";

export type WorkflowDraftContent = WorkflowContent & {
  title: string;
  category: string;
  boardSettings?: string | null;
};

export function workflowDraftPayload(draft: WorkflowDraftContent) {
  return {
    title: draft.title.trim(),
    category: draft.category.trim(),
    steps: serializeWorkflow(draft),
    boardSettings: draft.boardSettings ?? null,
  };
}

export const workflowDraftSavePayload = (draft: WorkflowDraftContent) => ({
  ...workflowDraftPayload(draft),
  draftOnly: true as const,
});

export function validateWorkflowDraft(
  draft: WorkflowDraftContent,
  org: string,
): string | null {
  if (!draft.title.trim()) return "请填写流程名称。";
  if (draft.title.trim().length > 200 || draft.category.trim().length > 100)
    return "流程名称或分类太长了。";
  if (draft.modules.length > 100 || draft.details.length > 100)
    return "一个流程最多添加 100 项工作和 100 份做法。";
  const moduleNames = new Set<string>();
  for (const module of draft.modules) {
    if (typeof module.title !== "string" || !normalizeName(module.title))
      return "请填写工作名称。";
    const name = normalizeName(module.title);
    if (moduleNames.has(name)) return `已经有工作叫“${name}”了，请换个名称。`;
    moduleNames.add(name);
  }
  const detailNames = new Set<string>(),
    detailIds = new Set<string>();
  for (const detail of draft.details) {
    if (typeof detail.title !== "string")
      return "做法名称的格式有误，请重新打开后再试。";
    if (
      typeof detail.id !== "string" ||
      !normalizeName(detail.id) ||
      detail.id.length > 255 ||
      detailIds.has(detail.id)
    )
      return "做法的编号缺失或重复，请重新打开后再试。";
    detailIds.add(detail.id);
    const name = normalizeName(detail.title);
    if (name && detailNames.has(name))
      return `已经有做法叫“${name}”了，请换个名称。`;
    if (name) detailNames.add(name);
    if (!Array.isArray(detail.items) || detail.items.length > 100)
      return `“${name || "未命名做法"}”最多添加 100 条具体步骤。`;
    if (
      detail.items.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          typeof item.text !== "string",
      )
    )
      return `“${name || "未命名做法"}”的步骤格式有误，请重新打开后再试。`;
  }
  for (const entry of [...draft.modules, ...draft.details]) {
    for (const value of [entry.imageUrl, entry.videoUrl])
      if (
        value &&
        (typeof value !== "string" ||
          (!value.startsWith("https://") &&
            !value.startsWith(`/api/orgs/${org}/files/`)))
      )
        return "图片或视频链接需要以 https:// 开头。";
  }
  return null;
}
