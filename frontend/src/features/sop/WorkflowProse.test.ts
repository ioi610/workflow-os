import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Workflow, WorkflowStep } from "../../types";
import { CompleteWorkflow } from "./CompleteWorkflow";
import { WorkflowProse } from "./WorkflowProse";
import {
  completeWorkflowParagraphs,
  completeWorkflowText,
} from "./completeWorkflowText";
import { connectProcedure } from "./connectedProcedure";
import { completeWorkflowSources } from "./completeWorkflowSources";
import { generateWorkflow, type GeneratedWorkflow } from "./generatedWorkflow";
import {
  DEFAULT_BOARD_AXES,
  serializeBoardAxes,
  timelinePosition,
  type BoardAxesSettings,
} from "./boardAxes";
import { editorBackupKey } from "./useWorkflowAutosave";
import { readWorkflow, workflowKey } from "./workflows";

const context: Context = {
  org: "prose-test-handbook",
  user: { id: "prose-test-person" },
  role: "OWNER",
  personalMode: true,
  notify: vi.fn(),
};

function record(
  steps: WorkflowStep[],
  patch: Partial<Workflow> = {},
): Workflow {
  return {
    id: "prose-flow",
    title: "自己的工作流程名称",
    category: "自己的分类名称",
    revision: 8,
    draft: JSON.stringify(steps),
    ...patch,
  };
}

const instructions = (
  id: string,
  title: string,
  texts: string[],
): WorkflowStep => ({
  kind: "DETAIL",
  id: `detail-${id}`,
  title,
  items: texts.map((text, index) => ({ id: `${id}-${index}`, text })),
});

function decodeText(value: string) {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#x27;": "'",
    "&#39;": "'",
  };
  return value.replace(
    /&(?:amp|lt|gt|quot|#x27|#39);/g,
    (entity) => entities[entity],
  );
}

function proseArticle(markup: string) {
  const match = markup.match(
    /<article\b[^>]*class="complete-prose"[^>]*>[\s\S]*?<\/article>/,
  );
  expect(
    match,
    "the page should render the shared prose article",
  ).not.toBeNull();
  return match![0];
}

function renderedParagraphs(markup: string) {
  return [
    ...proseArticle(markup).matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g),
  ].map((match) => decodeText(match[1]));
}

