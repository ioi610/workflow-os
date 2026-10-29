import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Workflow, WorkflowStep } from "../../types";
import {
  generateLocalTextPreview,
  isTextPreviewCurrent,
  TextDiagramControls,
  TextDiagramPreview,
  WorkflowTextAmbiguity,
  WorkflowTextMatchChoices,
} from "./TextDiagramControls";
import { createTextDiagramDraft, type TextDiagram } from "./textDiagram";
import { completeWorkflowText } from "./completeWorkflowText";
import { generateWorkflow } from "./generatedWorkflow";
import {
  attachOriginalWorkflowText,
  originalWorkflowOrder,
} from "./workflowTextOrigin";
import { DEFAULT_BOARD_AXES } from "./boardAxes";
import { findPlainTextWorkflowMatches } from "./plainTextWorkflowRestore";
import {
  findRecordedWorkflowCopies,
  rememberWorkflowCopySnapshot,
} from "./workflowCopySnapshots";
import {
  serializeWorkflowTransfer,
  WORKFLOW_TRANSFER_START,
} from "./workflowTransfer";

function originalThirtyThree(): Workflow {
  const steps: WorkflowStep[] = Array.from({ length: 33 }, (_, index) => [
    {
      kind: "MODULE",
      id: `module-${index}`,
      title: `工作${String(index + 1).padStart(2, "0")}`,
      detailId: `detail-${index}`,
      frame: {
        x: 12.25 + (index % 6) * 150,
        y: 18.5 + Math.floor(index / 6) * 95,
        width: 100 + (index % 4),
        height: 60 + (index % 5),
      },
      ...(index < 32
        ? {
            nextModuleIds: [`module-${index + 1}`],
            connectionPorts: {
              [`module-${index + 1}`]: {
                source: index % 2 ? "bottom" : "right",
                target: index % 2 ? "top" : "left",
              },
            },
          }
        : {}),
      custom: { original: true, index },
    },
    {
      kind: "DETAIL",
      id: `detail-${index}`,
      title: `工作${String(index + 1).padStart(2, "0")}`,
      items: [
        { id: `item-${index}`, text: "保留这项工作的详细说明和操作记录。" },
      ],
    },
  ]).flat();
  return {
    id: "thirty-three-original",
    title: "  三十三项工作  ",
    category: "  我自己用  ",
    revision: 27,
    boardSettings: JSON.stringify({
      ...DEFAULT_BOARD_AXES,
      timeline: {
        enabled: true,
        axis: "x",
        startMinute: 480,
        endMinute: 1140,
        segments: [{ startOffset: 60, endOffset: 120, scale: 4 }],
      },
      priority: { enabled: true, axis: "y" },
      canvas: { width: 1400, height: 900 },
      referenceCanvas: { width: 820, height: 820 },
    }),
    draft: JSON.stringify(steps),
  };
}

const context: Context = {
  org: "test-org",
  role: "OWNER",
  user: {},
  notify: vi.fn(),
};
afterEach(() => vi.unstubAllGlobals());

