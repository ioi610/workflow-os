import { describe, expect, it } from "vitest";
import type { Workflow, WorkflowStep } from "../../types";
import { DEFAULT_BOARD_AXES } from "./boardAxes";
import { canvasArrows } from "./canvas";
import { completeWorkflowText } from "./completeWorkflowText";
import { generateWorkflow } from "./generatedWorkflow";
import {
  parseWorkflowTransfer,
  prepareWorkflowTransferImport,
  serializeWorkflowTransfer,
  WORKFLOW_TRANSFER_END,
  WORKFLOW_TRANSFER_MAX_LENGTH,
  WORKFLOW_TRANSFER_START,
} from "./workflowTransfer";
import { readWorkflow, resolveModuleLink } from "./workflows";

const workflow = (
  steps: WorkflowStep[],
  fields: Partial<Workflow> = {},
): Workflow => ({
  id: "original-workflow",
  revision: 7,
  title: "完整做饭流程",
  category: "自用",
  draft: JSON.stringify(steps),
  boardSettings: null,
  ...fields,
});

function complexWorkflow() {
  const modules = [
    {
      kind: "MODULE",
      id: "a",
      title: " 洗菜 ",
      detailId: "da",
      detailWorkflowId: "original-workflow",
      frame: { x: 0, y: 0, width: 170, height: 74 },
      nextModuleIds: ["b", "c"],
      connectionPorts: {
        b: { source: "right", target: "left" },
        c: { source: "bottom", target: "top" },
      },
      unknownModule: { literal: '  引号"与\n换行  ', flags: [false, null, 3] },
    },
    {
      kind: "MODULE",
      id: "b",
      title: "切菜",
      detailId: "db",
      frame: { x: 330.125, y: 30.75, width: 300.5, height: 70 },
      nextModuleIds: ["d"],
      connectionPorts: { d: { source: "bottom", target: "right" } },
    },
    {
      kind: "MODULE",
      id: "c",
      title: "烧水",
      detailId: "dc",
      position: { x: 0.1, y: 0.6 },
      size: { width: 0.4, height: 0.18 },
      nextModuleIds: ["d"],
      connectionPorts: { d: { source: "left", target: "right" } },
    },
    {
      kind: "MODULE",
      id: "d",
      title: "炒菜",
      detailId: "dd",
      frame: { x: 1050, y: 610, width: 150, height: 90 },
      nextModuleIds: ["a"],
      connectionPorts: { a: { source: "top", target: "bottom" } },
    },
  ];
  const details = [
    {
      kind: "DETAIL",
      id: "da",
      title: "洗菜",
      items: [
        {
          id: "ia",
          text: `  原句\r\n保持\"引号\"，和符号：→。\n${WORKFLOW_TRANSFER_START}\n${WORKFLOW_TRANSFER_END}  `,
          unknownItem: { enabled: true },
        },
      ],
      description: "单独描述\n第二行",
      materials: "  清水  ",
      safetyNotice: " 小心刀具。 ",
      imageUrl: "https://example.test/image.png",
      videoUrl: "/api/orgs/personal/files/movie.mp4",
      opaque: ["保留", { shape: "square" }],
    },
    {
      kind: "DETAIL",
      id: "db",
      title: "切菜",
      items: [{ id: "ib", text: "" }],
      legacyEmpty: false,
    },
    { kind: "DETAIL", id: "dc", title: "烧水", items: [], legacyEmpty: true },
    {
      kind: "DETAIL",
      id: "dd",
      title: "炒菜",
      items: [{ id: "id", text: "倒油。\n炒熟，装盘。" }],
    },
  ];
  return workflow(
    [
      details[0],
      modules[0],
      modules[1],
      details[1],
      modules[2],
      details[2],
      modules[3],
      details[3],
    ],
    {
      boardSettings: JSON.stringify(
        {
          ...DEFAULT_BOARD_AXES,
          timeline: {
            enabled: true,
            startMinute: 420,
            endMinute: 1140,
            axis: "y",
            segments: [
              { startOffset: 0, endOffset: 60, scale: 3 },
              { startOffset: 180, endOffset: 240, scale: 0.25 },
            ],
          },
          priority: { enabled: true, axis: "x" },
          canvas: { width: 1200, height: 700 },
          referenceCanvas: { width: 820, height: 820 },
          opaqueAxis: "原设置保留",
        },
        null,
        2,
      ),
    },
  );
}

function transferEnvelope(
  value: Workflow = complexWorkflow(),
  prose = "完整原文。",
) {
  const text = serializeWorkflowTransfer(value, [value], prose);
  const start =
    text.indexOf(`\n${WORKFLOW_TRANSFER_START}\n`) +
    WORKFLOW_TRANSFER_START.length +
    2;
  const end = text.lastIndexOf(`\n${WORKFLOW_TRANSFER_END}`);
  return JSON.parse(text.slice(start, end)) as Record<string, any>;
}

