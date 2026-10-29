import { expect, test, type Page } from "@playwright/test";
import { waitForAutoSave } from "./editor";
import {
  createHandbookViaApi,
  expectNoGlobalNavigation,
  expectWorkflowHome,
} from "./handbook";

type SavedWorkflow = {
  id: string;
  title: string;
  category: string;
  revision: number;
  draft: string;
  boardSettings?: string | null;
};
type Step = {
  id: string;
  kind: string;
  title: string;
  frame?: { x: number; y: number; width: number; height: number };
  connectionPorts?: Record<string, { source: string; target?: string }>;
  [key: string]: unknown;
};
const board = (page: Page) =>
  page.getByRole("region", { name: "流程图", exact: true });
const canvas = (page: Page) => board(page).locator(".flow-board-canvas");
const controls = (page: Page) =>
  board(page).getByRole("group", { name: "流程图缩放", exact: true });
const corner = (page: Page) =>
  board(page).getByRole("button", { name: "缩放流程图", exact: true });
const entries = (saved: SavedWorkflow) => JSON.parse(saved.draft) as Step[];
const nextSave = (page: Page, org: string) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${org}/sops/save`),
  );
async function workflow(
  page: Page,
  org: string,
  id: string,
): Promise<SavedWorkflow> {
  const response = await page.request.get(`/api/orgs/${org}/sops`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).find((item: SavedWorkflow) => item.id === id);
}
async function seed(
  page: Page,
  org: string,
  data: object,
): Promise<SavedWorkflow> {
  const csrf = await (await page.request.get("/api/csrf")).json();
  const response = await page.request.post(`/api/orgs/${org}/sops/save`, {
    headers: { [csrf.headerName]: csrf.token },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function boardScale(page: Page) {
  return board(page)
    .locator(".flow-board-plane")
    .evaluate(
      (element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
    );
}
async function expectScale(page: Page, percent: number) {
  await expect.poll(() => boardScale(page)).toBeCloseTo(percent / 100, 4);
}
async function sizeDialog(page: Page, width: number, height: number) {
  await board(page)
    .getByRole("button", { name: "模版大小", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "模版大小", exact: true });
  await dialog.getByLabel("模版宽度", { exact: true }).fill(String(width));
  await dialog.getByLabel("模版高度", { exact: true }).fill(String(height));
  return dialog;
}
async function geometry(page: Page) {
  return canvas(page).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const work = element
      .querySelector('.flow-tile[data-module-id="zoom-first"]')!
      .getBoundingClientRect();
    return [work.width, work.height, work.x - bounds.x, work.y - bounds.y];
  });
}
async function screenshot(page: Page, name: string) {
  await expectNoGlobalNavigation(page);
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: `../docs/screenshots/${name}.png`,
    fullPage: true,
  });
}

test("manual zoom has no percentage field and board width and height preserve work geometry", async ({
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
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/");
  await expectWorkflowHome(page);
  const org = await createHandbookViaApi(page, `显示缩放验证-${Date.now()}`);
  const name = "准备工具";
  const method = {
    kind: "DETAIL",
    id: "zoom-detail",
    title: name,
    items: [{ id: "zoom-item", text: "核对工具齐全，把尖锐部分朝内放好。" }],
    materials: "干净托盘",
    safetyNotice: "戴好防护手套。",
  };
  const original = await seed(page, org, {
    title: "整张流程图一起缩放",
    category: "显示验证",
    boardSettings: JSON.stringify({
      version: 1,
      timeline: { enabled: true, startMinute: 480, endMinute: 1200, axis: "x" },
      priority: { enabled: true, axis: "y" },
      canvas: { width: 1200, height: 900 },
      referenceCanvas: { width: 820, height: 820 },
    }),
    steps: [
      {
        kind: "MODULE",
        id: "zoom-first",
        title: name,
        frame: { x: 80, y: 80, width: 220, height: 180 },
        nextModuleIds: ["zoom-second"],
        connectionPorts: { "zoom-second": { source: "bottom", target: "top" } },
      },
      {
        kind: "MODULE",
        id: "zoom-second",
        title: "收好工具",
        frame: { x: 600, y: 400, width: 200, height: 160 },
      },
      method,
    ],
  });
  const path = `/workflows/${original.id}`;
  const recordsBefore = await (
    await page.request.get(`/api/orgs/${org}/work-items`)
  ).json();
  await page.goto(path);
  await expect(canvas(page)).toBeVisible();
  await expectScale(page, 100);
  await expect(
    controls(page).getByRole("button", { name: "适应屏幕", exact: true }),
  ).toHaveCount(0);
  await expect(controls(page).locator("input")).toHaveCount(0);
  await expect(page.getByLabel("缩放比例", { exact: true })).toHaveCount(0);
  expect(await controls(page).innerText()).not.toContain("%");
  await expect(corner(page)).toBeVisible();
  for (let i = 0; i < 3; i++)
    await controls(page)
      .getByRole("button", { name: "缩小", exact: true })
      .click();
  await expectScale(page, 70);
  await controls(page)
    .getByRole("button", { name: "放大", exact: true })
    .click();
  await expectScale(page, 80);
  await page.reload();
  await expectScale(page, 80);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectScale(page, 80);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1200 });
  for (let i = 0; i < 2; i++)
    await controls(page)
      .getByRole("button", { name: "放大", exact: true })
      .click();
  await expectScale(page, 100);
  expect(await workflow(page, org, original.id)).toEqual(original);
  expect(saves).toHaveLength(0);
  await test.step("restored width and height settings preserve work pixels and content, enforce bounds and retain creation rules", async () => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.goto(path);
    await expectScale(page, 100);
    const before = await workflow(page, org, original.id),
      snapshot = await geometry(page);
    const beforeConfig = JSON.parse(before.boardSettings!);
    for (const size of [
      { width: 1400, height: 900 },
      { width: 1400, height: 1100 },
    ]) {
      const dialog = await sizeDialog(page, size.width, size.height);
      const saved = nextSave(page, org);
      await dialog.getByRole("button", { name: "应用", exact: true }).click();
      expect((await saved).ok()).toBe(true);
      await expect(canvas(page)).toHaveAttribute(
        "data-board-width",
        String(size.width),
      );
      await expect(canvas(page)).toHaveAttribute(
        "data-board-height",
        String(size.height),
      );
      await expectScale(page, 100);
      const actual = await geometry(page);
      actual.forEach((value, index) =>
        expect(Math.abs(value - snapshot[index])).toBeLessThanOrEqual(1),
      );
      const changed = await workflow(page, org, original.id);
      expect(entries(changed)).toEqual(entries(before));
      expect(changed.title).toBe(before.title);
      expect(changed.category).toBe(before.category);
      await expect(
        canvas(page).locator(
          'path[data-source="zoom-first"][data-target="zoom-second"]',
        ),
      ).toHaveAttribute("data-source-side", "bottom");
      await expect(
        canvas(page).locator(
          'path[data-source="zoom-first"][data-target="zoom-second"]',
        ),
      ).toHaveAttribute("data-target-side", "top");
      expect(JSON.parse(changed.boardSettings!)).toMatchObject({
        timeline: beforeConfig.timeline,
        priority: beforeConfig.priority,
        canvas: size,
      });
      await page.reload();
      await expect(canvas(page)).toHaveAttribute(
        "data-board-height",
        String(size.height),
      );
      const reloaded = await geometry(page);
      reloaded.forEach((value, index) =>
        expect(Math.abs(value - snapshot[index])).toBeLessThanOrEqual(1),
      );
    }
    const count = saves.length;
    const invalid = await sizeDialog(page, 320, 320);
    await invalid.getByRole("button", { name: "应用", exact: true }).click();
    await expect(invalid.getByRole("alert")).toBeVisible();
    await invalid.getByRole("button", { name: "取消", exact: true }).click();
    expect(saves).toHaveLength(count);
    const cancelled = await sizeDialog(page, 1600, 1200);
    await cancelled
      .getByRole("button", { name: "恢复默认大小", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(cancelled).toHaveCount(0);
    expect(saves).toHaveLength(count);
    await screenshot(page, "board-controls-desktop");
    await page.goto(`${path}/edit`);
    await waitForAutoSave(page);
    const editor = await sizeDialog(page, 1450, 1100);
    const saved = nextSave(page, org);
    await editor.getByRole("button", { name: "应用", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await waitForAutoSave(page);
    expect(entries(await workflow(page, org, original.id))).toEqual(
      entries(before),
    );
    const records = await (
      await page.request.get(`/api/orgs/${org}/work-items`)
    ).json();
    expect(records.map((item: { id: string }) => item.id).sort()).toEqual(
      recordsBefore.map((item: { id: string }) => item.id).sort(),
    );
    await page.goto("/workflows/new");
    await page
      .getByLabel("流程名称", { exact: true })
      .fill("恢复宽高设置的新流程");
    const newCount = saves.length,
      draft = await sizeDialog(page, 1100, 700);
    await draft.getByRole("button", { name: "应用", exact: true }).click();
    await expect(canvas(page)).toHaveAttribute("data-board-width", "1100");
    expect(saves).toHaveLength(newCount);
    await page.getByRole("button", { name: "添加流程", exact: true }).click();
    await expect(page).toHaveURL(/\/workflows\/[a-f0-9-]{36}$/);
    await page.reload();
    await expect(canvas(page)).toHaveAttribute("data-board-width", "1100");
    await expect(canvas(page)).toHaveAttribute("data-board-height", "700");
    await page.setViewportSize({ width: 390, height: 844 });
    const phone = await sizeDialog(page, 1100, 700);
    await screenshot(page, "board-controls-size-mobile");
    await phone.getByRole("button", { name: "取消", exact: true }).click();
  });
  expect(errors).toEqual([]);
});