describe("free local text to diagram controls", () => {
  it("shows only an explicit entry without sending text, generating, or creating a workflow on render", () => {
    const request = vi.fn(() => {
      throw new Error("No request until the user generates a preview");
    });
    vi.stubGlobal("fetch", request);
    const markup = renderToStaticMarkup(
      createElement(TextDiagramControls, context),
    );
    expect(markup).toContain("文字生成流程图");
    expect(markup).toContain('type="button"');
    expect(markup).not.toContain("<dialog");
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("添加为新流程");
    expect(request).not.toHaveBeenCalled();
    expect(context.notify).not.toHaveBeenCalled();
  });

  it("does not offer creation to read-only users or a missing workspace, and respects editing busy state", () => {
    for (const props of [
      { ...context, role: "EMPLOYEE" },
      { ...context, org: "" },
    ])
      expect(
        renderToStaticMarkup(createElement(TextDiagramControls, props)),
      ).toBe("");
    const markup = renderToStaticMarkup(
      createElement(TextDiagramControls, { ...context, disabled: true }),
    );
    expect(markup).toMatch(/<button\b[^>]*disabled=""/);
  });

  it("previews every extracted name and detail as plain text, including unconnected work, without changing the data", () => {
    const diagram: TextDiagram = {
      title: "准备与检查",
      nodes: [
        {
          id: "prepare",
          name: "准备",
          details: ["清洗工具。", "<script>alert('x')</script> & 检查数量。"],
          nextIds: ["check"],
        },
        { id: "check", name: "检查", details: ["逐一检查。"], nextIds: [] },
        { id: "other", name: "另行准备", details: [], nextIds: [] },
      ],
    };
    const original = JSON.stringify(diagram),
      draft = createTextDiagramDraft(diagram);
    const workflow: Workflow = {
      id: "preview",
      title: draft.title,
      category: "",
      revision: 0,
      boardSettings: draft.boardSettings,
      draft: JSON.stringify(draft.steps),
    };
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const markup = renderToStaticMarkup(
      createElement(TextDiagramPreview, { diagram, workflow }),
    );
    expect(markup.match(/<text\b/g)).toHaveLength(3);
    expect(markup.match(/<article\b/g)).toHaveLength(3);
    expect(markup).toContain("清洗工具。");
    expect(markup).toContain("逐一检查。");
    expect(markup).toContain("另行准备");
    expect(markup).toContain("原文没有写具体做法。");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
    expect(JSON.stringify(diagram)).toBe(original);
    expect(request).not.toHaveBeenCalled();
  });

  it("generates a linked draft from actual input on request without any fetch or paid preview", () => {
    const request = vi.fn(() => {
      throw new Error("Local generation must never make a network request");
    });
    vi.stubGlobal("fetch", request);
    const source =
      "洗菜：把青菜冲洗干净。\n切菜：切成小块。\n炒菜：放入锅中炒熟。";
    const generated = generateLocalTextPreview(source);
    const modules = generated.draft.steps.filter(
      (step) => step.kind === "MODULE",
    );
    const details = generated.draft.steps.filter(
      (step) => step.kind === "DETAIL",
    );

    expect(generated.source).toBe(source);
    expect(generated.diagram.nodes.map((node) => node.name)).toEqual([
      "洗菜",
      "切菜",
      "炒菜",
    ]);
    expect(generated.diagram.nodes[0].nextIds).toEqual([
      generated.diagram.nodes[1].id,
    ]);
    expect(generated.diagram.nodes[1].nextIds).toEqual([
      generated.diagram.nodes[2].id,
    ]);
    expect(modules).toHaveLength(3);
    expect(details).toHaveLength(3);
    expect(modules[0].nextModuleIds).toEqual([modules[1].id]);
    expect(modules[1].nextModuleIds).toEqual([modules[2].id]);
    expect(JSON.stringify(details)).toContain("把青菜冲洗干净。");
    expect(JSON.stringify(details)).toContain("切成小块。");
    expect(JSON.stringify(details)).toContain("放入锅中炒熟。");
    expect(request).not.toHaveBeenCalled();
  });

  it("restores the actual 33-box chart from three ordinary complete-procedure paragraphs before any new-text splitting", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("No external service for matching");
      }),
    );
    const original = originalThirtyThree();
    const before = JSON.stringify(original);
    const text = completeWorkflowText(
      original,
      generateWorkflow(original, [original]),
    );
    expect(text.split("\n\n")).toHaveLength(3);
    const restored = generateLocalTextPreview(text, {
      workflows: [original],
      libraryReady: true,
    });
    expect(restored.diagram.nodes).toHaveLength(33);
    expect(restored.draft.title).toBe(original.title);
    expect(restored.draft.category).toBe(original.category);
    expect(restored.draft.boardSettings).toBe(original.boardSettings);
    const clean = restored.draft.steps.map(
      ({ workflowOSOriginalText: _origin, ...step }) => step,
    );
    expect(clean).toEqual(JSON.parse(original.draft));
    const saved: Workflow = {
      ...original,
      id: "restored-copy",
      draft: JSON.stringify(restored.draft.steps),
    };
    expect(completeWorkflowText(saved, generateWorkflow(saved, [saved]))).toBe(
      text,
    );
    expect(restored.notices.join("")).toContain("33 项工作");
    expect(JSON.stringify(original)).toBe(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires a source choice when an old three-box interpretation has identical prose, while the current original chart restores all 33", () => {
    const original = originalThirtyThree();
    const text = completeWorkflowText(
      original,
      generateWorkflow(original, [original]),
    );
    // Reproduce the previous bug: three paragraphs became three work boxes,
    // while their attached raw text kept the complete body identical.
    const oldDraft = createTextDiagramDraft({
      title: "以前错误拆成三项的流程",
      nodes: text.split("\n\n").map((paragraph, index) => ({
        id: `bad-${index}`,
        name: `原来的第${index + 1}段`,
        details: [paragraph],
        nextIds: [],
      })),
    });
    oldDraft.steps = attachOriginalWorkflowText(oldDraft, text);
    const oldWrong: Workflow = {
      id: "old-three-box-result",
      title: oldDraft.title,
      category: "",
      revision: 0,
      draft: JSON.stringify(oldDraft.steps),
      boardSettings: oldDraft.boardSettings,
    };
    const workflows = [oldWrong, original];
    let ambiguity: WorkflowTextAmbiguity | undefined;
    try {
      generateLocalTextPreview(text, { workflows });
    } catch (error) {
      if (error instanceof WorkflowTextAmbiguity) ambiguity = error;
      else throw error;
    }
    expect(ambiguity).toBeInstanceOf(WorkflowTextAmbiguity);
    expect(ambiguity?.matches.map((match) => match.moduleCount)).toEqual([
      3, 33,
    ]);
    const choose = vi.fn();
    const markup = renderToStaticMarkup(
      createElement(WorkflowTextMatchChoices, {
        matches: ambiguity!.matches,
        onChoose: choose,
      }),
    );
    expect(markup).toContain("选择要还原的原图");
    expect(markup).toContain("33 项工作");
    expect(markup).toContain("3 项工作");
    expect(markup.match(/<button\b/g)).toHaveLength(2);
    expect(choose).not.toHaveBeenCalled();
    const preferred = generateLocalTextPreview(text, {
      workflows,
      preferredWorkflowId: original.id,
    });
    expect(preferred.diagram.nodes).toHaveLength(33);
    expect(preferred.draft.boardSettings).toBe(original.boardSettings);
  });

  it("uses the actual recorded copy ahead of a matching current or smaller chart, and marked restore ahead of a recorded copy", () => {
    const original = originalThirtyThree();
    const text = completeWorkflowText(
      original,
      generateWorkflow(original, [original]),
    );
    const [recorded] = findPlainTextWorkflowMatches(text, [original]);
    const moved = {
      ...original,
      draft: JSON.stringify(
        JSON.parse(original.draft).map((step: WorkflowStep) =>
          step.kind === "MODULE"
            ? { ...step, frame: { ...(step.frame as object), x: 500 } }
            : step,
        ),
      ),
    };
    const restored = generateLocalTextPreview(text, {
      recordedMatches: [recorded],
      workflows: [moved],
      libraryReady: false,
    });
    expect(restored.draft.steps[0].frame).toEqual(
      JSON.parse(original.draft)[0].frame,
    );
    const marked = serializeWorkflowTransfer(moved, [moved], text);
    const explicit = generateLocalTextPreview(marked, {
      recordedMatches: [recorded],
      workflows: [original],
      libraryReady: false,
    });
    expect(explicit.draft.steps[0].frame).toEqual(
      JSON.parse(moved.draft)[0].frame,
    );
  });

  it("uses the saved ordinary-copy record from the same workspace even when the current chart is the earlier incorrect three-box result", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    vi.stubGlobal("fetch", vi.fn());
    const source = originalThirtyThree();
    const text = completeWorkflowText(
      source,
      generateWorkflow(source, [source]),
    );
    const scope = {
      userId: "recorded-import-person",
      orgId: "recorded-import-workspace",
    };
    expect(
      rememberWorkflowCopySnapshot({
        ...scope,
        text,
        transferText: serializeWorkflowTransfer(source, [source], text),
        sourceWorkflowId: source.id,
      }),
    ).toEqual({ remembered: true, persisted: true });
    const incorrect = generateLocalTextPreview(text);
    expect(incorrect.diagram.nodes).toHaveLength(3);
    const old: Workflow = {
      ...source,
      id: "earlier-three-box-chart",
      title: incorrect.draft.title,
      draft: JSON.stringify(incorrect.draft.steps),
      boardSettings: incorrect.draft.boardSettings,
    };
    const restored = generateLocalTextPreview(text, {
      recordedMatches: findRecordedWorkflowCopies(scope, text),
      workflows: [old],
      preferredWorkflowId: old.id,
      libraryReady: true,
    });
    expect(restored.diagram.nodes).toHaveLength(33);
    expect(restored.draft.boardSettings).toBe(source.boardSettings);
    expect(restored.draft.steps[0].frame).toEqual(
      JSON.parse(source.draft)[0].frame,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks ordinary guessing while the existing library has not been read", () => {
    const text = "准备：清洗工具。\n检查：逐一核对。";
    expect(() =>
      generateLocalTextPreview(text, { libraryReady: false }),
    ).toThrow(/还没有读到已有流程/);
    expect(
      generateLocalTextPreview(text, { workflows: [], libraryReady: true })
        .diagram.nodes,
    ).toHaveLength(2);
  });

  it("waits for a current library read even if a matching cached 33-box chart exists", () => {
    const source = originalThirtyThree();
    const text = completeWorkflowText(
      source,
      generateWorkflow(source, [source]),
    );
    expect(() =>
      generateLocalTextPreview(text, {
        workflows: [source],
        libraryReady: false,
      }),
    ).toThrow(/还没有读到已有流程/);
    const preview = generateLocalTextPreview(text, {
      workflows: [source],
      libraryReady: true,
    });
    expect(preview.diagram.nodes).toHaveLength(33);
    expect(
      isTextPreviewCurrent(preview, {
        workflows: [source],
        libraryReady: false,
      }),
    ).toBe(false);
  });

  it("invalidates library-derived previews when original boxes, settings, or instructions change, while unrelated changes and revision-only reads remain valid", () => {
    const source = originalThirtyThree();
    const text = completeWorkflowText(
      source,
      generateWorkflow(source, [source]),
    );
    const preview = generateLocalTextPreview(text, {
      workflows: [source],
      libraryReady: true,
    });
    expect(preview.librarySource?.workflowId).toBe(source.id);
    expect(
      isTextPreviewCurrent(preview, {
        workflows: [source],
        libraryReady: true,
      }),
    ).toBe(true);
    expect(
      isTextPreviewCurrent(preview, {
        workflows: [{ ...source, revision: source.revision + 1 }],
        libraryReady: true,
      }),
    ).toBe(true);
    const unrelated: Workflow = {
      ...source,
      id: "unrelated-workflow",
      draft: "[]",
      title: "无关流程",
    };
    expect(
      isTextPreviewCurrent(preview, {
        workflows: [unrelated, source],
        libraryReady: true,
      }),
    ).toBe(true);
    const entries: WorkflowStep[] = JSON.parse(source.draft);
    const moved = {
      ...source,
      draft: JSON.stringify(
        entries.map((step) =>
          step.kind === "MODULE"
            ? { ...step, frame: { ...(step.frame as object), x: 500 } }
            : step,
        ),
      ),
    };
    expect(
      isTextPreviewCurrent(preview, { workflows: [moved], libraryReady: true }),
    ).toBe(false);
    const changedSettings = {
      ...source,
      boardSettings: JSON.stringify({
        ...JSON.parse(source.boardSettings!),
        canvas: { width: 1500, height: 900 },
      }),
    };
    expect(
      isTextPreviewCurrent(preview, {
        workflows: [changedSettings],
        libraryReady: true,
      }),
    ).toBe(false);
    const changedSteps = {
      ...source,
      draft: JSON.stringify(
        entries.map((step) =>
          step.kind === "DETAIL"
            ? {
                ...step,
                items: [{ id: "changed", text: "修改后的具体做法。" }],
              }
            : step,
        ),
      ),
    };
    expect(
      isTextPreviewCurrent(preview, {
        workflows: [changedSteps],
        libraryReady: true,
      }),
    ).toBe(false);
    expect(
      isTextPreviewCurrent(preview, { workflows: [], libraryReady: true }),
    ).toBe(false);
  });

  it("keeps recorded, marked, and newly interpreted previews independent from subsequent library refetches", () => {
    const source = originalThirtyThree();
    const text = completeWorkflowText(
      source,
      generateWorkflow(source, [source]),
    );
    const recorded = generateLocalTextPreview(text, {
      recordedMatches: findPlainTextWorkflowMatches(text, [source]),
      libraryReady: false,
    });
    const marked = generateLocalTextPreview(
      serializeWorkflowTransfer(source, [source], text),
      { libraryReady: false },
    );
    const ordinary = generateLocalTextPreview(
      "准备：洗净工具。\n操作：处理原料。",
      { workflows: [], libraryReady: true },
    );
    for (const preview of [recorded, marked, ordinary]) {
      expect(preview.librarySource).toBeUndefined();
      expect(
        isTextPreviewCurrent(preview, { workflows: [], libraryReady: false }),
      ).toBe(true);
    }
  });

  it("returns the exact pasted ordinary text from its diagram, then restores that same diagram from copied restore text", () => {
    vi.stubGlobal("fetch", vi.fn());
    const source =
      " \n流程：做饭\n1. 洗菜：  用清水洗净，保留原文！\n2. 炒菜：炒熟后装盘。\n ";
    const first = generateLocalTextPreview(source);
    const workflow: Workflow = {
      id: "first-generated-workflow",
      title: first.draft.title,
      category: "",
      draft: JSON.stringify(first.draft.steps),
      boardSettings: first.draft.boardSettings,
      revision: 0,
    };
    const generated = generateWorkflow(workflow, [workflow]);
    const text = completeWorkflowText(workflow, generated);
    expect(first.source).toBe(source);
    expect(text).toBe(source);
    const second = generateLocalTextPreview(
      serializeWorkflowTransfer(
        workflow,
        [workflow],
        text,
        originalWorkflowOrder(workflow, generated),
      ),
    );
    expect(second.draft.steps).toEqual(first.draft.steps);
    expect(second.draft.boardSettings).toBe(first.draft.boardSettings);
    const restored: Workflow = {
      ...workflow,
      id: "second-generated-workflow",
      draft: JSON.stringify(second.draft.steps),
      boardSettings: second.draft.boardSettings,
    };
    expect(
      completeWorkflowText(restored, generateWorkflow(restored, [restored])),
    ).toBe(source);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("restores copied text with the original geometry, branch connections, settings, names and written details without requesting a service", () => {
    const request = vi.fn(() => {
      throw new Error("Restoring a diagram must remain local");
    });
    vi.stubGlobal("fetch", request);
    const steps = [
      {
        kind: "MODULE",
        id: "wash-module",
        title: "  洗菜  ",
        detailId: "wash-details",
        frame: { x: 317.25, y: 111.125, width: 190.5, height: 83.25 },
        nextModuleIds: ["cook-module", "prepare-module"],
        connectionPorts: {
          "cook-module": { source: "bottom", target: "left" },
          "prepare-module": { source: "top", target: "right" },
        },
        customValue: { labels: ["原始文字", 17] },
      },
      {
        kind: "DETAIL",
        id: "wash-details",
        title: "洗菜的具体做法",
        items: [
          { id: "wash-step-1", text: "  用清水洗净。\n再检查一遍。  " },
          { id: "wash-step-2", text: "<script>内容是文字</script>" },
        ],
        imageUrl: "https://example.test/wash.jpg",
        safetyNotice: "原来的注意事项",
      },
      {
        kind: "MODULE",
        id: "cook-module",
        title: "炒菜",
        frame: { x: 580, y: 500, width: 144, height: 120 },
        nextModuleIds: [],
      },
      {
        kind: "MODULE",
        id: "prepare-module",
        title: "准备餐具",
        position: { x: 0.1, y: 0.2 },
        size: { width: 0.15, height: 0.12 },
      },
    ];
    const workflow: Workflow = {
      id: "original-workflow",
      title: "  我的原始流程  ",
      category: "  厨房  ",
      draft: JSON.stringify(steps),
      boardSettings:
        '{ "version":1, "timeline":{"enabled":true,"startMinute":540,"endMinute":1020,"axis":"y","segments":[{"startOffset":60,"endOffset":120,"scale":3}]},"priority":{"enabled":true,"axis":"x"},"canvas":{"width":1200,"height":900}}',
      revision: 123,
    };
    const before = JSON.stringify(workflow);
    const text = serializeWorkflowTransfer(
      workflow,
      [workflow],
      "09:00，洗菜：用清水洗净。再检查一遍。炒菜。准备餐具。",
      ["wash-module", "prepare-module", "cook-module"],
    );
    const generated = generateLocalTextPreview(text);
    expect(generated.draft.title).toBe(workflow.title);
    expect(generated.draft.category).toBe(workflow.category);
    expect(generated.draft.boardSettings).toBe(workflow.boardSettings);
    expect(generated.draft.steps).toHaveLength(steps.length);
    steps.forEach((step, index) =>
      expect(generated.draft.steps[index]).toMatchObject(step),
    );
    expect(generated.diagram.nodes[0]).toEqual({
      id: "wash-module",
      name: "  洗菜  ",
      details: [
        "  用清水洗净。\n再检查一遍。  ",
        "<script>内容是文字</script>",
      ],
      nextIds: ["cook-module", "prepare-module"],
    });
    expect(generated.notices).toEqual([
      "已识别可还原文字，方框位置、连线、时间和具体做法将按原图恢复。",
    ]);
    expect(JSON.stringify(workflow)).toBe(before);
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts complete restore text beyond the ordinary prose limit without truncating or arranging its modules", () => {
    vi.stubGlobal("fetch", vi.fn());
    const written = "保留这一条具体做法。".repeat(1800);
    const workflow: Workflow = {
      id: "long-text-workflow",
      title: "长内容",
      category: "",
      revision: 0,
      boardSettings: null,
      draft: JSON.stringify([
        {
          kind: "MODULE",
          id: "long-module",
          title: "完整做法",
          detailId: "long-detail",
          frame: { x: 113, y: 227, width: 173, height: 109 },
        },
        {
          kind: "DETAIL",
          id: "long-detail",
          title: "完整做法",
          items: [{ id: "long-item", text: written }],
        },
      ]),
    };
    const copied = serializeWorkflowTransfer(workflow, [workflow], written);
    expect(copied.length).toBeGreaterThan(16000);
    const generated = generateLocalTextPreview(copied);
    expect(generated.diagram.nodes[0].details).toEqual([written]);
    expect(generated.draft.boardSettings).toBeNull();
    expect(generated.draft.steps[0].frame).toEqual({
      x: 113,
      y: 227,
      width: 173,
      height: 109,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("previews imported source documents as independent local copies instead of linking the new diagram to an old workflow", () => {
    vi.stubGlobal("fetch", vi.fn());
    const original: Workflow = {
      id: "original-with-references",
      title: "我的流程",
      category: "",
      revision: 0,
      draft: JSON.stringify([
        {
          kind: "MODULE",
          id: "reference-module",
          title: "检查",
          detailId: "external-detail",
          detailWorkflowId: "shared-workflow",
          frame: { x: 220, y: 115, width: 178, height: 91 },
        },
      ]),
    };
    const source: Workflow = {
      id: "shared-workflow",
      title: "共用做法",
      category: "",
      revision: 0,
      draft: JSON.stringify([
        {
          kind: "DETAIL",
          id: "external-detail",
          title: "检查的做法",
          items: [{ id: "external-item", text: "逐一检查并确认数量。" }],
        },
      ]),
    };
    const generated = generateLocalTextPreview(
      serializeWorkflowTransfer(
        original,
        [original, source],
        "检查：逐一检查并确认数量。",
      ),
    );
    expect(generated.diagram.nodes[0].details).toEqual([
      "逐一检查并确认数量。",
    ]);
    expect(generated.draft.steps[0].detailWorkflowId).toBeUndefined();
    expect(generated.draft.steps[0].frame).toEqual({
      x: 220,
      y: 115,
      width: 178,
      height: 91,
    });
    const copiedDetail = generated.draft.steps.find(
      (step) => step.id === generated.draft.steps[0].detailId,
    );
    expect(copiedDetail?.kind).toBe("DETAIL");
    expect(copiedDetail?.items).toEqual([
      { id: "external-item", text: "逐一检查并确认数量。" },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports damaged or unsupported restore data instead of guessing a new diagram from it", () => {
    vi.stubGlobal("fetch", vi.fn());
    expect(() =>
      generateLocalTextPreview(`洗菜。\n\n${WORKFLOW_TRANSFER_START}\n{`),
    ).toThrow(/不完整|损坏/);
    const workflow: Workflow = {
      id: "unsupported-version",
      title: "流程",
      category: "",
      revision: 0,
      draft: "[]",
    };
    const copied = serializeWorkflowTransfer(workflow, [workflow], "洗菜。");
    expect(() =>
      generateLocalTextPreview(copied.replace('"version":1', '"version":99')),
    ).toThrow(/版本/);
    expect(() =>
      generateLocalTextPreview(copied.replace(/^洗菜。/, "切菜。")),
    ).toThrow(/不一致/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
