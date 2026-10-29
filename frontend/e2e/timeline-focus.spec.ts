import { expect, test, type Page } from "@playwright/test";
import { createHandbookViaApi, expectWorkflowHome } from "./handbook";

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
const badge = (page: Page, title: string) =>
  board(page).getByLabel(`${title} 的时间和优先级`, { exact: true });
async function seed(page: Page, org: string, data: object): Promise<Workflow> {
  const csrf = await (await page.request.get("/api/csrf")).json();
  const response = await page.request.post(`/api/orgs/${org}/sops/save`, {
    headers: { [csrf.headerName]: csrf.token },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function read(page: Page, org: string, id: string): Promise<Workflow> {
  const response = await page.request.get(`/api/orgs/${org}/sops`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).find((item: Workflow) => item.id === id);
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
async function labels(page: Page, titles: string[]) {
  return Promise.all(
    titles.map(async (title) => ({
      time: await badge(page, title).getAttribute("data-axis-time"),
      priority: await badge(page, title).getAttribute("data-axis-priority"),
    })),
  );
}
test("legacy focused timelines load unchanged with every hour and the interval-length dialog", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(45_000);
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
  const org = await createHandbookViaApi(page, `局部时间拉宽-${Date.now()}`);
  const titles = ["十点准备", "十二点检查", "九点十七核对", "半分钟交接"];
  const original = await seed(page, org, {
    title: "上午两小时需要更多空间",
    category: "时段安排",
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
      referenceCanvas: { width: 820, height: 820 },
    }),
    steps: [
      {
        kind: "MODULE",
        id: "focus-ten",
        title: titles[0],
        frame: { x: 90, y: 60, width: 100, height: 80 },
        nextModuleIds: ["focus-twelve"],
        connectionPorts: {
          "focus-twelve": { source: "bottom", target: "left" },
        },
      },
      {
        kind: "MODULE",
        id: "focus-twelve",
        title: titles[1],
        frame: { x: 360, y: 400, width: 100, height: 80 },
      },
      {
        kind: "MODULE",
        id: "focus-precise",
        title: titles[2],
        frame: { x: 57.9375, y: 650, width: 100, height: 80 },
      },
      {
        kind: "MODULE",
        id: "focus-half-minute",
        title: titles[3],
        frame: { x: 413.625, y: 500, width: 100, height: 80 },
      },
      {
        kind: "DETAIL",
        id: "focus-detail",
        title: titles[0],
        items: [
          { id: "focus-item", text: "按清单核对零件，完成后交给下一位。" },
        ],
        materials: "核对清单",
        safetyNotice: "保持通道畅通。",
        videoUrl: "https://example.com/focus-method",
      },
    ],
  });
  const path = `/workflows/${original.id}`,
    originalIds = await recordIds(page, org, original.id);
  await page.goto(path);
  await expect(canvas(page)).toBeVisible();
  await expect
    .poll(() =>
      board(page)
        .getByRole("region", { name: "时间线", exact: true })
        .locator(".flow-time-tick")
        .allTextContents(),
    )
    .toEqual(
      Array.from(
        { length: 13 },
        (_, index) => `${String(index + 8).padStart(2, "0")}:00`,
      ),
    );
  expect(await labels(page, titles)).toEqual([
    { time: "10:00", priority: "优先做" },
    { time: "12:00", priority: "正常安排" },
    { time: "09:17", priority: "可以稍后" },
    { time: "13:12", priority: "可以稍后" },
  ]);
  expect(await read(page, org, original.id)).toEqual(original);
  const dialog = await settings(page);
  await expect(dialog.getByLabel("拉宽一段时间", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByText("每段时间的长度", { exact: true }),
  ).toBeVisible();
  const outside = Number(
    await dialog
      .getByRole("spinbutton", { name: "08:00–09:00 的长度", exact: true })
      .inputValue(),
  );
  const inside = Number(
    await dialog
      .getByRole("spinbutton", { name: "10:00–11:00 的长度", exact: true })
      .inputValue(),
  );
  expect(Math.abs(inside - outside * 3)).toBeLessThanOrEqual(1);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(await read(page, org, original.id)).toEqual(original);
  expect(await recordIds(page, org, original.id)).toEqual(originalIds);
  expect(saves).toHaveLength(0);
  expect(errors).toEqual([]);
});
