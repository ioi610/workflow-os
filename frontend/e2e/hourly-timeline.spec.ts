import { expect, test, type Locator, type Page } from "@playwright/test";
import { waitForAutoSave } from "./editor";
import {
  createHandbookViaApi,
  expectNoGlobalNavigation,
  expectWorkflowHome,
} from "./handbook";

type Entry = {
  id: string;
  kind: string;
  title: string;
  frame?: { x: number; y: number; width: number; height: number };
  [key: string]: unknown;
};
type Workflow = {
  id: string;
  title: string;
  category: string;
  revision: number;
  draft: string;
  boardSettings: string;
};
const board = (page: Page) =>
  page.getByRole("region", { name: "流程图", exact: true });
const canvas = (page: Page) => board(page).locator(".flow-board-canvas");
const timeline = (page: Page) =>
  board(page).getByRole("region", { name: "时间线", exact: true });
const entries = (value: Workflow) => JSON.parse(value.draft) as Entry[];
const config = (value: Workflow) => JSON.parse(value.boardSettings);
const nextSave = (page: Page, org: string) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${org}/sops/save`),
  );
async function seed(page: Page, org: string, data: object): Promise<Workflow> {
  const token = await (await page.request.get("/api/csrf")).json();
  const response = await page.request.post(`/api/orgs/${org}/sops/save`, {
    headers: { [token.headerName]: token.token },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function read(page: Page, org: string, id: string): Promise<Workflow> {
  const response = await page.request.get(`/api/orgs/${org}/sops`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).find((value: Workflow) => value.id === id);
}
async function recordIds(page: Page, org: string, id: string) {
  const response = await page.request.get(`/api/orgs/${org}/work-items`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json())
    .filter((item: { workflowId: string }) => item.workflowId === id)
    .map((item: { id: string }) => item.id)
    .sort();
}
async function settings(page: Page) {
  await board(page)
    .getByRole("button", { name: "时间和优先级", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "时间和优先级",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function apply(page: Page, org: string, dialog: Locator) {
  const saved = nextSave(page, org);
  await dialog.getByRole("button", { name: "应用", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(dialog).toHaveCount(0);
}
async function labels(page: Page, titles: string[]) {
  return Promise.all(
    titles.map(async (title) => {
      const value = board(page).getByLabel(`${title} 的时间和优先级`, {
        exact: true,
      });
      return {
        time: await value.getAttribute("data-axis-time"),
        priority: await value.getAttribute("data-axis-priority"),
      };
    }),
  );
}
function stableContent(value: Workflow) {
  return entries(value).map((entry) =>
    entry.frame
      ? {
          ...entry,
          frame: { width: entry.frame.width, height: entry.frame.height },
        }
      : entry,
  );
}
async function lengths(page: Page) {
  return timeline(page)
    .locator(".flow-time-tick")
    .evaluateAll((elements) => {
      const axis = elements[0]
        .closest('[aria-label="时间线"]')!
        .getAttribute("data-axis");
      const plane = elements[0].closest(".flow-board-plane")!;
      const canvas = plane.querySelector(".flow-board-canvas")!;
      const extent = Number(
        canvas.getAttribute(
          axis === "x" ? "data-board-width" : "data-board-height",
        ),
      );
      const points = elements.map((element) => ({
        label: element.textContent!.trim(),
        point:
          (parseFloat(
            (element as HTMLElement).style[axis === "x" ? "left" : "top"],
          ) /
            100) *
          extent,
      }));
      return points.slice(1).map((point, index) => ({
        label: `${points[index].label}–${point.label}`,
        length: point.point - points[index].point,
      }));
    });
}
async function ticks(page: Page) {
  return timeline(page).locator(".flow-time-tick").allTextContents();
}
async function dragTick(
  page: Page,
  label: string,
  delta: number,
  axis: "x" | "y",
  cancel = false,
) {
  const slider = timeline(page).getByRole("slider", {
    name: `调整 ${label} 刻度`,
    exact: true,
  });
  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!,
    point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(
    point.x + (axis === "x" ? delta : 0),
    point.y + (axis === "y" ? delta : 0),
    { steps: 10 },
  );
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}
async function screenshot(page: Page, name: string) {
  await expectNoGlobalNavigation(page);
  await page.screenshot({
    path: `../docs/screenshots/${name}.png`,
    fullPage: true,
  });
}
function unchangedIntervals(
  before: { length: number }[],
  after: { length: number }[],
  changed: number[],
) {
  expect(after).toHaveLength(before.length);
  before.forEach((value, index) => {
    if (!changed.includes(index))
      expect(Math.abs(after[index].length - value.length)).toBeLessThanOrEqual(
        1,
      );
  });
}

test("every hour is visible and independent interval lengths preserve work times and data", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000);
  expect(baseURL).toBe("http://127.0.0.1:5174");
  const errors: string[] = [],
    saves: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/sops/save"))
      saves.push(request.postData() || "");
  });
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/");
  await expectWorkflowHome(page);
  const org = await createHandbookViaApi(page, `每小时分段验证-${Date.now()}`),
    titles = ["十点准备", "十二点核对", "保留精确分钟"];
  const original = await seed(page, org, {
    title: "每小时单独调整长度",
    category: "时间安排",
    boardSettings: JSON.stringify({
      version: 1,
      timeline: {
        enabled: true,
        startMinute: 480,
        endMinute: 1200,
        axis: "x",
        focus: { startOffset: 120, endOffset: 240, scale: 3 },
      },
      priority: { enabled: true, axis: "y" },
      canvas: { width: 820, height: 820 },
    }),
    steps: [
      {
        kind: "MODULE",
        id: "hour-ten",
        title: titles[0],
        frame: { x: 90, y: 60, width: 100, height: 80 },
        nextModuleIds: ["hour-twelve"],
        connectionPorts: {
          "hour-twelve": { source: "bottom", target: "left" },
        },
      },
      {
        kind: "MODULE",
        id: "hour-twelve",
        title: titles[1],
        frame: { x: 360, y: 400, width: 100, height: 80 },
      },
      {
        kind: "MODULE",
        id: "hour-precise",
        title: titles[2],
        frame: { x: 57.9375, y: 650, width: 100, height: 80 },
      },
      {
        kind: "DETAIL",
        id: "hour-detail",
        title: titles[0],
        items: [{ id: "hour-step", text: "核对原有内容，保留编号与箭头。" }],
        materials: "原始清单",
        safetyNotice: "保持通道畅通。",
      },
    ],
  });
  const path = `/workflows/${original.id}`,
    ids = await recordIds(page, org, original.id);
  await page.goto(path);
  await expect(canvas(page)).toBeVisible();
  await expect
    .poll(() => ticks(page))
    .toEqual(
      Array.from(
        { length: 13 },
        (_, index) => `${String(index + 8).padStart(2, "0")}:00`,
      ),
    );
  await expect(timeline(page).getByRole("slider")).toHaveCount(12);
  const originalLabels = await labels(page, titles),
    before = await lengths(page);
  expect(originalLabels.map((value) => value.time)).toEqual([
    "10:00",
    "12:00",
    "09:17",
  ]);
  expect(before[2].length).toBeCloseTo(before[0].length * 3, 2);

  await test.step("one modal interval grows the canvas without changing other intervals or work meaning", async () => {
    const count = saves.length,
      dialog = await settings(page);
    await expect(
      dialog.getByText("每段时间的长度", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByLabel("拉宽一段时间", { exact: true }),
    ).toHaveCount(0);
    const input = dialog.getByRole("spinbutton", {
      name: "09:00–10:00 的长度",
      exact: true,
    });
    await expect(input).toHaveAttribute("min", "24");
    await input.fill(String(before[1].length + 60));
    await input.press("Tab");
    expect(saves).toHaveLength(count);
    await screenshot(page, "hourly-timeline-settings-desktop");
    await apply(page, org, dialog);
    expect(saves).toHaveLength(count + 1);
    await expect(canvas(page)).toHaveAttribute("data-board-width", "880");
    const after = await lengths(page);
    expect(after[1].length - before[1].length).toBeCloseTo(60, 0);
    unchangedIntervals(before, after, [1]);
    expect(await labels(page, titles)).toEqual(originalLabels);
    const current = await read(page, org, original.id);
    expect(config(current).timeline.segments).toBeTruthy();
    expect(stableContent(current)).toEqual(stableContent(original));
    expect(await recordIds(page, org, original.id)).toEqual(ids);
    await page.reload();
    await expect(canvas(page)).toHaveAttribute("data-board-width", "880");
    expect(await labels(page, titles)).toEqual(originalLabels);
  });

  await test.step("internal and endpoint tick drags save once, have independent effects and support cancellation", async () => {
    const before = await lengths(page),
      count = saves.length;
    let saved = nextSave(page, org);
    await dragTick(page, "10:00", 32, "x");
    expect((await saved).ok()).toBe(true);
    expect(saves).toHaveLength(count + 1);
    await expect(canvas(page)).toHaveAttribute("data-board-width", "880");
    const moved = await lengths(page);
    expect(moved[1].length - before[1].length).toBeCloseTo(32, 0);
    expect(moved[2].length - before[2].length).toBeCloseTo(-32, 0);
    unchangedIntervals(before, moved, [1, 2]);
    saved = nextSave(page, org);
    await dragTick(page, "20:00", 40, "x");
    expect((await saved).ok()).toBe(true);
    expect(saves).toHaveLength(count + 2);
    await expect(canvas(page)).toHaveAttribute("data-board-width", "920");
    const extended = await lengths(page);
    expect(extended.at(-1)!.length - moved.at(-1)!.length).toBeCloseTo(40, 0);
    unchangedIntervals(moved, extended, [extended.length - 1]);
    expect(await labels(page, titles)).toEqual(originalLabels);
    const beforeCancel = await read(page, org, original.id),
      cancelled = saves.length;
    await dragTick(page, "10:00", 20, "x", true);
    expect(saves).toHaveLength(cancelled);
    expect(await read(page, org, original.id)).toEqual(beforeCancel);
    const invalid = await settings(page);
    await invalid
      .getByRole("spinbutton", { name: "09:00–10:00 的长度", exact: true })
      .fill("1");
    await invalid.getByRole("button", { name: "应用", exact: true }).click();
    await expect(invalid.getByRole("alert")).toBeVisible();
    await invalid.getByRole("button", { name: "取消", exact: true }).click();
    expect(saves).toHaveLength(cancelled);
    await screenshot(page, "hourly-timeline-desktop");
  });

  await test.step("keyboard adjustment autosaves in the editor and preserves fixed work sizes and identifiers", async () => {
    await page.goto(`${path}/edit`);
    await waitForAutoSave(page);
    const before = await lengths(page),
      count = saves.length;
    const slider = timeline(page).getByRole("slider", {
      name: "调整 10:00 刻度",
      exact: true,
    });
    await slider.focus();
    const saved = nextSave(page, org);
    await slider.press("ArrowRight");
    expect((await saved).ok()).toBe(true);
    await waitForAutoSave(page);
    expect(saves).toHaveLength(count + 1);
    const after = await lengths(page);
    expect(after[1].length - before[1].length).toBeCloseTo(8, 0);
    expect(after[2].length - before[2].length).toBeCloseTo(-8, 0);
    const fineSave = nextSave(page, org);
    await slider.press("Shift+ArrowRight");
    expect((await fineSave).ok()).toBe(true);
    await waitForAutoSave(page);
    expect(saves).toHaveLength(count + 2);
    const fine = await lengths(page);
    expect(fine[1].length - after[1].length).toBeCloseTo(1, 0);
    expect(fine[2].length - after[2].length).toBeCloseTo(-1, 0);
    expect(await labels(page, titles)).toEqual(originalLabels);
    expect(stableContent(await read(page, org, original.id))).toEqual(
      stableContent(original),
    );
    expect(await recordIds(page, org, original.id)).toEqual(ids);
  });

  await test.step("partial hours and every cross-midnight hour remain visible vertically on mobile", async () => {
    const night = await seed(page, org, {
      title: "跨日半点到一刻",
      category: "时间安排",
      boardSettings: JSON.stringify({
        version: 1,
        timeline: {
          enabled: true,
          startMinute: 1350,
          endMinute: 135,
          axis: "y",
        },
        priority: { enabled: true, axis: "x" },
        canvas: { width: 820, height: 820 },
      }),
      steps: [],
    });
    await page.goto(`/workflows/${night.id}`);
    await expect
      .poll(() => ticks(page))
      .toEqual([
        "22:30",
        "23:00",
        "次日 00:00",
        "次日 01:00",
        "次日 02:00",
        "次日 02:15",
      ]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(
      (id) =>
        localStorage.setItem(
          `workflow-os:board-zoom:${id}`,
          JSON.stringify({ version: 1, mode: "manual", scale: 0.75 }),
        ),
      night.id,
    );
    await page.reload();
    await expect(timeline(page)).toHaveAttribute("data-axis", "y");
    const beforeTouch = await lengths(page),
      touchCount = saves.length;
    const handle = timeline(page).getByRole("slider", {
      name: "调整 次日 00:00 刻度",
      exact: true,
    });
    await handle.scrollIntoViewIfNeeded();
    const handleBox = (await handle.boundingBox())!,
      start = {
        x: handleBox.x + handleBox.width / 2,
        y: handleBox.y + handleBox.height / 2,
      };
    const cdp = await page.context().newCDPSession(page);
    const touchSave = nextSave(page, org);
    try {
      await cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 1,
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ ...start, id: 1 }],
      });
      for (let step = 1; step <= 10; step++)
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: start.x, y: start.y + (22.5 * step) / 10, id: 1 }],
        });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      expect((await touchSave).ok()).toBe(true);
    } finally {
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await cdp.detach();
    }
    expect(saves).toHaveLength(touchCount + 1);
    const afterTouch = await lengths(page);
    expect(afterTouch[1].length - beforeTouch[1].length).toBeCloseTo(30, 0);
    expect(afterTouch[2].length - beforeTouch[2].length).toBeCloseTo(-30, 0);
    unchangedIntervals(beforeTouch, afterTouch, [1, 2]);
    await expect(canvas(page)).toHaveAttribute("data-board-height", "820");
    const dialog = await settings(page);
    await expect(
      dialog.getByRole("spinbutton", {
        name: "23:00–次日 00:00 的长度",
        exact: true,
      }),
    ).toBeVisible();
    await screenshot(page, "hourly-timeline-settings-mobile");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await screenshot(page, "hourly-timeline-vertical-mobile");
  });

  await test.step("new workflows keep interval edits local until explicit creation", async () => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.goto("/workflows/new");
    await page.getByLabel("流程名称", { exact: true }).fill("新建独立时段长度");
    const count = saves.length,
      dialog = await settings(page);
    await dialog.getByLabel("显示时间线", { exact: true }).check();
    await dialog.getByLabel("开始时间", { exact: true }).fill("08:00");
    await dialog.getByLabel("结束时间", { exact: true }).fill("20:00");
    const input = dialog.getByRole("spinbutton", {
      name: "09:00–10:00 的长度",
      exact: true,
    });
    const value = Number(await input.inputValue());
    await input.fill(String(value + 40));
    await input.press("Tab");
    await dialog.getByRole("button", { name: "应用", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(saves).toHaveLength(count);
    await page.getByRole("button", { name: "添加流程", exact: true }).click();
    await expect(page).toHaveURL(/\/workflows\/[a-f0-9-]{36}$/);
    const id = new URL(page.url()).pathname.split("/").pop()!;
    expect(config(await read(page, org, id)).timeline.segments).toBeTruthy();
  });
  await test.step("dense full-day hours stay complete with rotated labels and a taller header", async () => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    const dense = await seed(page, org, {
      title: "紧凑画板也显示全部小时",
      category: "时间安排",
      boardSettings: JSON.stringify({
        version: 1,
        timeline: { enabled: true, startMinute: 0, endMinute: 1439, axis: "x" },
        priority: { enabled: false, axis: "y" },
        canvas: { width: 320, height: 820 },
      }),
      steps: [],
    });
    await page.goto(`/workflows/${dense.id}`);
    await expect
      .poll(() => ticks(page))
      .toEqual([
        ...Array.from(
          { length: 24 },
          (_, index) => `${String(index).padStart(2, "0")}:00`,
        ),
        "23:59",
      ]);
    await expect(timeline(page)).toHaveClass(/has-compact-time-labels/);
    const display = await timeline(page)
      .locator(".flow-time-tick-label")
      .first()
      .evaluate((element) => {
        const plane = element.closest(".flow-board-plane")!;
        const matrix = new DOMMatrixReadOnly(
          getComputedStyle(element).transform,
        );
        return {
          a: matrix.a,
          b: matrix.b,
          header: parseFloat(getComputedStyle(plane).gridTemplateRows),
          scale: new DOMMatrixReadOnly(getComputedStyle(plane).transform).a,
        };
      });
    expect(display.a).toBeCloseTo(0, 6);
    expect(display.b).toBeCloseTo(-1, 6);
    expect(display.header).toBe(96);
    expect(display.scale).toBe(1);
    await screenshot(page, "hourly-timeline-dense-desktop");
  });
  expect(errors).toEqual([]);
});
