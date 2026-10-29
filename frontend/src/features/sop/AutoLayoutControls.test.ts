import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workflow, WorkflowModule } from "../../types";
import { AutoLayoutControls, LayoutPreview } from "./AutoLayoutControls";

const first: WorkflowModule = {
  kind: "MODULE",
  id: "first",
  title: "开始准备",
  frame: { x: 100, y: 100, width: 100, height: 100 },
  nextModuleIds: ["second"],
  connectionPorts: { second: { source: "right", target: "top" } },
};
const second: WorkflowModule = {
  kind: "MODULE",
  id: "second",
  title: "检查设备",
  frame: { x: 700, y: 300, width: 200, height: 100 },
  nextModuleIds: ["first"],
  connectionPorts: { first: { source: "bottom", target: "left" } },
};
const third: WorkflowModule = {
  kind: "MODULE",
  id: "third",
  title: '<script>alert("x")</script> & <b>工作</b>',
  frame: { x: 400, y: 50, width: 100, height: 80 },
};
function workflow(modules = [first, second, third]): Workflow {
  return {
    id: "layout-preview",
    title: "位置预览",
    category: "",
    revision: 7,
    boardSettings: JSON.stringify({
      version: 1,
      timeline: { enabled: false, startMinute: 540, endMinute: 1080 },
      priority: { enabled: false },
      canvas: { width: 1000, height: 500 },
    }),
    draft: JSON.stringify([
      ...modules,
      {
        kind: "DETAIL",
        id: "manual",
        title: "开始准备",
        items: [{ id: "item", text: "不能在预览中改写的手写正文" }],
      },
    ]),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("read-only automatic layout controls", () => {
  it("shows every module including unconnected work and safely escapes names without changing source data", () => {
    const input = workflow(),
      before = JSON.stringify(input);
    const request = vi.fn(() => {
      throw new Error("Preview must not make a write request");
    });
    vi.stubGlobal("fetch", request);
    const markup = renderToStaticMarkup(
      createElement(LayoutPreview, { workflow: input }),
    );
    expect(markup).toContain('aria-label="工作位置预览"');
    expect(markup.match(/<text\b/g)).toHaveLength(3);
    expect(markup).toContain("开始准备");
    expect(markup).toContain("检查设备");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("&amp; &lt;b&gt;工作&lt;/b&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("不能在预览中改写的手写正文");
    expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(input)).toBe(before);
  });

  it("retains arrow direction and the selected source and target sides on a rectangular board", () => {
    const markup = renderToStaticMarkup(
      createElement(LayoutPreview, { workflow: workflow() }),
    );
    const arrows = [
      ...markup.matchAll(
        /<path\b[^>]*\bd="([^"]+)"[^>]*marker-end="([^"]+)"[^>]*>/g,
      ),
    ];
    expect(arrows).toHaveLength(2);
    // Path coordinates are normalized to 1000 in both axes, then scaled to the
    // physical 1000 x 500 board. The first leaves the right side and enters top.
    const points = arrows.map((arrow) =>
      (arrow[1].match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) || []).map(Number),
    );
    expect(points[0][0]).toBeCloseTo(200);
    expect(points[0][1]).toBeCloseTo(300);
    expect(points[0].at(-2)).toBeCloseTo(800);
    expect(points[0].at(-1)).toBeCloseTo(594);
    // The return edge leaves the second module's bottom and enters first's left.
    expect(points[1][0]).toBeCloseTo(800);
    expect(points[1][1]).toBeCloseTo(800);
    expect(points[1].at(-2)).toBeCloseTo(94);
    expect(points[1].at(-1)).toBeCloseTo(300);
    const markerId = markup.match(/<marker\b[^>]*id="([^"]+)"/)?.[1];
    expect(markerId).toBeTruthy();
    expect(arrows.every((arrow) => arrow[2] === `url(#${markerId})`)).toBe(
      true,
    );
  });

  it("renders only an explicit entry button initially without applying a layout or requesting data", () => {
    const onBegin = vi.fn(),
      onApply = vi.fn(),
      request = vi.fn(() => {
        throw new Error("Opening an entry must not request data");
      });
    vi.stubGlobal("fetch", request);
    const markup = renderToStaticMarkup(
      createElement(AutoLayoutControls, {
        workflow: workflow(),
        workflows: [],
        disabled: false,
        onBegin,
        onApply,
      }),
    );
    expect(markup).toContain('type="button"');
    expect(markup).toContain("整理位置");
    expect(markup).not.toContain("<dialog");
    expect(markup).not.toContain('class="auto-layout-preview"');
    expect(markup).not.toContain("应用整理");
    expect(onBegin).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("disables the entry while editing is unavailable or there are fewer than two modules", () => {
    const onApply = vi.fn();
    for (const props of [
      { workflow: workflow(), disabled: true },
      { workflow: workflow([first]), disabled: false },
    ]) {
      const markup = renderToStaticMarkup(
        createElement(AutoLayoutControls, {
          ...props,
          workflows: [],
          onApply,
        }),
      );
      expect(markup).toMatch(/<button\b[^>]*disabled=""/);
      expect(markup).not.toContain("<dialog");
    }
    expect(onApply).not.toHaveBeenCalled();
  });
});
