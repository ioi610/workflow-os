import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workflow, WorkflowStep } from "../../types";
import { completeWorkflowText } from "./completeWorkflowText";
import { connectProcedure } from "./connectedProcedure";
import { generateWorkflow } from "./generatedWorkflow";
import { parseLocalTextDiagram } from "./localTextDiagram";
import { createTextDiagramDraft } from "./textDiagram";
import {
  attachOriginalWorkflowText,
  originalWorkflowOrder,
  originalWorkflowText,
} from "./workflowTextOrigin";

afterEach(() => vi.unstubAllGlobals());
const source =
  "  流程：午餐\r\n1. 洗菜：用清水洗净。\r\n2. 切菜：切成 1.5cm 小块。\n\n  ";
function record(steps: WorkflowStep[], boardSettings: string | null): Workflow {
  return {
    id: "new-flow",
    title: "午餐",
    category: "",
    revision: 0,
    draft: JSON.stringify(steps),
    boardSettings,
  };
}
function imported() {
  const draft = createTextDiagramDraft(parseLocalTextDiagram(source).diagram);
  return record(attachOriginalWorkflowText(draft, source), draft.boardSettings);
}
function text(workflow: Workflow, library = [workflow]) {
  const generated = generateWorkflow(workflow, library);
  const procedure = connectProcedure(
    generated,
    originalWorkflowOrder(workflow, generated),
  );
  return completeWorkflowText(workflow, generated, procedure);
}

describe("exact original text for unmodified generated workflows", () => {
  it("keeps original line endings, spaces, names and punctuation without a network or storage request", () => {
    const request = vi.fn(() => {
      throw new Error("No network for source text");
    });
    vi.stubGlobal("fetch", request);
    expect(text(imported())).toBe(source);
    expect(request).not.toHaveBeenCalled();
  });

  it("survives server JSON key ordering and normalized board-settings whitespace", () => {
    const workflow = imported();
    const reversed = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reversed);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, child]) => [key, reversed(child)]),
        );
      return value;
    };
    workflow.draft = JSON.stringify(
      reversed(JSON.parse(workflow.draft)),
      null,
      2,
    );
    workflow.boardSettings = JSON.stringify(
      reversed(JSON.parse(workflow.boardSettings!)),
      null,
      2,
    );
    expect(text(workflow)).toBe(source);
  });

  it.each(["instructions", "name", "arrow", "position", "settings"])(
    "does not hide edits to %s behind stale original prose",
    (kind) => {
      const workflow = imported();
      const steps = JSON.parse(workflow.draft) as WorkflowStep[];
      if (kind === "instructions")
        (
          steps.find((step) => step.kind === "DETAIL")!.items as {
            text: string;
          }[]
        )[0].text = "新改的做法。";
      if (kind === "name") steps[0].title = "新的工作名称";
      if (kind === "arrow") steps[0].nextModuleIds = [];
      if (kind === "position") (steps[0].frame as { x: number }).x += 1;
      if (kind === "settings") {
        const settings = JSON.parse(workflow.boardSettings!);
        settings.canvas.width += 1;
        workflow.boardSettings = JSON.stringify(settings);
      }
      workflow.draft = JSON.stringify(steps);
      const generated = generateWorkflow(workflow, [workflow]);
      expect(
        originalWorkflowText(
          workflow,
          generated,
          connectProcedure(generated).entryOrder,
        ),
      ).toBeNull();
      expect(text(workflow)).not.toBe(source);
      if (kind === "instructions")
        expect(text(workflow)).toContain("新改的做法。");
      if (kind === "name") expect(text(workflow)).toContain("新的工作名称");
    },
  );

  it("persists a valid selected order but invalidates original text for a different order", () => {
    const draft = createTextDiagramDraft(
      parseLocalTextDiagram("甲：做甲。\n乙：做乙。").diagram,
    );
    draft.steps = draft.steps.map((step) =>
      step.kind === "MODULE"
        ? { ...step, nextModuleIds: [], connectionPorts: {} }
        : step,
    );
    const ids = draft.steps
      .filter((step) => step.kind === "MODULE")
      .map((step) => step.id!);
    const order = [...ids].reverse();
    const workflow = record(
      attachOriginalWorkflowText(draft, "乙先做，甲后做。", order),
      draft.boardSettings,
    );
    const generated = generateWorkflow(workflow, [workflow]);
    expect(originalWorkflowOrder(workflow, generated)).toEqual(order);
    expect(
      completeWorkflowText(
        workflow,
        generated,
        connectProcedure(generated, order),
      ),
    ).toBe("乙先做，甲后做。");
    expect(originalWorkflowText(workflow, generated, ids)).toBeNull();
  });

  it("replaces its own metadata instead of nesting copies on every transfer", () => {
    const workflow = imported();
    const before = workflow.draft;
    const steps = attachOriginalWorkflowText(
      { steps: JSON.parse(before), boardSettings: workflow.boardSettings },
      source,
    );
    expect(JSON.stringify(steps)).toBe(before);
    expect(
      attachOriginalWorkflowText({ steps: [], boardSettings: null }, ""),
    ).toEqual([]);
  });
});
