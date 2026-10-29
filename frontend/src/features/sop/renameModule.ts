import type { Workflow, WorkflowStep } from "../../types";
import {
  normalizeName,
  readSteps,
  readWorkflow,
  resolveModuleLink,
} from "./workflows";

const moduleId = (step: WorkflowStep, index: number) =>
  step.kind === "MODULE"
    ? step.id || `module-${index}`
    : `module-${step.id || `legacy-${index}`}`;
const detailId = (step: WorkflowStep, index: number) =>
  step.kind === "DETAIL"
    ? step.id || `detail-${index}`
    : `detail-${step.id || `legacy-${index}`}`;

export function renameModuleEntries(
  workflow: Workflow,
  selectedId: string,
  name: string,
  workflows: Workflow[],
): WorkflowStep[] {
  const title = normalizeName(name);
  if (!title) throw new Error("请填写工作名称。");
  if (title.length > 200) throw new Error("工作名称最多填写 200 个字。");
  const steps = readSteps(workflow.draft);
  const content = readWorkflow(workflow.draft);
  const module = content.modules.find((entry) => entry.id === selectedId);
  const index = steps.findIndex(
    (step, index) =>
      step.kind !== "DETAIL" && moduleId(step, index) === selectedId,
  );
  if (!module || index < 0)
    throw new Error("这项工作已经不在这里了，请重新打开流程。");
  if (normalizeName(module.title) === title) return steps;
  if (
    content.modules.some(
      (entry) =>
        entry.id !== selectedId && normalizeName(entry.title) === title,
    )
  )
    throw new Error(`已经有一项工作叫“${title}”了，请换个名称。`);

  const library = [
    workflow,
    ...workflows.filter((entry) => entry.id !== workflow.id),
  ];
  const match = resolveModuleLink(workflow, module, library);
  const local =
    match.status === "MATCHED" && match.targetWorkflow?.id === workflow.id
      ? match.detail
      : undefined;
  const shared =
    !!local &&
    (library.some((board) =>
      readWorkflow(board.draft).modules.some((other) => {
        if (board.id === workflow.id && other.id === selectedId) return false;
        const link = resolveModuleLink(board, other, library);
        return (
          link.status === "MATCHED" &&
          link.targetWorkflow?.id === workflow.id &&
          link.detail?.id === local.id
        );
      }),
    ) ||
      steps.some(
        (step, currentIndex) =>
          currentIndex !== index &&
          step.kind !== "MODULE" &&
          step.kind !== "DETAIL" &&
          detailId(step, currentIndex) === local.id,
      ));
  const syncLocal = local && !shared;
  if (
    syncLocal &&
    content.details.some(
      (entry) => entry.id !== local.id && normalizeName(entry.title) === title,
    )
  )
    throw new Error(`已经有一份做法叫“${title}”了，请换个名称。`);

  const legacy = steps[index].kind !== "MODULE";
  const splitLegacy =
    legacy && (!syncLocal || local.id !== detailId(steps[index], index));
  const entries: WorkflowStep[] = splitLegacy
    ? steps.map((step, currentIndex): WorkflowStep => ({
        ...step,
        id:
          step.id ||
          `${step.kind === "MODULE" ? "module" : step.kind === "DETAIL" ? "detail" : "legacy"}-${currentIndex}`,
      }))
    : steps;
  return entries.flatMap((step, currentIndex): WorkflowStep[] => {
    if (currentIndex === index) {
      const { detailName: _oldAlias, ...renamed } = step;
      const updated: WorkflowStep =
        match.status === "MATCHED" && match.targetWorkflow && match.detail
          ? {
              ...renamed,
              title,
              ...(!legacy || splitLegacy
                ? {
                    ...(match.targetWorkflow.id !== "draft-template"
                      ? { detailWorkflowId: match.targetWorkflow.id }
                      : {}),
                    detailId: match.detail.id,
                  }
                : {}),
              ...(!local || shared
                ? { detailName: normalizeName(match.detail.title) }
                : {}),
            }
          : { ...renamed, title };
      if (!splitLegacy) return [updated];
      const original = content.details.find(
        (entry) => entry.id === detailId(steps[index], index),
      )!;
      const preserved = original.items.every((item) => !item.text.trim())
        ? { ...original, items: [], legacyEmpty: true }
        : original;
      return [{ ...updated, kind: "MODULE", id: module.id }, preserved];
    }
    if (
      syncLocal &&
      step.kind !== "MODULE" &&
      detailId(steps[currentIndex], currentIndex) === local.id
    )
      return [{ ...step, title }];
    return [step];
  });
}
