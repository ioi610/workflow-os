import type { Workflow } from "../../types";
import { completeWorkflowText } from "./completeWorkflowText";
import { connectProcedure } from "./connectedProcedure";
import { generateWorkflow, type GeneratedWorkflow } from "./generatedWorkflow";
import { originalWorkflowOrder } from "./workflowTextOrigin";
import {
  parseWorkflowTransfer,
  prepareWorkflowTransferImport,
  serializeWorkflowTransfer,
  type WorkflowTransfer,
} from "./workflowTransfer";

export type PlainTextWorkflowMatch = {
  workflowId: string;
  title: string;
  moduleCount: number;
  transfer: WorkflowTransfer;
};

export type ReadPlainTextWorkflowOrder = (
  workflowId: string,
  generated: GeneratedWorkflow,
) => string[] | undefined;

const comparable = (text: string) => text.replace(/\r\n?/g, "\n").trim();

/** Match an ordinary copy of the body, optionally including its visible title. */
export function plainTextMatchesWorkflow(
  text: string,
  prose: string,
  title?: string,
): boolean {
  const expected = comparable(text);
  if (!expected || !comparable(prose)) return false;
  return (
    expected === comparable(prose) ||
    (!!title &&
      ["\n", "\n\n"].some(
        (separator) => expected === comparable(`${title}${separator}${prose}`),
      ))
  );
}

/** Read the same per-person manual order used by the complete-procedure page. */
export function readStoredPlainTextWorkflowOrder(
  userId: string | undefined,
  org: string,
  workflowId: string,
  generated: GeneratedWorkflow,
): string[] | undefined {
  if (!userId) return undefined;
  try {
    const stored = JSON.parse(
      localStorage.getItem(
        `workflow-os:procedure-order:${userId}:${org}:${workflowId}`,
      ) || "null",
    );
    if (
      !stored ||
      !Array.isArray(stored.order) ||
      !stored.order.every((item: unknown) => typeof item === "string") ||
      typeof stored.signature !== "string"
    )
      return undefined;
    const current = {
      entries: generated.entries.map((entry) => [entry.id, entry.minute]),
      groups: generated.groups.map((group) => [group.id, group.entryIds]),
      edges: generated.edges,
    };
    if (stored.signature !== JSON.stringify(current)) {
      // Keep valid orders from releases whose grouping algorithm differed.
      const previous = JSON.parse(stored.signature);
      if (
        JSON.stringify(previous.entries) !== JSON.stringify(current.entries) ||
        JSON.stringify(previous.edges) !== JSON.stringify(current.edges)
      )
        return undefined;
    }
    return connectProcedure(generated, stored.order).entryOrder;
  } catch {
    return undefined;
  }
}

/**
 * Ordinary prose does not describe geometry. Reuse a complete, validated graph
 * only when its generated text matches in full, and expose every match so the
 * caller never silently chooses between different diagrams with identical text.
 * This function reads supplied data only; it never accesses storage or services.
 */
export function findPlainTextWorkflowMatches(
  text: string,
  workflows: Workflow[],
  readOrder?: ReadPlainTextWorkflowOrder,
): PlainTextWorkflowMatch[] {
  const expected = comparable(text);
  if (!expected) return [];
  const matches: PlainTextWorkflowMatch[] = [];
  let blocked: Error | undefined;
  for (const workflow of workflows) {
    let matched = false;
    try {
      const generated = generateWorkflow(workflow, workflows);
      if (!generated.entries.length) continue;
      const order =
        readOrder?.(workflow.id, generated) ??
        originalWorkflowOrder(workflow, generated);
      const procedure = connectProcedure(generated, order);
      const prose = completeWorkflowText(workflow, generated, procedure);
      if (!plainTextMatchesWorkflow(text, prose, workflow.title)) continue;
      matched = true;
      const transfer = parseWorkflowTransfer(
        serializeWorkflowTransfer(
          workflow,
          workflows,
          prose,
          procedure.entryOrder,
        ),
      );
      if (!transfer) throw new Error("未能读取完整的原流程。");
      // Validate independently copied details now, so a known source never
      // silently falls through to a lossy ordinary-text parser.
      prepareWorkflowTransferImport(transfer);
      matches.push({
        workflowId: workflow.id,
        title: workflow.title,
        moduleCount: generated.entries.length,
        transfer,
      });
    } catch (error) {
      if (matched && !blocked)
        blocked = new Error(
          `找到这份文字对应的原流程，但暂时无法完整还原。${error instanceof Error ? error.message : "请检查原流程的内容和做法对应关系。"}`,
        );
      // An unreadable or stale-order record does not block another valid source.
    }
  }
  if (!matches.length && blocked) throw blocked;
  return matches;
}
