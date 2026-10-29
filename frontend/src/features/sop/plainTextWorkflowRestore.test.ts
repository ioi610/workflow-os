import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workflow, WorkflowStep } from "../../types";
import { DEFAULT_BOARD_AXES } from "./boardAxes";
import { completeWorkflowText } from "./completeWorkflowText";
import { connectProcedure } from "./connectedProcedure";
import { generateWorkflow } from "./generatedWorkflow";
import {
  findPlainTextWorkflowMatches,
  plainTextMatchesWorkflow,
  readStoredPlainTextWorkflowOrder,
} from "./plainTextWorkflowRestore";
import { attachOriginalWorkflowText } from "./workflowTextOrigin";
import { prepareWorkflowTransferImport } from "./workflowTransfer";
import { readWorkflow, resolveModuleLink } from "./workflows";

function diagram(
  steps: WorkflowStep[],
  fields: Partial<Workflow> = {},
): Workflow {
  return {
    id: "original-diagram",
    title: "完整工作流程",
    category: "自用",
    revision: 7,
    draft: JSON.stringify(steps),
    boardSettings: null,
    ...fields,
  };
}

function fullDiagram(): Workflow {
  const steps: WorkflowStep[] = [];
  for (let index = 0; index < 33; index++) {
    const id = `module-${index}`;
    steps.push(
      {
        kind: "MODULE",
        id,
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
        unknownModule: { index, literal: "保留所有原始字段" },
      },
      {
        kind: "DETAIL",
        id: `detail-${index}`,
        title: `工作${String(index + 1).padStart(2, "0")}`,
        items: [
          {
            id: `item-${index}`,
            text: "保留这项工作的详细说明和操作记录。",
            unknownItem: [index, false],
          },
        ],
      },
    );
  }
  return diagram(steps, {
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
      unknownAxis: "保留原设置",
    }),
  });
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

afterEach(() => vi.unstubAllGlobals());

