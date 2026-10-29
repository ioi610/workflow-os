import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Workflow } from "../../types";
import { CompleteWorkflow } from "./CompleteWorkflow";
import { completeWorkflowText } from "./completeWorkflowText";
import { generateWorkflow } from "./generatedWorkflow";
import { workflowKey } from "./workflows";

const context: Context = {
  org: "restore-ui-test",
  user: { id: "restore-person" },
  role: "OWNER",
  personalMode: true,
  notify: vi.fn(),
};
const workflow: Workflow = {
  id: "restore-flow",
  title: "我的操作流程",
  category: "自己的分类",
  revision: 4,
  draft: JSON.stringify([
    {
      kind: "MODULE",
      id: "wash",
      title: "洗菜",
      nextModuleIds: ["cook"],
      frame: { x: 11, y: 23, width: 120, height: 67 },
    },
    { kind: "MODULE", id: "cook", title: "炒菜" },
    {
      kind: "DETAIL",
      id: "wash-detail",
      title: "洗菜",
      items: [{ id: "wash-item", text: "清水冲洗两次。" }],
    },
    {
      kind: "DETAIL",
      id: "cook-detail",
      title: "炒菜",
      items: [{ id: "cook-item", text: "放入锅内炒熟。" }],
    },
  ]),
};

function renderComplete(record = workflow) {
  const request = vi.fn(() => {
    throw new Error("Rendering must not request or save data");
  });
  const writeText = vi.fn();
  const setItem = vi.fn();
  const removeItem = vi.fn();
  const print = vi.fn();
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  vi.stubGlobal("window", { print });
  vi.stubGlobal("localStorage", {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem,
    removeItem,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(workflowKey(context.org), [record]);
  try {
    const markup = renderToStaticMarkup(
      createElement(QueryClientProvider, {
        client,
        children: createElement(MemoryRouter, {
          initialEntries: [`/workflows/${record.id}/complete`],
          children: createElement(Routes, {
            children: createElement(Route, {
              path: "/workflows/:id/complete",
              element: createElement(CompleteWorkflow, context),
            }),
          }),
        }),
      }),
    );
    expect(request).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(print).not.toHaveBeenCalled();
    return markup;
  } finally {
    client.clear();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("complete workflow restore text controls", () => {
  it("offers a single complete copy control without exporting or writing during render", () => {
    const before = JSON.stringify(workflow);
    const markup = renderComplete();
    const tools = markup.match(
      /<div class="complete-screen-tools">[\s\S]*?<\/div><\/div>/,
    )?.[0];
    expect(tools).toContain("复制全文");
    expect(markup).not.toContain("复制还原文字");
    expect([
      ...markup.matchAll(/<button\b[^>]*>[\s\S]*?复制全文[\s\S]*?<\/button>/g),
    ]).toHaveLength(1);
    expect(tools).toContain("打印");
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("这份文字包含方框位置");
    expect(JSON.stringify(workflow)).toBe(before);
  });

  it("keeps restore metadata and controls outside the copyable printable prose", () => {
    const markup = renderComplete();
    const article = markup.match(
      /<article\b[^>]*class="complete-prose"[^>]*>[\s\S]*?<\/article>/,
    )?.[0];
    expect(article).toBeDefined();
    const text = completeWorkflowText(
      workflow,
      generateWorkflow(workflow, [workflow]),
    );
    expect(text).toBe("洗菜：清水冲洗两次。炒菜：放入锅内炒熟。");
    expect(article).toContain(`<p>${text}</p>`);
    expect(article).not.toMatch(
      /还原|方框位置|连线|复制|textarea|button|WORKFLOW/,
    );
    expect(markup.indexOf("复制全文")).toBeLessThan(
      markup.indexOf('class="complete-paper"'),
    );
    expect(markup).toContain(
      `class="complete-paper"><h1>${workflow.title}</h1>${article}`,
    );
  });

  it("allows an empty framework to be copied for restoration even without prose to copy or print", () => {
    const markup = renderComplete({ ...workflow, draft: "[]" });
    const buttons = [
      ...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g),
    ];
    const ordinary = buttons.find((match) => match[2].includes("复制全文"));
    const print = buttons.find((match) => match[2].includes("打印"));
    expect(ordinary).toBeDefined();
    expect(ordinary?.[1]).not.toContain('disabled=""');
    expect(print?.[1]).toContain('disabled=""');
    expect(markup).not.toContain("复制还原文字");
  });
});
