import { expect, test, type Page } from "@playwright/test";
import {
  createHandbookViaApi,
  expectNoGlobalNavigation,
  expectWorkflowHome,
} from "./handbook";

type Side = "top" | "right" | "bottom" | "left";
type PortChoice = { source: Side; target?: Side };
type StoredStep = {
  kind: string;
  id: string;
  title: string;
  position?: { x: number; y: number };
  frame?: { x: number; y: number; width: number; height: number };
  nextModuleIds?: string[];
  connectionPorts?: Record<string, PortChoice>;
  [key: string]: unknown;
};
type SavedWorkflow = {
  id: string;
  title: string;
  category: string;
  revision: number;
  draft: string;
  boardSettings?: string | null;
};
const sideNames = { top: "上边", right: "右边", bottom: "下边", left: "左边" };
const board = (page: Page) =>
  page.getByRole("region", { name: "流程图", exact: true });
const canvas = (page: Page) => board(page).locator(".flow-board-canvas");
const tile = (page: Page, id: string) =>
  canvas(page).locator(`.flow-tile[data-module-id="${id}"]`);
const port = (page: Page, name: string, side: Side) =>
  page.getByRole("button", {
    name:
      side === "right"
        ? `从 ${name} 画箭头`
        : `从 ${name} 的${sideNames[side]}画箭头`,
    exact: true,
  });
const arrows = (page: Page) =>
  canvas(page).locator("path[data-source][data-target]");
const entries = (saved: SavedWorkflow) =>
  JSON.parse(saved.draft) as StoredStep[];
const ports = (saved: SavedWorkflow) =>
  entries(saved)
    .filter((item) => item.kind === "MODULE")
    .map((item) => ({
      id: item.id,
      next: item.nextModuleIds,
      ports: item.connectionPorts,
    }));