function assertOnlyParagraphMarkup(markup: string) {
  const article = proseArticle(markup);
  expect(article).toContain('aria-label="完整流程正文"');
  const tags = [...article.matchAll(/<\/?([a-z][a-z0-9-]*)\b/g)].map(
    (match) => match[1],
  );
  expect(tags.every((tag) => tag === "article" || tag === "p")).toBe(true);
  expect(article).not.toMatch(
    /<(?:ol|ul|li|a|img|video|figure|time|button|h[1-6])\b/,
  );
  return article;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function renderPage(
  records: Workflow[],
  storage = new Map<string, string>(),
  role = context.role,
) {
  const request = vi.fn(() => {
    throw new Error("A read-only server render must not request or save data");
  });
  const setItem = vi.fn();
  const removeItem = vi.fn();
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("localStorage", {
    get length() {
      return storage.size;
    },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem,
    removeItem,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(workflowKey(context.org), records);
  try {
    const markup = renderToStaticMarkup(
      createElement(QueryClientProvider, {
        client,
        children: createElement(MemoryRouter, {
          initialEntries: [`/workflows/${records[0].id}/complete`],
          children: createElement(Routes, {
            children: createElement(Route, {
              path: "/workflows/:id/complete",
              element: createElement(CompleteWorkflow, { ...context, role }),
            }),
          }),
        }),
      }),
    );
    expect(request).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    return markup;
  } finally {
    client.clear();
  }
}

function storedOrder(generated: GeneratedWorkflow, order: string[]) {
  return JSON.stringify({
    signature: JSON.stringify({
      entries: generated.entries.map((entry) => [entry.id, entry.minute]),
      groups: generated.groups.map((group) => [group.id, group.entryIds]),
      edges: generated.edges,
    }),
    order,
  });
}

function timedRecord() {
  const settings: BoardAxesSettings = {
    ...DEFAULT_BOARD_AXES,
    timeline: {
      ...DEFAULT_BOARD_AXES.timeline,
      enabled: true,
      axis: "y",
      startMinute: 600,
      endMinute: 720,
    },
    priority: { ...DEFAULT_BOARD_AXES.priority, enabled: false },
    canvas: { width: 1000, height: 1000 },
  };
  const at = (id: string, title: string, minute: number): WorkflowStep => ({
    kind: "MODULE",
    id,
    title,
    frame: {
      x: 0,
      y: timelinePosition(minute - 600, settings) * 900,
      width: 100,
      height: 100,
    },
  });
  return record(
    [
      at("late", "整理工具", 720),
      at("first", "准备材料", 660),
      at("second", "检查电源", 660),
      instructions("first", "准备材料", ["量取 200 克原料。"]),
      instructions("second", "检查电源", ["电压未到 220 V 时不要接通。"]),
      instructions("late", "整理工具", ["擦干后放回盒内。"]),
    ],
    { boardSettings: serializeBoardAxes(settings) },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("the complete workflow prose document", () => {
  it("renders neighboring work as shared narrative paragraphs with exactly the copyable text", () => {
    const workflow = freeze(
      record([
        {
          kind: "MODULE",
          id: "rice",
          title: "蒸米饭",
          nextModuleIds: ["pack"],
        },
        { kind: "MODULE", id: "pack", title: "装盒" },
        {
          ...instructions("rice", "蒸米饭", ["淘米两次", "水到刻度后盖紧锅盖"]),
          description: "使用带刻度内胆",
          materials: "米 200 克，水 250 毫升",
          safetyNotice: "不要徒手触碰内胆",
          imageUrl: "https://example.com/reference.png",
          videoUrl: "https://example.com/operation.mp4",
        },
        instructions("pack", "装盒", ["未冷却时不要封盖", "检查盒底没有水珠"]),
      ]),
    );
    const generated = generateWorkflow(workflow, [workflow]);
    generated.warnings.push("SYSTEM_WARNING_MUST_NOT_APPEAR");
    generated.groups[0].label = "SYSTEM_GROUP_MUST_NOT_APPEAR";
    for (const entry of generated.entries) {
      entry.time = "17:42";
      entry.priority = "SYSTEM_PRIORITY_MUST_NOT_APPEAR";
    }
    const procedure = connectProcedure(generated);
    const before = JSON.stringify({ workflow, generated, procedure });
    freeze(generated);
    freeze(procedure);
    const paragraphs = completeWorkflowParagraphs(
      workflow,
      generated,
      procedure,
    );
    const markup = renderToStaticMarkup(
      createElement(WorkflowProse, { paragraphs }),
    );
    const article = assertOnlyParagraphMarkup(markup);
    expect(renderedParagraphs(markup)).toEqual(paragraphs);
    expect(renderedParagraphs(markup).join("\n\n")).toBe(
      completeWorkflowText(workflow, generated, procedure),
    );
    expect(paragraphs).toHaveLength(1);
    for (const original of [
      "蒸米饭",
      "装盒",
      "使用带刻度内胆",
      "淘米两次",
      "水到刻度后盖紧锅盖",
      "未冷却时不要封盖",
      "检查盒底没有水珠",
    ])
      expect(paragraphs[0]).toContain(original);
    for (const extra of [
      workflow.title,
      workflow.category,
      "SYSTEM_",
      "https://",
      "需要准备",
      "注意事项",
      "米 200 克，水 250 毫升",
      "不要徒手触碰内胆",
      "具体做法",
      "下一步",
      "开始",
      "已到流程末尾",
      "连线衔接",
      "之后的工作",
      "步骤还没有填写",
    ])
      expect(article).not.toContain(extra);
    expect(paragraphs[0]).toContain("17:42 蒸米饭：");
    expect(paragraphs[0]).toContain("17:42 装盒：");
    expect(paragraphs[0].match(/17:42/g)).toHaveLength(2);
    expect(paragraphs[0].indexOf("蒸米饭")).toBeLessThan(
      paragraphs[0].indexOf("装盒"),
    );
    expect(JSON.stringify({ workflow, generated, procedure })).toBe(before);
  });

  it("renders user markup as literal text instead of creating elements or attributes", () => {
    const paragraphs = [
      `检查：<img src=x onerror="doNotRun()"> & <script>alert('original')</script>。`,
      `保留原文：&lt;已经写下的文字&gt;，"引号"和 3 < 5。`,
    ];
    const markup = renderToStaticMarkup(
      createElement(WorkflowProse, { paragraphs }),
    );
    assertOnlyParagraphMarkup(markup);
    expect(markup).toContain("&lt;img");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toMatch(/<(?:img|script|iframe|svg)\b/);
    expect(renderedParagraphs(markup)).toEqual(paragraphs);
  });

  it("leaves an empty document empty and unfilled work contains only the original names", () => {
    const empty = renderToStaticMarkup(
      createElement(WorkflowProse, { paragraphs: [] }),
    );
    assertOnlyParagraphMarkup(empty);
    expect(renderedParagraphs(empty)).toEqual([]);
    expect(empty).not.toMatch(/还没有|未填写|待补|开始|结束/);
    const workflow = record([
      { kind: "MODULE", id: "unwritten", title: "尚未写做法的名称" },
      { kind: "MODULE", id: "blank", title: "空白步骤名称" },
      instructions("blank", "空白步骤名称", ["", "  \n  "]),
    ]);
    const generated = generateWorkflow(workflow, [workflow]);
    const paragraphs = completeWorkflowParagraphs(workflow, generated);
    expect(paragraphs).toEqual(["尚未写做法的名称。空白步骤名称。"]);
    const markup = renderToStaticMarkup(
      createElement(WorkflowProse, { paragraphs }),
    );
    assertOnlyParagraphMarkup(markup);
    expect(renderedParagraphs(markup)).toEqual(paragraphs);
  });

  it("uses the saved same-time preference in the real page, copy text and printable article without writes", () => {
    const workflow = freeze(timedRecord());
    const generated = generateWorkflow(workflow, [workflow]);
    expect(generated.entries.map((entry) => entry.id)).toEqual([
      "first",
      "second",
      "late",
    ]);
    const order = ["second", "first", "late"];
    const key = `workflow-os:procedure-order:${context.user.id}:${context.org}:${workflow.id}`;
    const storage = new Map([[key, storedOrder(generated, order)]]);
    const savedStorage = [...storage];
    const before = JSON.stringify(workflow);
    const markup = renderPage([workflow], storage);
    const article = assertOnlyParagraphMarkup(markup);
    const copyText = completeWorkflowText(
      workflow,
      generated,
      connectProcedure(generated, order),
    );
    expect(renderedParagraphs(markup).join("\n\n")).toBe(copyText);
    expect(article.indexOf("检查电源")).toBeLessThan(
      article.indexOf("准备材料"),
    );
    expect(article.indexOf("准备材料")).toBeLessThan(
      article.indexOf("整理工具"),
    );
    expect(copyText).toBe(
      "11:00 检查电源：电压未到 220 V 时不要接通。11:00 准备材料：量取 200 克原料。12:00 整理工具：擦干后放回盒内。",
    );
    expect(article.match(/11:00/g)).toHaveLength(2);
    expect(article.match(/12:00/g)).toHaveLength(1);
    expect(article).not.toMatch(
      /时间：|优先|同一时间|工作之间|已写步骤|处待补|项工作/,
    );
    expect(markup.match(/<article\b/g)).toHaveLength(1);
    expect(markup).toContain(
      `class="complete-paper"><h1>${workflow.title}</h1>${article}`,
    );
    expect([...storage]).toEqual(savedStorage);
    expect(JSON.stringify(workflow)).toBe(before);
  });

  it("keeps the generator's next-day labels in each work sentence and the same copyable printable prose", () => {
    const settings: BoardAxesSettings = {
      ...DEFAULT_BOARD_AXES,
      timeline: { enabled: true, startMinute: 1380, endMinute: 60, axis: "x" },
      canvas: { width: 820, height: 820 },
    };
    const at = (id: string, title: string, offset: number): WorkflowStep => ({
      kind: "MODULE",
      id,
      title,
      frame: { x: (offset / 120) * (820 - 32), y: 0, width: 32, height: 32 },
    });
    const workflow = freeze(
      record(
        [
          at("next", "确认断电", 90),
          at("before", "清洁设备", 30),
          instructions("next", "确认断电", ["拔下插头。"]),
          instructions("before", "清洁设备", ["擦净外壳。"]),
        ],
        { boardSettings: serializeBoardAxes(settings) },
      ),
    );
    const generated = generateWorkflow(workflow, [workflow]);
    expect(generated.entries.map((entry) => entry.time)).toEqual([
      "23:30",
      "次日 00:30",
    ]);
    const markup = renderPage([workflow]);
    const article = assertOnlyParagraphMarkup(markup);
    const copyText = completeWorkflowText(workflow, generated);
    expect(renderedParagraphs(markup).join("\n\n")).toBe(copyText);
    expect(copyText).toBe(
      "23:30 清洁设备：擦净外壳。次日 00:30 确认断电：拔下插头。",
    );
    expect(article.match(/23:30/g)).toHaveLength(1);
    expect(article.match(/次日 00:30/g)).toHaveLength(1);
    expect(article).not.toMatch(
      /时间：|之后的工作|连线衔接|工作之间|已写步骤|处待补|项工作/,
    );
  });

  it("does not invent times or time placeholders when the template has no active timeline", () => {
    const workflow = freeze(
      record(
        [
          {
            kind: "MODULE",
            id: "wait",
            title: "浸泡材料",
            frame: { x: 160, y: 290, width: 80, height: 80 },
          },
          { kind: "MODULE", id: "drain", title: "沥干材料" },
          instructions("wait", "浸泡材料", ["等待 5 分钟。"]),
          instructions("drain", "沥干材料", ["倒入滤网。"]),
        ],
        { boardSettings: serializeBoardAxes(DEFAULT_BOARD_AXES) },
      ),
    );
    const generated = generateWorkflow(workflow, [workflow]);
    expect(generated.entries.every((entry) => entry.time === undefined)).toBe(
      true,
    );
    const markup = renderPage([workflow]);
    const article = assertOnlyParagraphMarkup(markup);
    expect(renderedParagraphs(markup).join("\n\n")).toBe(
      completeWorkflowText(workflow, generated),
    );
    expect(renderedParagraphs(markup)).toEqual([
      "浸泡材料：等待 5 分钟。沥干材料：倒入滤网。",
    ]);
    expect(article).not.toMatch(
      /\d{2}:\d{2}|未设置时间|未安排时间|时间待补|时间：|已写步骤|处待补|项工作/,
    );
  });

  it("discards an obsolete order preference without discarding written content or changing stored preferences", () => {
    const workflow = freeze(timedRecord());
    const generated = generateWorkflow(workflow, [workflow]);
    const key = `workflow-os:procedure-order:${context.user.id}:${context.org}:${workflow.id}`;
    const invalid = storedOrder(generated, ["late", "second", "first"]);
    const storage = new Map([[key, invalid]]);
    const markup = renderPage([workflow], storage);
    assertOnlyParagraphMarkup(markup);
    expect(renderedParagraphs(markup).join("\n\n")).toBe(
      completeWorkflowText(workflow, generated),
    );
    expect(storage.get(key)).toBe(invalid);
  });

  it("retains a legal manual arrow order from the previous dependency grouping but rejects an illegal one", () => {
    const workflow = freeze(
      record([
        { kind: "MODULE", id: "a", title: "先准备", nextModuleIds: ["b"] },
        { kind: "MODULE", id: "alone", title: "独立工作" },
        { kind: "MODULE", id: "b", title: "再检查" },
        instructions("a", "先准备", ["取出工具。"]),
        instructions("alone", "独立工作", ["整理记录。"]),
        instructions("b", "再检查", ["检查电源。"]),
      ]),
    );
    const generated = generateWorkflow(workflow, [workflow]);
    expect(generated.entries.map((entry) => entry.id)).toEqual([
      "a",
      "alone",
      "b",
    ]);
    const key = `workflow-os:procedure-order:${context.user.id}:${context.org}:${workflow.id}`;
    const legacySignature = JSON.stringify({
      entries: generated.entries.map((entry) => [entry.id, entry.minute]),
      groups: [
        ["group-1", ["a", "alone"]],
        ["group-2", ["b"]],
      ],
      edges: generated.edges,
    });
    const order = ["a", "b", "alone"];
    const raw = JSON.stringify({ signature: legacySignature, order });
    const storage = new Map([[key, raw]]);
    const markup = renderPage([workflow], storage);
    assertOnlyParagraphMarkup(markup);
    expect(renderedParagraphs(markup).join("\n\n")).toBe(
      completeWorkflowText(
        workflow,
        generated,
        connectProcedure(generated, order),
      ),
    );
    expect(renderedParagraphs(markup)).toEqual([
      "先准备：取出工具。再检查：检查电源。独立工作：整理记录。",
    ]);
    expect(storage.get(key)).toBe(raw);

    const invalid = JSON.stringify({
      signature: legacySignature,
      order: ["b", "a", "alone"],
    });
    storage.set(key, invalid);
    const fallback = renderPage([workflow], storage);
    expect(renderedParagraphs(fallback).join("\n\n")).toBe(
      completeWorkflowText(workflow, generated),
    );
    expect(storage.get(key)).toBe(invalid);
  });

  it("defaults to saved text when local text conflicts, with the choice notice outside the printable prose", () => {
    const workflow = freeze(
      record([
        { kind: "MODULE", id: "rice", title: "蒸米饭" },
        instructions("rice", "蒸米饭", ["服务器最新做法：洗米后加水。"]),
      ]),
    );
    const local = {
      revision: workflow.revision - 1,
      draft: {
        title: workflow.title,
        category: workflow.category,
        modules: readWorkflow(workflow.draft).modules,
        details: [
          instructions("rice", "蒸米饭", ["旧本机做法：直接开火。"]),
        ] as ReturnType<typeof readWorkflow>["details"],
      },
    };
    const key = editorBackupKey(
      String(context.user.id),
      context.org,
      workflow.id,
    );
    const raw = JSON.stringify(local);
    const storage = new Map([[key, raw]]);
    const markup = renderPage([workflow], storage);
    const article = assertOnlyParagraphMarkup(markup);
    expect(renderedParagraphs(markup).join("\n\n")).toBe(
      completeWorkflowText(workflow, generateWorkflow(workflow, [workflow])),
    );
    expect(article).toContain("服务器最新做法");
    expect(article).not.toContain("旧本机做法");
    expect(article).not.toMatch(/草稿|本机|已保存的做法不同|查看本机/);
    expect(markup).toMatch(
      /class="complete-source-choice complete-screen-only" role="status"/,
    );
    expect(markup).toContain(
      "本机草稿与已保存的做法不同，当前使用已保存的做法。",
    );
    expect(markup).toContain("查看本机草稿");
    expect(markup).not.toContain("保存本机做法");
    expect(storage.get(key)).toBe(raw);
  });

  it("reads the newest tab snapshot alongside legacy backups without consuming either, and hides all drafts from employees", () => {
    const workflow = freeze(
      record([{ kind: "MODULE", id: "rice", title: "蒸米饭" }]),
    );
    const local = (text: string, updatedAt: number) => ({
      revision: workflow.revision,
      updatedAt,
      draft: {
        title: workflow.title,
        category: workflow.category,
        modules: [],
        details: [instructions("rice", "蒸米饭", [text])],
        boardSettings: null,
      },
    });
    const key = editorBackupKey(
      String(context.user.id),
      context.org,
      workflow.id,
    );
    const storage = new Map([
      [key, JSON.stringify(local("旧版本本机备份。", 1))],
      [`${key}:tab:first`, JSON.stringify(local("较早标签页的文字。", 2))],
      [`${key}:tab:latest`, JSON.stringify(local("较新标签页的手写文字。", 3))],
      [
        `${key}:recovery:archive`,
        JSON.stringify(local("历史归档不能当成当前草稿。", 999)),
      ],
    ]);
    const before = [...storage];
    const markup = renderPage([workflow], storage);
    const article = assertOnlyParagraphMarkup(markup);
    expect(renderedParagraphs(markup)).toEqual([
      "蒸米饭：较新标签页的手写文字。",
    ]);
    expect(article).not.toMatch(/旧版本|较早标签|历史归档/);
    expect([...storage]).toEqual(before);

    const employee = renderPage([workflow], storage, "EMPLOYEE");
    assertOnlyParagraphMarkup(employee);
    expect(renderedParagraphs(employee)).toEqual(["蒸米饭。"]);
    expect(employee).not.toMatch(/较新标签页|查看本机草稿|保存本机做法/);
    expect([...storage]).toEqual(before);
  });

  it("includes recovered handwritten drafts while preserving the saved framework and the untouched local backup", () => {
    const workflow = freeze(
      record(
        [
          {
            kind: "MODULE",
            id: "rice",
            title: "蒸米饭",
            frame: { x: 140, y: 280, width: 90, height: 75 },
          },
        ],
        { boardSettings: serializeBoardAxes(DEFAULT_BOARD_AXES) },
      ),
    );
    const local = freeze({
      revision: 6,
      draft: {
        title: "不应替换流程的旧标题",
        category: "旧分类",
        modules: [],
        boardSettings: null,
        details: [
          instructions("local-rice", "蒸米饭", ["淘米两次，加水至刻度。", ""]),
        ] as ReturnType<typeof readWorkflow>["details"],
      },
    });
    const key = editorBackupKey(
      String(context.user.id),
      context.org,
      workflow.id,
    );
    const rawBackup = JSON.stringify(local);
    const storage = new Map([[key, rawBackup]]);
    const before = JSON.stringify({ workflow, local });
    const preview = completeWorkflowSources([workflow], () => local);
    const generated = generateWorkflow(preview.workflows[0], preview.workflows);
    const markup = renderPage([workflow], storage);
    const article = assertOnlyParagraphMarkup(markup);
    expect(renderedParagraphs(markup).join("\n\n")).toBe(
      completeWorkflowText(preview.workflows[0], generated),
    );
    expect(article).toContain("淘米两次，加水至刻度。");
    expect(article).not.toMatch(
      /本机|草稿|尚未同步|未填写|还没写|不应替换|旧分类/,
    );
    expect(storage.get(key)).toBe(rawBackup);
    expect(JSON.stringify({ workflow, local })).toBe(before);
    expect(readWorkflow(preview.workflows[0].draft).modules).toEqual(
      readWorkflow(workflow.draft).modules,
    );
    expect(preview.workflows[0].boardSettings).toBe(workflow.boardSettings);
  });
});
