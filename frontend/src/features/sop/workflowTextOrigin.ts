import type { Workflow, WorkflowStep } from "../../types";
import { connectProcedure } from "./connectedProcedure";
import { generateWorkflow, type GeneratedWorkflow } from "./generatedWorkflow";
import { readSteps } from "./workflows";

const FIELD = "workflowOSOriginalText";
type Origin = { version: 1; text: string; signature: string; order: string[] };
type Draft = { steps: WorkflowStep[]; boardSettings?: string | null };

function withoutOrigin(step: WorkflowStep): WorkflowStep {
  const { [FIELD]: _origin, ...content } = step;
  return content as WorkflowStep;
}

/** Canonicalize JSON only, so server key ordering and whitespace do not invalidate a source. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

function signature(workflow: Workflow, generated: GeneratedWorkflow): string {
  let settings: unknown = workflow.boardSettings ?? null;
  if (typeof settings === "string") {
    try {
      settings = JSON.parse(settings);
    } catch {
      // An invalid setting still differs from the original snapshot.
    }
  }
  return JSON.stringify(
    canonical({
      steps: readSteps(workflow.draft).map(withoutOrigin),
      settings,
      resolved: generated.entries.map((entry) => ({
        id: entry.id,
        status: entry.status,
        sourceMissing: entry.sourceMissing,
        detail: entry.detail ? withoutOrigin(entry.detail) : null,
      })),
    }),
  );
}

function snapshot(draft: Draft): Workflow {
  return {
    id: "original-text-preview",
    title: "文字流程",
    category: "",
    draft: JSON.stringify(draft.steps.map(withoutOrigin)),
    boardSettings: draft.boardSettings ?? null,
    revision: 0,
  };
}

/** Keep source text only while its full graph, resolved instructions and order still match. */
export function attachOriginalWorkflowText(
  draft: Draft,
  text: string,
  order?: string[],
): WorkflowStep[] {
  const steps = draft.steps.map(withoutOrigin);
  if (!steps.length) return steps;
  const workflow = snapshot({ ...draft, steps });
  const generated = generateWorkflow(workflow, [workflow]);
  const effectiveOrder = connectProcedure(generated, order).entryOrder;
  const origin: Origin = {
    version: 1,
    text,
    signature: signature(workflow, generated),
    order: [...effectiveOrder],
  };
  return steps.map((step, index) =>
    index === 0 ? { ...step, [FIELD]: origin } : step,
  );
}

function matchingOrigin(
  workflow: Workflow,
  generated: GeneratedWorkflow,
): Origin | null {
  const entries = readSteps(workflow.draft);
  const values = entries.filter((step) => Object.hasOwn(step, FIELD));
  if (values.length !== 1) return null;
  const value = values[0][FIELD];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const origin = value as Partial<Origin>;
  if (
    origin.version !== 1 ||
    typeof origin.text !== "string" ||
    typeof origin.signature !== "string" ||
    !Array.isArray(origin.order) ||
    !origin.order.every((id) => typeof id === "string") ||
    origin.signature !== signature(workflow, generated)
  )
    return null;
  try {
    connectProcedure(generated, origin.order);
  } catch {
    return null;
  }
  return origin as Origin;
}

export function originalWorkflowOrder(
  workflow: Workflow,
  generated: GeneratedWorkflow,
): string[] | undefined {
  const origin = matchingOrigin(workflow, generated);
  return origin ? [...origin.order] : undefined;
}

export function originalWorkflowText(
  workflow: Workflow,
  generated: GeneratedWorkflow,
  order: string[],
): string | null {
  const origin = matchingOrigin(workflow, generated);
  return origin && JSON.stringify(origin.order) === JSON.stringify(order)
    ? origin.text
    : null;
}
