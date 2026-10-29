import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Context,
  Workflow,
  WorkflowDetailDocument,
  WorkflowModule,
} from "../../types";
import { ModuleInstructions } from "./ModuleInstructions";
import { bindContentDetails } from "./detailBindings";
import {
  readWorkflow,
  resolveModuleLink,
  serializeWorkflow,
  workflowKey,
} from "./workflows";

const context: Context = {
  org: "org",
  role: "OWNER",
  user: { id: "user" },
  notify: vi.fn(),
};
const manual = (
  id: string,
  title: string,
  text: string,
): WorkflowDetailDocument => ({
  kind: "DETAIL",
  id,
  title,
  items: [{ id: `${id}-item`, text }],
  materials: "原材料",
  safetyNotice: "原注意事项",
  custom: { preserved: true },
});
const workflow = (id: string, steps: unknown[]): Workflow => ({
  id,
  title: `流程 ${id}`,
  category: "",
  revision: 4,
  draft: JSON.stringify(steps),
});

afterEach(() => vi.unstubAllGlobals());

function renderReader(records: Workflow[], route: string) {
  const request = vi.fn(() => {
    throw new Error("SSR must not write or request business data");
  });
  vi.stubGlobal("fetch", request);
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(workflowKey(context.org), records);
  try {
    const markup = renderToStaticMarkup(
      createElement(QueryClientProvider, {
        client,
        children: createElement(MemoryRouter, {
          initialEntries: [route],
          children: createElement(Routes, {
            children: createElement(Route, {
              path: "/workflows/:id/steps",
              element: createElement(ModuleInstructions, context),
            }),
          }),
        }),
      }),
    );
    expect(request).not.toHaveBeenCalled();
    return markup;
  } finally {
    client.clear();
  }
}

describe("reader and editor stable-document integration", () => {
  it("opens the original ID through a stale name and retains that ID in the edit link", () => {
    const chosen = manual("chosen", "新的做法名", "保留这份原文"),
      replacement = manual("replacement", "旧做法名", "不能选择另一份正文");
    const markup = renderReader(
      [workflow("source", [chosen, replacement])],
      "/workflows/source/steps?name=%E6%97%A7%E5%81%9A%E6%B3%95%E5%90%8D&detailId=chosen",
    );
    expect(markup).toContain("保留这份原文");
    expect(markup).toContain("新的做法名");
    for (const removed of [
      "需要准备",
      "注意事项",
      chosen.materials,
      chosen.safetyNotice,
    ])
      expect(markup).not.toContain(removed);
    expect(markup).not.toContain("不能选择另一份正文");
    expect(markup).toContain("detailId=chosen");
    expect(markup).toContain("/workflows/source/edit?");
  });

  it("renders a missing stable ID instead of redirecting into a new or same-name document", () => {
    const source = workflow("source", [
      manual("replacement", "清洁", "不能打开的替代正文"),
    ]);
    const markup = renderReader(
      [source],
      "/workflows/source/steps?name=%E6%B8%85%E6%B4%81&detailId=deleted",
    );
    // Navigate renders no reader markup in SSR; a real missing-reference reader
    // must remain here and must not offer an authoring link for another ID.
    expect(markup).toContain('class="module-instructions"');
    expect(markup).toContain("原来对应的做法找不到了，请返回流程重新选择。");
    expect(markup).not.toContain("不能打开的替代正文");
    expect(markup).not.toContain("/edit?");
  });

  it("keeps a module's missing explicit document unresolved even when a local same-name document exists", () => {
    const work: WorkflowModule = {
      kind: "MODULE",
      id: "work",
      title: "清洁",
      detailWorkflowId: "source",
      detailId: "deleted",
    };
    const records = [
      workflow("board", [work, manual("local", "清洁", "不能改用本地正文")]),
      workflow("source", []),
    ];
    const markup = renderReader(
      records,
      "/workflows/board/steps?name=%E6%B8%85%E6%B4%81&module=work",
    );
    expect(markup).toContain('class="module-instructions"');
    expect(markup).not.toContain("不能改用本地正文");
    expect(markup).not.toContain("/edit?");
  });

  it("preserves the selected document through the Editor's bind-before-patch and bind-after-patch title changes", () => {
    const work: WorkflowModule = {
      kind: "MODULE",
      id: "work",
      title: "清洁",
      frame: { x: 20, y: 30, width: 40, height: 50 },
      nextModuleIds: ["after"],
      custom: { keep: true },
    };
    const original = manual("original", "清洁", "原有手写内容");
    let draft = {
      ...readWorkflow(JSON.stringify([work, original])),
      title: "我的流程",
      category: "分类",
      boardSettings: "原设置",
    };
    for (const title of ["", "改后的做法名"]) {
      const bound = bindContentDetails(draft, "board", []);
      draft = bindContentDetails(
        {
          ...bound,
          details: bound.details.map((detail) => ({ ...detail, title })),
        },
        "board",
        [],
      );
      const record = workflow("board", serializeWorkflow(draft));
      expect(
        resolveModuleLink(record, draft.modules[0], [record]).detail?.id,
      ).toBe("original");
    }
    expect(draft.modules[0]).toEqual({
      ...work,
      detailWorkflowId: "board",
      detailId: "original",
    });
    expect(draft.details[0]).toEqual({ ...original, title: "改后的做法名" });
    expect(draft.boardSettings).toBe("原设置");
    const reused = workflow("board", [
      ...serializeWorkflow(draft),
      manual("other", "清洁", "不能改用新同名正文"),
    ]);
    expect(
      resolveModuleLink(reused, draft.modules[0], [reused]).detail?.items,
    ).toEqual(original.items);
  });

  it("binds a pristine pending document by its original name when its first real edit changes that name", () => {
    const work: WorkflowModule = {
      kind: "MODULE",
      id: "work",
      title: "原工作名",
    };
    const draft = {
      modules: [work],
      details: [] as WorkflowDetailDocument[],
      title: "流程",
      category: "",
    };
    const pending = manual("pending", "原工作名", ""),
      edited = { ...pending, title: "第一笔就改成的新名称" };
    const before = JSON.stringify({ draft, pending });
    const bound = bindContentDetails(
      { ...draft, details: [...draft.details, pending] },
      "board",
      [],
    );
    const result = bindContentDetails(
      {
        ...bound,
        details: bound.details.map((detail) =>
          detail.id === pending.id ? edited : detail,
        ),
      },
      "board",
      [],
    );
    expect(result.modules[0]).toEqual({
      ...work,
      detailWorkflowId: "board",
      detailId: "pending",
    });
    expect(result.details).toEqual([edited]);
    const record = workflow("board", serializeWorkflow(result));
    expect(
      resolveModuleLink(record, result.modules[0], [record]).detail?.id,
    ).toBe("pending");
    expect(JSON.stringify({ draft, pending })).toBe(before);
    expect(draft.details).toEqual([]);
  });
});
