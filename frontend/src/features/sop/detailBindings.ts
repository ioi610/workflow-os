import type { Workflow, WorkflowContent, WorkflowModule } from "../../types";
import { resolveModuleLink, serializeWorkflow } from "./workflows";

const unsavedWorkflowId = "draft-template";

/** Retain the exact document selected now, rather than matching its name again later. */
export function bindModuleDetail(
  workflow: Workflow,
  module: WorkflowModule,
  workflows: Workflow[],
): WorkflowModule {
  const match = resolveModuleLink(workflow, module, workflows);
  if (match.status !== "MATCHED" || !match.detail || !match.targetWorkflow)
    return module;
  // A new workflow has no server ID yet. A document ID without a source pin
  // deliberately means local-only, so no temporary workflow ID is persisted.
  const localUnsaved =
    workflow.id === unsavedWorkflowId &&
    match.targetWorkflow.id === workflow.id;
  const sourceId = localUnsaved ? undefined : match.targetWorkflow.id;
  if (
    module.detailId === match.detail.id &&
    module.detailWorkflowId === sourceId
  )
    return module;
  const { detailWorkflowId: _oldSource, ...rest } = module;
  return {
    ...rest,
    ...(sourceId !== undefined ? { detailWorkflowId: sourceId } : {}),
    detailId: match.detail.id,
  };
}

/** Call before editing a title, and after adding a document, using the live draft. */
export function bindContentDetails<T extends WorkflowContent>(
  content: T,
  workflowId: string | undefined,
  workflows: Workflow[],
): T {
  const workflow: Workflow = {
    id: workflowId || unsavedWorkflowId,
    title: "",
    category: "",
    revision: 0,
    draft: JSON.stringify(serializeWorkflow(content)),
  };
  const modules = content.modules.map((module) =>
    bindModuleDetail(workflow, module, workflows),
  );
  return modules.some((module, index) => module !== content.modules[index])
    ? { ...content, modules }
    : content;
}