async function workflow(
  page: Page,
  org: string,
  id: string,
): Promise<SavedWorkflow> {
  const response = await page.request.get(`/api/orgs/${org}/sops`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).find((item: SavedWorkflow) => item.id === id);
}
async function records(page: Page, org: string) {
  const response = await page.request.get(`/api/orgs/${org}/work-items`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ id: string; moduleId: string }[]>;
}
function nextSave(page: Page, org: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${org}/sops/save`),
  );
}
async function drag(
  page: Page,
  source: string,
  side: Side,
  target: string,
  targetId: string,
  targetSide?: Side,
  inspect?: () => Promise<void>,
) {
  await port(page, source, side).scrollIntoViewIfNeeded();
  const start = await port(page, source, side).boundingBox();
  const destination = await (
    targetSide ? port(page, target, targetSide) : tile(page, targetId)
  ).boundingBox();
  await page.mouse.move(
    start!.x + start!.width / 2,
    start!.y + start!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    destination!.x + destination!.width / 2,
    destination!.y + destination!.height / 2,
    { steps: 16 },
  );
  if (inspect) await inspect();
  await page.mouse.up();
}
async function assertSourceEdge(
  page: Page,
  sourceId: string,
  targetId: string,
  source: Side,
  target?: Side,
) {
  const path = canvas(page).locator(
    `path[data-source="${sourceId}"][data-target="${targetId}"]`,
  );
  await expect(path).toHaveAttribute("data-source-side", source);
  if (target) await expect(path).toHaveAttribute("data-target-side", target);
  else await expect(path).not.toHaveAttribute("data-target-side");
  await expect
    .poll(() =>
      path.evaluate(
        (element, choice) => {
          const curve = element as SVGPathElement;
          const start = curve
            .getPointAtLength(0)
            .matrixTransform(curve.getScreenCTM()!);
          const rect = document
            .querySelector(`.flow-tile[data-module-id="${choice.sourceId}"]`)!
            .getBoundingClientRect();
          const x =
            choice.source === "left"
              ? rect.left
              : choice.source === "right"
                ? rect.right
                : rect.x + rect.width / 2;
          const y =
            choice.source === "top"
              ? rect.top
              : choice.source === "bottom"
                ? rect.bottom
                : rect.y + rect.height / 2;
          return Math.hypot(start.x - x, start.y - y);
        },
        { sourceId, source },
      ),
    )
    .toBeLessThanOrEqual(2);
}
async function screenshot(page: Page, name: string) {
  await expectNoGlobalNavigation(page);
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: `../docs/screenshots/${name}.png`,
    fullPage: true,
  });
}

test("all four work ports retain chosen connection sides across dragging, editing, touch and board changes", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  expect(baseURL).toBe("http://127.0.0.1:5174");
  const errors: string[] = [],
    saves: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/sops/save"))
      saves.push(request.url());
  });
  await page.setViewportSize({ width: 1440, height: 1300 });
  await page.goto("/");
  await expectWorkflowHome(page);
  const org = await createHandbookViaApi(page, `四边画箭头验证-${Date.now()}`);
  const names: Record<Side, string> = {
    top: "上起点",
    right: "右起点",
    bottom: "下起点",
    left: "左起点",
  };
  const positions: Record<Side, { x: number; y: number }> = {
    top: { x: 0, y: 0 },
    right: { x: 0.72, y: 0.05 },
    bottom: { x: 0.04, y: 0.72 },
    left: { x: 0.72, y: 0.72 },
  };
  const sides: Side[] = ["top", "right", "bottom", "left"],
    target = "汇总",
    targetId = "port-target";
  const csrf = await (await page.request.get("/api/csrf")).json();
  const response = await page.request.post(`/api/orgs/${org}/sops/save`, {
    headers: { [csrf.headerName]: csrf.token },
    data: {
      title: "从四边连接工作",
      category: "连线验证",
      boardSettings: JSON.stringify({
        version: 1,
        timeline: {
          enabled: true,
          startMinute: 480,
          endMinute: 1200,
          axis: "y",
        },
        priority: { enabled: true, axis: "x" },
        canvas: { width: 1000, height: 700 },
      }),
      steps: [
        ...sides.map((side) => ({
          kind: "MODULE",
          id: `port-${side}`,
          title: names[side],
          position: positions[side],
        })),
        {
          kind: "MODULE",
          id: targetId,
          title: target,
          position: { x: 0.4, y: 0.38 },
        },
        {
          kind: "DETAIL",
          id: "port-detail",
          title: names.top,
          items: [
            {
              id: "port-item",
              text: "保留原来手写的具体做法，再按连线安排下一项工作。",
            },
          ],
          materials: "原来的参考资料",
          videoUrl: "https://example.com/four-ports",
        },
      ],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const original = (await response.json()) as SavedWorkflow,
    path = `/workflows/${original.id}`;
  const originalRecords = await records(page, org),
    originalDetails = entries(original).filter(
      (item) => item.kind === "DETAIL",
    );
  await page.goto(path);
  await expect(canvas(page)).toBeVisible();

  await test.step("each physical side drags a live preview and retains its saved start, with explicit target ports", async () => {
    for (const side of sides) {
      await expect(port(page, names[side], side)).toHaveAttribute(
        "data-side",
        side,
      );
      await expect(port(page, names.top, side)).toBeInViewport();
      const saved = nextSave(page, org);
      await drag(
        page,
        names[side],
        side,
        target,
        targetId,
        side === "left" ? "top" : undefined,
        async () => {
          await expect(
            canvas(page).locator('path[data-connection-preview="true"]'),
          ).toHaveAttribute("d", /^M .+ [CL] .+/);
          await expect(port(page, names[side], side)).toHaveAttribute(
            "aria-pressed",
            "true",
          );
          await expect(tile(page, targetId)).toHaveClass(
            /is-connection-target/,
          );
        },
      );
      expect((await saved).ok()).toBe(true);
      const module = entries(await workflow(page, org, original.id)).find(
        (item) => item.id === `port-${side}`,
      )!;
      expect(module.nextModuleIds).toEqual([targetId]);
      expect(module.connectionPorts![targetId]).toEqual({
        source: side,
        ...(side === "left" ? { target: "top" } : {}),
      });
      await assertSourceEdge(
        page,
        module.id,
        targetId,
        side,
        side === "left" ? "top" : undefined,
      );
    }
    await page.reload();
    await expect(arrows(page)).toHaveCount(4);
    for (const side of sides)
      await assertSourceEdge(
        page,
        `port-${side}`,
        targetId,
        side,
        side === "left" ? "top" : undefined,
      );
    await screenshot(page, "four-ports-desktop");
  });

  await test.step("same-source side changes, cancellation and duplicate attempts never create extra saves", async () => {
    const before = await workflow(page, org, original.id),
      count = saves.length;
    await port(page, names.bottom, "bottom").click();
    await port(page, names.bottom, "top").click();
    await expect(port(page, names.bottom, "bottom")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(port(page, names.bottom, "top")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await port(page, names.bottom, "top").click();
    await expect(port(page, names.bottom, "top")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await port(page, names.right, "left").click();
    await page.keyboard.press("Escape");
    await expect(port(page, names.right, "left")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await port(page, names.right, "top").click();
    const bounds = await canvas(page).boundingBox();
    await page.mouse.click(
      bounds!.x + bounds!.width * 0.88,
      bounds!.y + bounds!.height * 0.43,
    );
    await expect(port(page, names.right, "top")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await port(page, names.top, "right").click();
    await page
      .getByRole("button", { name: `连接工作 ${target}`, exact: true })
      .click();
    await expect(
      board(page).getByText("这条箭头已经存在。", { exact: true }),
    ).toBeVisible();
    expect(saves).toHaveLength(count);
    expect(ports(await workflow(page, org, original.id))).toEqual(
      ports(before),
    );
    expect((await workflow(page, org, original.id)).revision).toBe(
      before.revision,
    );
  });

  await test.step("keyboard chooses fixed source and target edges and removing an arrow clears its ports", async () => {
    const removed = nextSave(page, org);
    await page
      .getByRole("button", {
        name: `删除箭头 ${names.bottom} 到 ${target}`,
        exact: true,
      })
      .click();
    expect((await removed).ok()).toBe(true);
    const afterRemove = entries(await workflow(page, org, original.id)).find(
      (item) => item.id === "port-bottom",
    )!;
    expect(afterRemove.nextModuleIds || []).not.toContain(targetId);
    expect(afterRemove.connectionPorts?.[targetId]).toBeUndefined();
    await port(page, names.bottom, "bottom").focus();
    await page.keyboard.press("Space");
    await expect(port(page, names.bottom, "bottom")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await port(page, target, "left").focus();
    const saved = nextSave(page, org);
    await page.keyboard.press("Enter");
    expect((await saved).ok()).toBe(true);
    expect(
      entries(await workflow(page, org, original.id)).find(
        (item) => item.id === "port-bottom",
      )!.connectionPorts![targetId],
    ).toEqual({ source: "bottom", target: "left" });
    await assertSourceEdge(page, "port-bottom", targetId, "bottom", "left");
  });

  await test.step("module movement and rectangular board changes keep port choices, records and written methods", async () => {
    const before = await workflow(page, org, original.id);
    const handle = page.getByRole("button", {
      name: `拖动工作 ${target}`,
      exact: true,
    });
    await handle.focus();
    await page.keyboard.press("Space", { delay: 80 });
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("ArrowRight", { delay: 80 });
    await page.keyboard.press("ArrowDown", { delay: 80 });
    const moved = nextSave(page, org);
    await page.keyboard.press("Space", { delay: 80 });
    expect((await moved).ok()).toBe(true);
    // Physical geometry remains a compatibility fixture; the UI now only zooms.
    const current = await workflow(page, org, original.id);
    const csrf = await (await page.request.get("/api/csrf")).json();
    const resized = await page.request.post(`/api/orgs/${org}/sops/save`, {
      headers: { [csrf.headerName]: csrf.token },
      data: {
        id: current.id,
        expectedRevision: current.revision,
        title: current.title,
        category: current.category,
        boardSettings: JSON.stringify({
          ...JSON.parse(current.boardSettings!),
          canvas: { width: 1000, height: 1100 },
          referenceCanvas: { width: 1000, height: 700 },
        }),
        steps: entries(current).map((item) => {
          if (item.kind !== "MODULE") return item;
          const { position, size, ...rest } = item;
          return {
            ...rest,
            frame: item.frame || {
              x: position!.x * 1000,
              y: position!.y * 700,
              width:
                ((size as { width: number } | undefined)?.width ?? 0.2) * 1000,
              height:
                ((size as { height: number } | undefined)?.height ?? 0.2) * 700,
            },
          };
        }),
      },
    });
    expect(resized.ok(), await resized.text()).toBe(true);
    await page.reload();
    await expect(arrows(page)).toHaveCount(4);
    const saved = await workflow(page, org, original.id);
    expect(ports(saved)).toEqual(ports(before));
    expect(entries(saved).filter((item) => item.kind === "DETAIL")).toEqual(
      originalDetails,
    );
    expect((await records(page, org)).map((item) => item.id).sort()).toEqual(
      originalRecords.map((item) => item.id).sort(),
    );
    expect(JSON.parse(saved.boardSettings!)).toMatchObject({
      canvas: { width: 1000, height: 1100 },
      timeline: { enabled: true, axis: "y" },
      priority: { enabled: true, axis: "x" },
    });
    await assertSourceEdge(page, "port-left", targetId, "left", "top");
    await assertSourceEdge(page, "port-bottom", targetId, "bottom", "left");
    await canvas(page)
      .getByRole("link", { name: names.top, exact: true })
      .click();
    await expect(
      page.getByText("保留原来手写的具体做法，再按连线安排下一项工作。", {
        exact: true,
      }),
    ).toBeVisible();
    await page.goto(path);
    await expect(arrows(page)).toHaveCount(4);
  });

  await test.step("phone touch fixes both selected ports, and touch cancellation leaves saved connections intact", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const removed = nextSave(page, org);
    await page
      .getByRole("button", {
        name: `删除箭头 ${names.top} 到 ${target}`,
        exact: true,
      })
      .click();
    expect((await removed).ok()).toBe(true);
    const cdp = await page.context().newCDPSession(page);
    const touch = async (cancel: boolean) => {
      await port(page, names.top, "top").evaluate((element) =>
        element.scrollIntoView({ block: "center" }),
      );
      const start = await port(page, names.top, "top").boundingBox(),
        destination = await port(page, target, "bottom").boundingBox();
      const from = {
          x: start!.x + start!.width / 2,
          y: start!.y + start!.height / 2,
        },
        to = {
          x: destination!.x + destination!.width / 2,
          y: destination!.y + destination!.height / 2,
        };
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ ...from, id: 1 }],
      });
      for (let i = 1; i <= 12; i++)
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            {
              x: from.x + ((to.x - from.x) * i) / 12,
              y: from.y + ((to.y - from.y) * i) / 12,
              id: 1,
            },
          ],
        });
      await expect(
        canvas(page).locator('path[data-connection-preview="true"]'),
      ).toHaveAttribute("d", /^M .+ [CL] .+/);
      if (cancel)
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchCancel",
          touchPoints: [],
        });
      else {
        const saved = nextSave(page, org);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        expect((await saved).ok()).toBe(true);
      }
    };
    try {
      await cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 1,
      });
      const before = await workflow(page, org, original.id),
        count = saves.length;
      await touch(true);
      expect(saves).toHaveLength(count);
      expect((await workflow(page, org, original.id)).revision).toBe(
        before.revision,
      );
      await touch(false);
    } finally {
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await cdp.detach();
    }
    await page.reload();
    await expect(arrows(page)).toHaveCount(4);
    expect(
      entries(await workflow(page, org, original.id)).find(
        (item) => item.id === "port-top",
      )!.connectionPorts![targetId],
    ).toEqual({ source: "top", target: "bottom" });
    await assertSourceEdge(page, "port-top", targetId, "top", "bottom");
    await screenshot(page, "four-ports-mobile");
  });

  await test.step("very short work boxes keep their right connection port and resize handle independently reachable", async () => {
    const current = await workflow(page, org, original.id);
    const csrf = await (await page.request.get("/api/csrf")).json();
    const response = await page.request.post(`/api/orgs/${org}/sops/save`, {
      headers: { [csrf.headerName]: csrf.token },
      data: {
        id: current.id,
        expectedRevision: current.revision,
        title: current.title,
        category: current.category,
        boardSettings: JSON.stringify({
          ...JSON.parse(current.boardSettings!),
          canvas: { width: 2400, height: 320 },
        }),
        steps: entries(current).map((item) => {
          if (item.kind !== "MODULE") return item;
          const { frame: _frame, position: _position, ...rest } = item;
          return {
            ...rest,
            position:
              item.id === "port-top"
                ? { x: 0.02, y: 0.02 }
                : { x: 0.55, y: 0.55 },
            size: { width: 0.2, height: 0.12 },
          };
        }),
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    await page.goto(path);
    await expect(canvas(page)).toHaveAttribute("data-board-height", "320");
    const box = await tile(page, "port-top").boundingBox();
    expect(box!.height).toBeLessThan(60);
    for (const control of [
      port(page, names.top, "right"),
      page.getByRole("button", {
        name: `调整 ${names.top} 的大小`,
        exact: true,
      }),
    ]) {
      await control.scrollIntoViewIfNeeded();
      expect(
        await control.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          );
          return hit === element || element.contains(hit);
        }),
      ).toBe(true);
    }
    await screenshot(page, "four-ports-compact-mobile");
  });
  expect(errors).toEqual([]);
});