const marked = (payload: Record<string, any>) =>
  `${payload.prose}\n\n${WORKFLOW_TRANSFER_START}\n${JSON.stringify(payload)}\n${WORKFLOW_TRANSFER_END}`;

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

describe("reversible workflow transfer text", () => {
  it("round-trips raw entries, order, exact prose, rectangular geometry, all four ports, cycles and nonlinear axes", () => {
    const original = freeze(complexWorkflow());
    const prose = `  第一句。\r\n\n保留“完整文字”。\n${WORKFLOW_TRANSFER_START}\n${WORKFLOW_TRANSFER_END}  `;
    const order = ["a", "c", "b", "d"];
    const text = serializeWorkflowTransfer(original, [original], prose, order);
    const parsed = parseWorkflowTransfer(text)!;
    expect(parsed.title).toBe(original.title);
    expect(parsed.category).toBe(original.category);
    expect(parsed.steps).toEqual(JSON.parse(original.draft));
    expect(parsed.boardSettings).toBe(original.boardSettings);
    expect(parsed.prose).toBe(prose);
    expect(parsed.order).toEqual(order);
    expect(parsed.referencedDetails).toHaveLength(4);
    expect(
      canvasArrows(readWorkflow(JSON.stringify(parsed.steps)).modules),
    ).toEqual(canvasArrows(readWorkflow(original.draft).modules));
    expect(
      serializeWorkflowTransfer(
        { ...original, draft: JSON.stringify(parsed.steps) },
        [original],
        parsed.prose,
        parsed.order,
      ),
    ).toBe(text);
  });

  it("keeps legacy arrays and their derived IDs without canonicalizing the raw entries", () => {
    const original = workflow([
      {
        title: "旧工作一",
        description: "  旧的做法\n换行  ",
        unknown: { color: "red" },
        nextModuleIds: ["module-old-two"],
      },
      { id: "old-two", title: "旧工作二", description: "" },
    ]);
    const parsed = parseWorkflowTransfer(
      serializeWorkflowTransfer(original, [original], "旧的完整文字。", [
        "module-legacy-0",
        "module-old-two",
      ]),
    )!;
    expect(parsed.steps).toEqual(JSON.parse(original.draft));
    expect(prepareWorkflowTransferImport(parsed).steps).toEqual(parsed.steps);
  });

  it("accepts clipboard exterior whitespace and normalized CRLF but retains payload prose literally", () => {
    const original = complexWorkflow();
    const prose = "  第一行\r\n第二行。  ";
    const copied = serializeWorkflowTransfer(original, [original], prose);
    expect(parseWorkflowTransfer(`\n ${copied.trim()} \n`)!.prose).toBe(prose);
    expect(parseWorkflowTransfer(copied.replace(/\r\n/g, "\n"))!.prose).toBe(
      prose,
    );
  });

  it("distinguishes ordinary text from damaged marked documents instead of guessing a partial diagram", () => {
    expect(
      parseWorkflowTransfer("洗菜：用水洗净。\n切菜：切成块。"),
    ).toBeNull();
    const valid = marked(transferEnvelope());
    for (const broken of [
      valid.replace(WORKFLOW_TRANSFER_END, ""),
      valid.replace(WORKFLOW_TRANSFER_START, ""),
      `${valid}\n多出来的内容`,
      `普通文字\n${WORKFLOW_TRANSFER_START}\n{\n${WORKFLOW_TRANSFER_END}`,
      valid.replace("完整原文。", "修改了可读文字。"),
    ])
      expect(() => parseWorkflowTransfer(broken)).toThrow(/还原|流程文字/);
    const newer = transferEnvelope();
    newer.version = 2;
    expect(() => parseWorkflowTransfer(marked(newer))).toThrow(/版本/);
  });

  it("rejects malformed IDs, names, counts, item text, geometry, axes, arrows and ports", () => {
    const corruptions: ((payload: Record<string, any>) => void)[] = [
      (payload) => {
        payload.steps[2].id = "a";
      },
      (payload) => {
        payload.steps[2].title = "洗菜";
      },
      (payload) => {
        payload.steps[0].id = "";
      },
      (payload) => {
        payload.steps[0].items = Array.from({ length: 101 }, () => ({
          text: "操作。",
        }));
      },
      (payload) => {
        payload.steps[0].items[0].text = { unexpected: true };
      },
      (payload) => {
        payload.steps[1].frame.width = 12;
      },
      (payload) => {
        payload.steps[1].frame.x = 1200;
      },
      (payload) => {
        payload.steps[1].nextModuleIds = ["does-not-exist"];
      },
      (payload) => {
        payload.steps[1].nextModuleIds = ["b", "b"];
      },
      (payload) => {
        payload.steps[1].connectionPorts.b.source = "center";
      },
      (payload) => {
        payload.order = ["a"];
      },
      (payload) => {
        payload.boardSettings = "{broken";
      },
      (payload) => {
        payload.boardSettings = JSON.stringify({
          ...DEFAULT_BOARD_AXES,
          canvas: { width: 99999, height: 820 },
        });
      },
      (payload) => {
        payload.steps[0].imageUrl = "javascript:alert(1)";
      },
      (payload) => {
        payload.steps = Array.from({ length: 101 }, (_, index) => ({
          kind: "MODULE",
          id: `many-${index}`,
          title: `工作${index}`,
        }));
        payload.referencedDetails = [];
      },
    ];
    for (const corrupt of corruptions) {
      const payload = transferEnvelope();
      corrupt(payload);
      expect(() => parseWorkflowTransfer(marked(payload))).toThrow();
    }
  });

  it("bounds marked text, JSON depth and unsafe object fields without executing or polluting anything", () => {
    const payload = transferEnvelope();
    payload.prose = "字".repeat(WORKFLOW_TRANSFER_MAX_LENGTH);
    expect(() => parseWorkflowTransfer(marked(payload))).toThrow(/太长/);
    const nested = transferEnvelope();
    let field = nested;
    for (let index = 0; index < 70; index++) {
      field.deep = {};
      field = field.deep;
    }
    expect(() => parseWorkflowTransfer(marked(nested))).toThrow(/复杂/);
    const dangerous = transferEnvelope();
    dangerous.steps[0].opaque = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => parseWorkflowTransfer(marked(dangerous))).toThrow(
      /不支持的字段/,
    );
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    const harmless = transferEnvelope();
    harmless.steps[0].opaque = "<script>globalThis.polluted=true</script>";
    harmless.referencedDetails[0].detail.opaque = harmless.steps[0].opaque;
    expect(parseWorkflowTransfer(marked(harmless))!.steps[0].opaque).toBe(
      harmless.steps[0].opaque,
    );
    expect(Object.hasOwn(globalThis, "polluted")).toBe(false);
  });

  it("localizes shared external and automatic sources once, resolving ID/name collisions and preserving visible text", () => {
    const source = workflow(
      [
        {
          kind: "DETAIL",
          id: "external",
          title: "洗菜",
          items: [{ id: "shared-item", text: " 清水洗净。\n沥干。 " }],
          materials: "清水",
          videoUrl: "https://example.test/v.mp4",
          extra: { flags: [1, 2] },
        },
        {
          kind: "DETAIL",
          id: "water",
          title: "烧水",
          items: [],
          legacyEmpty: true,
        },
      ],
      { id: "source-workflow" },
    );
    const original = workflow([
      {
        kind: "MODULE",
        id: "a",
        title: "洗原料",
        detailWorkflowId: source.id,
        detailId: "external",
        frame: { x: 20, y: 20, width: 210, height: 60 },
        nextModuleIds: ["b"],
      },
      {
        kind: "MODULE",
        id: "b",
        title: "清洗第二遍",
        detailWorkflowId: source.id,
        detailId: "external",
        custom: "保留",
        nextModuleIds: ["c"],
      },
      { kind: "MODULE", id: "c", title: "烧水" },
      {
        kind: "DETAIL",
        id: "restored-external",
        title: "洗菜",
        items: [{ text: "本地未引用做法。" }],
      },
    ]);
    const before = completeWorkflowText(
      original,
      generateWorkflow(original, [source]),
    );
    const parsed = parseWorkflowTransfer(
      serializeWorkflowTransfer(original, [source], before, ["a", "b", "c"]),
    )!;
    const frozen = freeze(parsed);
    const first = prepareWorkflowTransferImport(frozen);
    const second = prepareWorkflowTransferImport(frozen);
    expect(first).toEqual(second);
    expect(parsed.steps).toEqual(JSON.parse(original.draft));
    const imported = workflow(first.steps, {
      id: "new-workflow",
      boardSettings: first.boardSettings,
    });
    const content = readWorkflow(imported.draft);
    expect(content.details).toHaveLength(3);
    expect(content.modules.map((module) => module.id)).toEqual(["a", "b", "c"]);
    expect(content.modules[0].detailId).toBe("restored-external-2");
    expect(content.modules[1].detailId).toBe(content.modules[0].detailId);
    expect(content.details[1].title).toBe("洗菜（还原 2）");
    expect(content.details[1].extra).toEqual({ flags: [1, 2] });
    for (const module of content.modules) {
      expect(module.detailWorkflowId).toBeUndefined();
      expect(resolveModuleLink(imported, module, []).status).toBe("MATCHED");
    }
    expect(completeWorkflowText(imported, generateWorkflow(imported, []))).toBe(
      before,
    );
    expect(first.order).toEqual(["a", "b", "c"]);
    const afterCycle = prepareWorkflowTransferImport(
      parseWorkflowTransfer(
        serializeWorkflowTransfer(imported, [], first.prose, first.order),
      )!,
    );
    expect(afterCycle).toEqual(first);
  });

  it("removes old self-source pins and refuses missing explicit references or overflowing document copies", () => {
    const original = complexWorkflow();
    const parsed = parseWorkflowTransfer(
      serializeWorkflowTransfer(original, [original], "流程。"),
    )!;
    const ready = prepareWorkflowTransferImport(parsed);
    expect(ready.steps[1].detailWorkflowId).toBeUndefined();
    expect(ready.steps[1].detailId).toBe("da");
    expect(ready.steps[1].frame).toEqual(parsed.steps[1].frame);

    for (const fields of [
      { detailWorkflowId: "gone-source", detailId: "gone-doc" },
      { detailId: "gone-doc" },
    ]) {
      const missing = workflow([
        { kind: "MODULE", id: "missing", title: "缺少来源", ...fields },
      ]);
      const value = parseWorkflowTransfer(
        serializeWorkflowTransfer(missing, [], "缺少来源。"),
      )!;
      expect(() => prepareWorkflowTransferImport(value)).toThrow(
        /没有完整副本/,
      );
    }
    const unbound = workflow([
      { kind: "MODULE", id: "unbound", title: "还没写做法" },
    ]);
    const value = parseWorkflowTransfer(
      serializeWorkflowTransfer(unbound, [], "还没写做法。"),
    )!;
    expect(prepareWorkflowTransferImport(value).steps).toEqual(
      JSON.parse(unbound.draft),
    );

    const source = workflow(
      [{ kind: "DETAIL", id: "source-doc", title: "外部", items: [] }],
      { id: "source" },
    );
    const full = workflow([
      {
        kind: "MODULE",
        id: "one",
        title: "工作",
        detailId: "source-doc",
        detailWorkflowId: "source",
      },
      ...Array.from({ length: 100 }, (_, index) => ({
        kind: "DETAIL",
        id: `doc-${index}`,
        title: `做法${index}`,
        items: [],
      })),
    ]);
    const tooMany = parseWorkflowTransfer(
      serializeWorkflowTransfer(full, [source], "原文。"),
    )!;
    expect(() => prepareWorkflowTransferImport(tooMany)).toThrow(/超过 100/);
  });

  it("rejects inconsistent source snapshots rather than silently changing a selected document", () => {
    const payload = transferEnvelope();
    payload.referencedDetails[0].detail.items[0].text = "偷偷换了做法。";
    expect(() => parseWorkflowTransfer(marked(payload))).toThrow(/副本不一致/);
    const wrong = transferEnvelope();
    wrong.referencedDetails[0].sourceWorkflowId = "another-source";
    expect(() => parseWorkflowTransfer(marked(wrong))).toThrow(/对应不上/);

    const sharedSource = workflow(
      [
        {
          kind: "DETAIL",
          id: "shared",
          title: "共享做法",
          items: [{ text: "原做法。" }],
        },
      ],
      { id: "shared-source" },
    );
    const owner = workflow([
      {
        kind: "MODULE",
        id: "first",
        title: "工作一",
        detailId: "shared",
        detailWorkflowId: sharedSource.id,
      },
      {
        kind: "MODULE",
        id: "second",
        title: "工作二",
        detailId: "shared",
        detailWorkflowId: sharedSource.id,
      },
    ]);
    const sharedText = serializeWorkflowTransfer(
      owner,
      [sharedSource],
      "流程。",
    );
    const start =
      sharedText.indexOf(`\n${WORKFLOW_TRANSFER_START}\n`) +
      WORKFLOW_TRANSFER_START.length +
      2;
    const payloadWithConflict = JSON.parse(
      sharedText.slice(
        start,
        sharedText.lastIndexOf(`\n${WORKFLOW_TRANSFER_END}`),
      ),
    );
    payloadWithConflict.referencedDetails[1].detail.items[0].text =
      "第二份不同的做法。";
    expect(() => parseWorkflowTransfer(marked(payloadWithConflict))).toThrow(
      /不同内容/,
    );
  });
});