describe("restore ordinary full workflow text from an existing diagram", () => {
  it("restores all 33 modules from three ordinary paragraphs with exact boxes, arrows, axes and instructions", () => {
    const source = freeze(fullDiagram());
    const before = JSON.stringify(source);
    const generated = generateWorkflow(source, [source]);
    const prose = completeWorkflowText(source, generated);
    expect(prose.split("\n\n")).toHaveLength(3);
    expect(prose).not.toContain("WORKFLOW OS RESTORE");

    const matches = findPlainTextWorkflowMatches(prose, [source]);
    expect(matches).toHaveLength(1);
    expect(matches[0].moduleCount).toBe(33);
    expect(matches[0].transfer.steps).toEqual(JSON.parse(source.draft));
    expect(matches[0].transfer.boardSettings).toBe(source.boardSettings);
    expect(matches[0].transfer.order).toEqual(
      connectProcedure(generated).entryOrder,
    );
    const imported = prepareWorkflowTransferImport(matches[0].transfer);
    const restored = diagram(imported.steps, {
      id: "new-diagram",
      boardSettings: imported.boardSettings,
    });
    expect(readWorkflow(restored.draft).modules).toHaveLength(33);
    expect(readWorkflow(restored.draft).details).toHaveLength(33);
    expect(
      completeWorkflowText(restored, generateWorkflow(restored, [restored])),
    ).toBe(prose);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("accepts clipboard line endings and outer whitespace without changing copied contents", () => {
    const source = fullDiagram();
    const prose = completeWorkflowText(
      source,
      generateWorkflow(source, [source]),
    );
    const pasted = ` \r\n${prose.replace(/\n/g, "\r\n")}\r\n `;
    const [match] = findPlainTextWorkflowMatches(pasted, [source]);
    expect(match.moduleCount).toBe(33);
    expect(match.transfer.prose).toBe(prose);
    expect(match.transfer.steps).toEqual(JSON.parse(source.draft));
  });

  it("accepts a manually selected whole page with its exact title and one or two newlines before the body", () => {
    const source = fullDiagram();
    const prose = completeWorkflowText(
      source,
      generateWorkflow(source, [source]),
    );
    for (const separator of ["\n", "\n\n", "\r\n", "\r\n\r\n"]) {
      const text = ` \r\n${source.title}${separator}${prose}\r\n `;
      expect(plainTextMatchesWorkflow(text, prose, source.title)).toBe(true);
      const [match] = findPlainTextWorkflowMatches(text, [source]);
      expect(match.moduleCount).toBe(33);
      expect(match.transfer.steps).toEqual(JSON.parse(source.draft));
      expect(match.transfer.prose).toBe(prose);
    }
    for (const text of [
      `其他标题\n${prose}`,
      `${source.title}\n\n\n${prose}`,
      `${source.title} ${prose}`,
      `${source.title}\n提示文字\n${prose}`,
    ]) {
      expect(plainTextMatchesWorkflow(text, prose, source.title)).toBe(false);
      expect(findPlainTextWorkflowMatches(text, [source])).toEqual([]);
    }
    expect(plainTextMatchesWorkflow("", "")).toBe(false);
  });

  it("does not guess a match for partial text, changed words, punctuation or internal whitespace", () => {
    const source = fullDiagram();
    const prose = completeWorkflowText(
      source,
      generateWorkflow(source, [source]),
    );
    for (const text of [
      "",
      " \n\n ",
      prose.split("\n\n")[0],
      prose.replace("工作01", "工作一"),
      prose.replace("。", "！"),
      prose.replace("\n\n", "\n"),
      prose.replace("工作01", "工作 01"),
    ])
      expect(findPlainTextWorkflowMatches(text, [source])).toEqual([]);
  });

  it("returns both original 33-module and bad 3-module matches instead of silently choosing the small one", () => {
    const source = fullDiagram();
    const prose = completeWorkflowText(
      source,
      generateWorkflow(source, [source]),
    );
    const badSteps: WorkflowStep[] = prose
      .split("\n\n")
      .map((paragraph, i) => ({
        kind: "MODULE",
        id: `collapsed-${i}`,
        title: `错误段落${i + 1}`,
        description: paragraph,
      }));
    const collapsed = diagram(
      attachOriginalWorkflowText({ steps: badSteps }, prose),
      { id: "bad-diagram", title: "上次误生成的流程" },
    );
    const matches = findPlainTextWorkflowMatches(prose, [collapsed, source]);
    expect(
      matches.map(({ workflowId, moduleCount }) => ({
        workflowId,
        moduleCount,
      })),
    ).toEqual([
      { workflowId: collapsed.id, moduleCount: 3 },
      { workflowId: source.id, moduleCount: 33 },
    ]);
  });

  it("captures shared details and makes the imported graph independent from the old source", () => {
    const shared = diagram(
      [
        {
          kind: "DETAIL",
          id: "shared-detail",
          title: "共享做法",
          description: "保留说明。",
          // Older stored documents can contain line arrays despite today's type.
          materials: ["水", "容器"] as unknown as string,
          safetyNotice: "保持通风。",
          imageUrl: "https://example.test/reference.png",
          items: [{ id: "instruction", text: "按原来的完整说明操作。" }],
        },
      ],
      { id: "shared-diagram" },
    );
    const source = diagram([
      {
        kind: "MODULE",
        id: "work",
        title: "使用共享做法",
        detailId: "shared-detail",
        detailWorkflowId: shared.id,
        frame: { x: 22, y: 44, width: 240, height: 180 },
      },
    ]);
    const library = [source, shared];
    const prose = completeWorkflowText(
      source,
      generateWorkflow(source, library),
    );
    const [match] = findPlainTextWorkflowMatches(prose, library);
    expect(match.workflowId).toBe(source.id);
    expect(match.transfer.referencedDetails).toHaveLength(1);
    expect(match.transfer.referencedDetails[0].detail).toEqual(
      readWorkflow(shared.draft).details[0],
    );
    const imported = prepareWorkflowTransferImport(match.transfer);
    const restored = diagram(imported.steps, { id: "independent-diagram" });
    const module = readWorkflow(restored.draft).modules[0];
    expect(module.detailWorkflowId).toBeUndefined();
    expect(resolveModuleLink(restored, module, [restored]).status).toBe(
      "MATCHED",
    );
    expect(
      completeWorkflowText(restored, generateWorkflow(restored, [restored])),
    ).toBe(prose);
  });

  it("uses the user's valid manual full-procedure order and preserves it in the transfer", () => {
    const source = diagram([
      { kind: "MODULE", id: "a", title: "先记录" },
      { kind: "MODULE", id: "b", title: "后记录" },
      { kind: "MODULE", id: "c", title: "独立工作" },
    ]);
    const generated = generateWorkflow(source, [source]);
    const order = ["c", "b", "a"];
    const prose = completeWorkflowText(
      source,
      generated,
      connectProcedure(generated, order),
    );
    expect(findPlainTextWorkflowMatches(prose, [source])).toEqual([]);
    const readOrder = vi.fn((_id: string, current: typeof generated) => {
      expect(current.entries).toEqual(generated.entries);
      return order;
    });
    const [match] = findPlainTextWorkflowMatches(prose, [source], readOrder);
    expect(readOrder).toHaveBeenCalledWith(source.id, generated);
    expect(match.transfer.order).toEqual(order);
  });

  it("uses the stored original text and original order while its exact snapshot remains unchanged", () => {
    const text = "准备\n检查\n完成";
    const originalSteps: WorkflowStep[] = [
      { kind: "MODULE", id: "a", title: "准备" },
      { kind: "MODULE", id: "b", title: "检查" },
      { kind: "MODULE", id: "c", title: "完成" },
    ];
    const order = ["c", "a", "b"];
    const source = diagram(
      attachOriginalWorkflowText({ steps: originalSteps }, text, order),
    );
    const [match] = findPlainTextWorkflowMatches(text, [source]);
    expect(match.transfer.order).toEqual(order);
    expect(match.transfer.steps).toEqual(JSON.parse(source.draft));
    const altered = {
      ...source,
      draft: source.draft.replace('"title":"准备"', '"title":"重新准备"'),
    };
    expect(findPlainTextWorkflowMatches(text, [altered])).toEqual([]);
  });

  it("skips an unexportable candidate or stale manual order without blocking another valid source", () => {
    const source = diagram([{ kind: "MODULE", id: "a", title: "操作" }]);
    const prose = completeWorkflowText(
      source,
      generateWorkflow(source, [source]),
    );
    const invalid = { ...source, id: "invalid", title: "" };
    const stale = { ...source, id: "stale", title: "顺序过期" };
    expect(
      findPlainTextWorkflowMatches(prose, [invalid, stale, source], (id) =>
        id === stale.id ? ["missing-module"] : undefined,
      ).map((match) => match.workflowId),
    ).toEqual([source.id]);
  });

  it("blocks lossy fallback when the ordinary prose matches a source that cannot be restored", () => {
    const source = diagram([{ kind: "MODULE", id: "a", title: "操作" }]);
    const prose = completeWorkflowText(
      source,
      generateWorkflow(source, [source]),
    );
    const invalid = { ...source, title: "" };
    expect(() => findPlainTextWorkflowMatches(prose, [invalid])).toThrow(
      "找到这份文字对应的原流程，但暂时无法完整还原。",
    );
    const missingSource = diagram([
      {
        kind: "MODULE",
        id: "a",
        title: "操作",
        detailId: "missing-detail",
        detailWorkflowId: "missing-diagram",
      },
    ]);
    expect(
      completeWorkflowText(
        missingSource,
        generateWorkflow(missingSource, [missingSource]),
      ),
    ).toBe(prose);
    expect(() => findPlainTextWorkflowMatches(prose, [missingSource])).toThrow(
      "引用的具体做法没有完整副本",
    );
    expect(
      findPlainTextWorkflowMatches(prose, [invalid, missingSource, source]),
    ).toHaveLength(1);
  });

  it("performs no network, browser storage or clipboard access and returns detached copies", () => {
    const forbidden = vi.fn(() => {
      throw new Error("Unexpected external access");
    });
    vi.stubGlobal("fetch", forbidden);
    vi.stubGlobal("localStorage", { getItem: forbidden, setItem: forbidden });
    vi.stubGlobal("sessionStorage", { getItem: forbidden, setItem: forbidden });
    vi.stubGlobal("navigator", {
      clipboard: { readText: forbidden, writeText: forbidden },
    });
    const source = freeze(fullDiagram());
    const prose = completeWorkflowText(
      source,
      generateWorkflow(source, [source]),
    );
    const [match] = findPlainTextWorkflowMatches(prose, [source]);
    match.transfer.steps[0].title = "只改副本";
    expect(readWorkflow(source.draft).modules[0].title).toBe("工作01");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("reads an isolated person's saved manual order, including valid older grouping signatures", () => {
    const source = diagram([
      { kind: "MODULE", id: "a", title: "工作一" },
      { kind: "MODULE", id: "b", title: "工作二" },
    ]);
    const generated = generateWorkflow(source, [source]);
    const order = ["b", "a"];
    const signature = {
      entries: generated.entries.map((entry) => [entry.id, entry.minute]),
      groups: generated.groups.map((group) => [group.id, group.entryIds]),
      edges: generated.edges,
    };
    const setItem = vi.fn();
    const getItem = vi.fn(() =>
      JSON.stringify({ signature: JSON.stringify(signature), order }),
    );
    vi.stubGlobal("localStorage", { getItem, setItem });
    expect(
      readStoredPlainTextWorkflowOrder("person", "org", source.id, generated),
    ).toEqual(order);
    expect(getItem).toHaveBeenLastCalledWith(
      `workflow-os:procedure-order:person:org:${source.id}`,
    );
    getItem.mockReturnValue(
      JSON.stringify({
        signature: JSON.stringify({
          ...signature,
          groups: [["old-group", ["a", "b"]]],
        }),
        order,
      }),
    );
    expect(
      readStoredPlainTextWorkflowOrder("person", "org", source.id, generated),
    ).toEqual(order);
    expect(setItem).not.toHaveBeenCalled();
    getItem.mockClear();
    expect(
      readStoredPlainTextWorkflowOrder(undefined, "org", source.id, generated),
    ).toBeUndefined();
    expect(getItem).not.toHaveBeenCalled();
  });

  it("ignores stale, malformed or inaccessible saved manual orders", () => {
    const source = diagram([
      { kind: "MODULE", id: "a", title: "工作一", nextModuleIds: ["b"] },
      { kind: "MODULE", id: "b", title: "工作二" },
    ]);
    const generated = generateWorkflow(source, [source]);
    const signature = {
      entries: generated.entries.map((entry) => [entry.id, entry.minute]),
      groups: generated.groups.map((group) => [group.id, group.entryIds]),
      edges: generated.edges,
    };
    const getItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem });
    for (const stored of [
      "{broken",
      JSON.stringify({ order: ["a", "b"] }),
      JSON.stringify({
        signature: JSON.stringify(signature),
        order: ["a", "a"],
      }),
      JSON.stringify({
        signature: JSON.stringify(signature),
        order: ["b", "a"],
      }),
      JSON.stringify({
        signature: JSON.stringify({ ...signature, edges: [] }),
        order: ["a", "b"],
      }),
      JSON.stringify({
        signature: JSON.stringify({ ...signature, entries: [] }),
        order: ["a", "b"],
      }),
    ]) {
      getItem.mockReturnValue(stored);
      expect(
        readStoredPlainTextWorkflowOrder("person", "org", source.id, generated),
      ).toBeUndefined();
    }
    getItem.mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    expect(
      readStoredPlainTextWorkflowOrder("person", "org", source.id, generated),
    ).toBeUndefined();
  });
});
