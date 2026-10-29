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
  draft: string;
  revision: number;
  boardSettings?: string | null;
};
type AxisSettings = {
  version: 1;
  timeline: {
    enabled: boolean;
    startMinute: number;
    endMinute: number;
    axis?: "x" | "y";
  };
  priority: { enabled: boolean; axis?: "x" | "y" };
};
type StoredStep = {
  kind: string;
  id: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  frame?: { x: number; y: number; width: number; height: number };
  [key: string]: unknown;
};

const board = (page: Page) =>
  page.getByRole("region", { name: "流程图", exact: true });
const canvas = (page: Page) => board(page).locator(".flow-board-canvas");
const timeline = (page: Page) =>
  board(page).getByRole("region", { name: "时间线", exact: true });
const priority = (page: Page) =>
  board(page).getByRole("region", { name: "优先级", exact: true });
const badge = (page: Page, name: string) =>
  page.getByLabel(`${name} 的时间和优先级`, { exact: true });
const tile = (page: Page, name: string) =>
  page
    .getByRole("button", { name: `拖动工作 ${name}`, exact: true })
    .locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' flow-tile ')]",
    )
    .first();

async function workflows(page: Page, org: string): Promise<SavedWorkflow[]> {
  const response = await page.request.get(`/api/orgs/${org}/sops`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function workflow(page: Page, org: string, id: string) {
  const found = (await workflows(page, org)).find((item) => item.id === id);
  expect(found).toBeTruthy();
  return found!;
}
async function records(page: Page, org: string) {
  const response = await page.request.get(`/api/orgs/${org}/work-items`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<
    { id: string; moduleId: string; workflowId: string }[]
  >;
}
const entries = (saved: SavedWorkflow) =>
  JSON.parse(saved.draft) as StoredStep[];
const settings = (saved: SavedWorkflow) =>
  JSON.parse(saved.boardSettings || "null") as AxisSettings | null;
function nextSave(page: Page, org: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${org}/sops/save`),
  );
}
async function configure(page: Page) {
  await board(page)
    .getByRole("button", { name: "时间和优先级", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "时间和优先级",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(
    Math.abs(bounds!.x + bounds!.width / 2 - viewport.width / 2),
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(bounds!.y + bounds!.height / 2 - viewport.height / 2),
  ).toBeLessThanOrEqual(2);
  return dialog;
}
async function screenshot(page: Page, name: string) {
  await expectNoGlobalNavigation(page);
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: `../docs/screenshots/${name}.png`,
    fullPage: true,
  });
}

test("optional timeline and priority axes follow work geometry and persist without changing work records or methods", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  expect(baseURL).toBe("http://127.0.0.1:5174");
  const errors: string[] = [];
  const savedRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/sops/save"))
      savedRequests.push(request.url());
  });
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/");
  await expectWorkflowHome(page);
  const org = await createHandbookViaApi(
    page,
    `时间和优先级验证-${Date.now()}`,
  );
  const name = "准备工具";
  const csrf = await (await page.request.get("/api/csrf")).json();
  const response = await page.request.post(`/api/orgs/${org}/sops/save`, {
    headers: { [csrf.headerName]: csrf.token },
    data: {
      title: "没有坐标设置的旧流程",
      category: "工作安排",
      steps: [
        {
          kind: "MODULE",
          id: "axis-first",
          title: name,
          position: { x: 0.1, y: 0.2 },
          nextModuleIds: ["axis-second"],
        },
        {
          kind: "MODULE",
          id: "axis-second",
          title: "收好工具",
          position: { x: 0.68, y: 0.65 },
        },
        {
          kind: "DETAIL",
          id: "axis-detail",
          title: name,
          items: [
            { id: "axis-item", text: "检查工具齐全，并放在干净的托盘内。" },
          ],
          materials: "干净托盘",
          safetyNotice: "尖锐工具朝向内侧。",
          videoUrl: "https://example.com/prepare-tools",
        },
      ],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const original = (await response.json()) as SavedWorkflow;
  const path = `/workflows/${original.id}`;
  const originalRecords = await records(page, org);
  const originalDetails = entries(original).filter(
    (item) => item.kind === "DETAIL",
  );
  const originalModules = entries(original).filter(
    (item) => item.kind === "MODULE",
  );
  await page.goto(path);
  await expect(canvas(page)).toBeVisible();

  await test.step("old workflows stay unchanged until settings are applied, and cancel or invalid ranges never save", async () => {
    await expect(timeline(page)).toHaveCount(0);
    await expect(priority(page)).toHaveCount(0);
    await expect(badge(page, name)).toHaveCount(0);
    expect(original.boardSettings ?? null).toBeNull();
    const unchangedRequests = savedRequests.length;
    const dialog = await configure(page);
    await expect(
      dialog.getByLabel("显示时间线", { exact: true }),
    ).not.toBeChecked();
    await expect(
      dialog.getByLabel("显示优先级", { exact: true }),
    ).not.toBeChecked();
    await dialog.getByLabel("显示时间线", { exact: true }).check();
    await dialog.getByLabel("开始时间", { exact: true }).fill("08:00");
    await dialog.getByLabel("结束时间", { exact: true }).fill("08:00");
    await dialog.getByRole("button", { name: "应用", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(savedRequests).toHaveLength(unchangedRequests);
    expect((await workflow(page, org, original.id)).revision).toBe(
      original.revision,
    );
    const cancelled = await configure(page);
    await cancelled.getByLabel("显示时间线", { exact: true }).check();
    await cancelled.getByLabel("显示优先级", { exact: true }).check();
    await cancelled
      .getByRole("combobox", { name: "时间线方向", exact: true })
      .selectOption("y");
    await page.keyboard.press("Escape");
    await expect(cancelled).toHaveCount(0);
    expect(savedRequests).toHaveLength(unchangedRequests);
    await expect(timeline(page)).toHaveCount(0);
  });

  await test.step("old settings default missing directions and infer the opposite when only one direction exists", async () => {
    const token = await (await page.request.get("/api/csrf")).json();
    const cases: {
      title: string;
      time?: "x" | "y";
      priority?: "x" | "y";
      expectedTime: "x" | "y";
      expectedPriority: "x" | "y";
    }[] = [
      {
        title: "未填写方向的旧坐标设置",
        expectedTime: "x",
        expectedPriority: "y",
      },
      {
        title: "仅填写时间方向的坐标设置",
        time: "y",
        expectedTime: "y",
        expectedPriority: "x",
      },
      {
        title: "仅填写优先级方向的坐标设置",
        priority: "x",
        expectedTime: "y",
        expectedPriority: "x",
      },
    ];
    for (const item of cases) {
      const response = await page.request.post(`/api/orgs/${org}/sops/save`, {
        headers: { [token.headerName]: token.token },
        data: {
          title: item.title,
          category: "兼容验证",
          steps: [],
          boardSettings: JSON.stringify({
            version: 1,
            timeline: {
              enabled: true,
              startMinute: 480,
              endMinute: 1200,
              axis: item.time,
            },
            priority: { enabled: true, axis: item.priority },
          }),
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
      const legacy = (await response.json()) as SavedWorkflow;
      const unchanged = savedRequests.length;
      await page.goto(`/workflows/${legacy.id}`);
      await expect(timeline(page)).toHaveAttribute(
        "data-axis",
        item.expectedTime,
      );
      await expect(priority(page)).toHaveAttribute(
        "data-axis",
        item.expectedPriority,
      );
      const dialog = await configure(page);
      await expect(
        dialog.getByRole("combobox", { name: "时间线方向", exact: true }),
      ).toHaveValue(item.expectedTime);
      await expect(
        dialog.getByRole("combobox", { name: "优先级方向", exact: true }),
      ).toHaveValue(item.expectedPriority);
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      expect(savedRequests).toHaveLength(unchanged);
      expect((await workflow(page, org, legacy.id)).revision).toBe(
        legacy.revision,
      );
    }
    await page.goto(path);
    await expect(canvas(page)).toBeVisible();
  });

  await test.step("saved boards keep both axes and their settings after refresh", async () => {
    const dialog = await configure(page);
    await dialog.getByLabel("显示时间线", { exact: true }).check();
    await dialog.getByLabel("显示优先级", { exact: true }).check();
    await dialog.getByLabel("开始时间", { exact: true }).fill("08:00");
    await dialog.getByLabel("结束时间", { exact: true }).fill("20:00");
    await screenshot(page, "axes-settings-desktop");
    const saved = nextSave(page, org);
    await dialog.getByRole("button", { name: "应用", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(dialog).toHaveCount(0);
    await expect(timeline(page)).toBeVisible();
    await expect(priority(page)).toBeVisible();
    await expect(timeline(page)).toContainText("08:00");
    await expect(timeline(page)).toContainText("20:00");
    for (const label of ["优先做", "正常安排", "可以稍后"])
      await expect(priority(page)).toContainText(label);
    await expect(badge(page, name)).toHaveAttribute("data-axis-time", "09:30");
    await expect(badge(page, name)).toHaveAttribute(
      "data-axis-priority",
      "优先做",
    );
    const record = await workflow(page, org, original.id);
    expect(settings(record)).toMatchObject({
      version: 1,
      timeline: { enabled: true, startMinute: 480, endMinute: 1200, axis: "x" },
      priority: { enabled: true, axis: "y" },
    });
    expect(entries(record).filter((item) => item.kind === "MODULE")).toEqual(
      originalModules,
    );
    await page.reload();
    await expect(timeline(page)).toBeVisible();
    await expect(badge(page, name)).toHaveAttribute("data-axis-time", "09:30");
    const reopened = await configure(page);
    await expect(reopened.getByLabel("开始时间", { exact: true })).toHaveValue(
      "08:00",
    );
    await expect(reopened.getByLabel("结束时间", { exact: true })).toHaveValue(
      "20:00",
    );
    await reopened.getByRole("button", { name: "取消", exact: true }).click();
    await screenshot(page, "axes-board-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, "axes-board-mobile");
    await page.setViewportSize({ width: 1440, height: 1200 });
  });

  await test.step("choosing either direction swaps the other axis and persists the new coordinate mapping", async () => {
    const dialog = await configure(page);
    await dialog
      .getByRole("combobox", { name: "时间线方向", exact: true })
      .selectOption("y");
    await expect(
      dialog.getByRole("combobox", { name: "优先级方向", exact: true }),
    ).toHaveValue("x");
    await dialog
      .getByRole("combobox", { name: "优先级方向", exact: true })
      .selectOption("y");
    await expect(
      dialog.getByRole("combobox", { name: "时间线方向", exact: true }),
    ).toHaveValue("x");
    await dialog
      .getByRole("combobox", { name: "优先级方向", exact: true })
      .selectOption("x");
    await expect(
      dialog.getByRole("combobox", { name: "时间线方向", exact: true }),
    ).toHaveValue("y");
    await screenshot(page, "axes-directions-settings-desktop");
    const saved = nextSave(page, org);
    await dialog.getByRole("button", { name: "应用", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(timeline(page)).toHaveAttribute("data-axis", "y");
    await expect(priority(page)).toHaveAttribute("data-axis", "x");
    await expect(badge(page, name)).toHaveAttribute("data-axis-time", "11:00");
    await expect(badge(page, name)).toHaveAttribute(
      "data-axis-priority",
      "优先做",
    );
    const record = await workflow(page, org, original.id);
    expect(settings(record)).toMatchObject({
      version: 1,
      timeline: { enabled: true, startMinute: 480, endMinute: 1200, axis: "y" },
      priority: { enabled: true, axis: "x" },
    });
    expect(entries(record).filter((item) => item.kind === "MODULE")).toEqual(
      originalModules,
    );
    await page.reload();
    await expect(timeline(page)).toHaveAttribute("data-axis", "y");
    await expect(priority(page)).toHaveAttribute("data-axis", "x");
    await expect(badge(page, name)).toHaveAttribute("data-axis-time", "11:00");
    await screenshot(page, "axes-swapped-board-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, "axes-swapped-board-mobile");
    await page.setViewportSize({ width: 1440, height: 1200 });
  });

  await test.step("drag and resizing update movable-range axis values while preserving work records", async () => {
    await canvas(page).scrollIntoViewIfNeeded();
    const frame = await canvas(page).boundingBox();
    const grip = await page
      .getByRole("button", { name: `拖动工作 ${name}`, exact: true })
      .boundingBox();
    expect(frame).toBeTruthy();
    expect(grip).toBeTruthy();
    await page.mouse.move(
      grip!.x + grip!.width / 2,
      grip!.y + grip!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      grip!.x + grip!.width / 2 + frame!.width * 0.35,
      grip!.y + grip!.height / 2 + frame!.height * 0.4,
      { steps: 16 },
    );
    await expect(tile(page, name)).toHaveClass(/is-dragging/);
    await expect(badge(page, name)).not.toHaveAttribute(
      "data-axis-time",
      "11:00",
    );
    await expect(badge(page, name)).toHaveAttribute(
      "data-axis-priority",
      "正常安排",
    );
    const moved = nextSave(page, org);
    await page.mouse.up();
    expect((await moved).ok()).toBe(true);
    const afterMove = await workflow(page, org, original.id);
    const oldTime = await badge(page, name).getAttribute("data-axis-time");
    const current = await tile(page, name).boundingBox();
    const resize = await page
      .getByRole("button", { name: `调整 ${name} 的大小`, exact: true })
      .boundingBox();
    expect(current).toBeTruthy();
    expect(resize).toBeTruthy();
    await page.mouse.move(
      resize!.x + resize!.width / 2,
      resize!.y + resize!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      resize!.x + resize!.width / 2 + frame!.width * 0.1,
      resize!.y + resize!.height / 2 + frame!.height * 0.05,
      { steps: 16 },
    );
    await expect(tile(page, name)).toHaveClass(/is-resizing/);
    await expect(badge(page, name)).not.toHaveAttribute(
      "data-axis-time",
      oldTime!,
    );
    const resized = nextSave(page, org);
    await page.mouse.up();
    expect((await resized).ok()).toBe(true);
    const saved = await workflow(page, org, original.id);
    const module = entries(saved).find((item) => item.id === "axis-first")!;
    const movedFrame = entries(afterMove).find(
      (item) => item.id === "axis-first",
    )!.frame!;
    expect(module.frame!.x).toBe(movedFrame.x);
    expect(module.frame!.y).toBe(movedFrame.y);
    expect(module.frame!.width).toBeCloseTo(246, 0);
    expect(module.frame!.height).toBeCloseTo(205, 0);
    expect(entries(saved).filter((item) => item.kind === "DETAIL")).toEqual(
      originalDetails,
    );
    expect((await records(page, org)).map((item) => item.id).sort()).toEqual(
      originalRecords.map((item) => item.id).sort(),
    );
    const latestTime = await badge(page, name).getAttribute("data-axis-time");
    await page.reload();
    await expect(badge(page, name)).toHaveAttribute(
      "data-axis-time",
      latestTime!,
    );
    await expect(badge(page, name)).toHaveAttribute(
      "data-axis-priority",
      "正常安排",
    );
    await canvas(page).getByRole("link", { name, exact: true }).click();
    await expect(
      page.getByRole("heading", { name, exact: true, level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("检查工具齐全，并放在干净的托盘内。", { exact: true }),
    ).toBeVisible();
    await page.goto(path);
    await expect(timeline(page)).toBeVisible();
  });

  await test.step("dragging to either starting boundary reaches 08:00 and independent resizing preserves it after refresh", async () => {
    for (const axis of ["x", "y"] as const) {
      const dialog = await configure(page);
      await dialog
        .getByRole("combobox", { name: "时间线方向", exact: true })
        .selectOption(axis);
      const configured = nextSave(page, org);
      await dialog.getByRole("button", { name: "应用", exact: true }).click();
      expect((await configured).ok()).toBe(true);
      await expect(timeline(page)).toHaveAttribute("data-axis", axis);
      await canvas(page).scrollIntoViewIfNeeded();
      const frame = (await canvas(page).boundingBox())!;
      const grip = (await page
        .getByRole("button", { name: `拖动工作 ${name}`, exact: true })
        .boundingBox())!;
      const from = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(
        axis === "x" ? frame.x - 80 : from.x,
        axis === "y" ? frame.y - 80 : from.y,
        { steps: 16 },
      );
      await expect(tile(page, name)).toHaveClass(/is-dragging/);
      await expect(badge(page, name)).toHaveAttribute(
        "data-axis-time",
        "08:00",
      );
      const moved = nextSave(page, org);
      await page.mouse.up();
      expect((await moved).ok()).toBe(true);
      const beforeResize = entries(await workflow(page, org, original.id)).find(
        (item) => item.id === "axis-first",
      )!;
      expect(beforeResize.frame![axis]).toBe(0);

      const resize = (await page
        .getByRole("button", { name: `调整 ${name} 的大小`, exact: true })
        .boundingBox())!;
      const origin = {
        x: resize.x + resize.width / 2,
        y: resize.y + resize.height / 2,
      };
      await page.mouse.move(origin.x, origin.y);
      await page.mouse.down();
      await page.mouse.move(
        origin.x + (axis === "x" ? frame.width * 0.04 : 0),
        origin.y + (axis === "y" ? frame.height * 0.04 : 0),
        { steps: 12 },
      );
      await expect(tile(page, name)).toHaveClass(/is-resizing/);
      await expect(badge(page, name)).toHaveAttribute(
        "data-axis-time",
        "08:00",
      );
      const resized = nextSave(page, org);
      await page.mouse.up();
      expect((await resized).ok()).toBe(true);
      const saved = await workflow(page, org, original.id);
      const module = entries(saved).find((item) => item.id === "axis-first")!;
      expect(module.frame!.x).toBe(beforeResize.frame!.x);
      expect(module.frame!.y).toBe(beforeResize.frame!.y);
      const dimension = axis === "x" ? "width" : "height";
      expect(module.frame![dimension]).toBeGreaterThan(
        beforeResize.frame![dimension],
      );
      expect(entries(saved).filter((item) => item.kind === "DETAIL")).toEqual(
        originalDetails,
      );
      expect((await records(page, org)).map((item) => item.id).sort()).toEqual(
        originalRecords.map((item) => item.id).sort(),
      );
      await page.reload();
      await expect(badge(page, name)).toHaveAttribute(
        "data-axis-time",
        "08:00",
      );
      await expect(badge(page, name)).toHaveAttribute(
        "data-axis-priority",
        axis === "x" ? "可以稍后" : "优先做",
      );
      await screenshot(page, `axes-time-start-${axis}-desktop`);
    }
  });

  await test.step("phone settings fit the screen and existing editors autosave axis changes", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const phone = await configure(page);
    await screenshot(page, "axes-settings-mobile");
    await phone.getByRole("button", { name: "取消", exact: true }).click();
    await page.goto(`${path}/edit`);
    await waitForAutoSave(page);
    const editor = await configure(page);
    await editor.getByLabel("开始时间", { exact: true }).fill("22:00");
    await editor.getByLabel("结束时间", { exact: true }).fill("06:00");
    await editor
      .getByRole("combobox", { name: "时间线方向", exact: true })
      .selectOption("x");
    await editor.getByRole("button", { name: "应用", exact: true }).click();
    await waitForAutoSave(page);
    expect(settings(await workflow(page, org, original.id))!.timeline).toEqual({
      enabled: true,
      startMinute: 1320,
      endMinute: 360,
      axis: "x",
      focus: null,
      segments: null,
    });
    await page.reload();
    await waitForAutoSave(page);
    await expect(timeline(page)).toContainText("22:00");
    await expect(timeline(page)).toContainText("06:00");
    await expect(timeline(page)).toHaveAttribute("data-axis", "x");
    await expect(priority(page)).toHaveAttribute("data-axis", "y");
    await expect(badge(page, name)).toHaveAttribute("data-axis-time", "22:00");
    await expect(badge(page, "收好工具")).toHaveAttribute(
      "data-axis-time",
      "次日 04:48",
    );
    await screenshot(page, "axes-directions-editor-mobile");
    const disable = await configure(page);
    await disable.getByLabel("显示时间线", { exact: true }).uncheck();
    await disable.getByRole("button", { name: "应用", exact: true }).click();
    await waitForAutoSave(page);
    await expect(timeline(page)).toHaveCount(0);
    await expect(priority(page)).toBeVisible();
    const single = await configure(page);
    await single
      .getByRole("combobox", { name: "优先级方向", exact: true })
      .selectOption("x");
    await single.getByRole("button", { name: "应用", exact: true }).click();
    await waitForAutoSave(page);
    await page.reload();
    await waitForAutoSave(page);
    await expect(timeline(page)).toHaveCount(0);
    await expect(priority(page)).toBeVisible();
    await expect(priority(page)).toHaveAttribute("data-axis", "x");
    await screenshot(page, "axes-single-priority-mobile");
    const saved = await workflow(page, org, original.id);
    expect(settings(saved)!.timeline.enabled).toBe(false);
    expect(settings(saved)!.priority.enabled).toBe(true);
    expect(settings(saved)!.priority.axis).toBe("x");
    expect(entries(saved).filter((item) => item.kind === "DETAIL")).toEqual(
      originalDetails,
    );
    expect((await records(page, org)).map((item) => item.id).sort()).toEqual(
      originalRecords.map((item) => item.id).sort(),
    );
  });

  await test.step("new editor settings remain local until explicit creation and survive the first save", async () => {
    const countBefore = (await workflows(page, org)).length;
    await page.goto("/workflows/new");
    await page
      .getByLabel("流程名称", { exact: true })
      .fill("带时间和优先级的新流程");
    const draft = await configure(page);
    await draft.getByLabel("显示时间线", { exact: true }).check();
    await draft.getByLabel("显示优先级", { exact: true }).check();
    await draft.getByLabel("开始时间", { exact: true }).fill("07:30");
    await draft.getByLabel("结束时间", { exact: true }).fill("19:30");
    await draft
      .getByRole("combobox", { name: "时间线方向", exact: true })
      .selectOption("y");
    const before = savedRequests.length;
    await draft.getByRole("button", { name: "应用", exact: true }).click();
    await expect(timeline(page)).toBeVisible();
    await expect(priority(page)).toBeVisible();
    await expect(timeline(page)).toHaveAttribute("data-axis", "y");
    await expect(priority(page)).toHaveAttribute("data-axis", "x");
    await screenshot(page, "axes-directions-new-mobile");
    expect(savedRequests).toHaveLength(before);
    expect(await workflows(page, org)).toHaveLength(countBefore);
    await page.getByRole("button", { name: "添加流程", exact: true }).click();
    await expect(page).toHaveURL(/\/workflows\/[a-f0-9-]{36}$/);
    await expect(timeline(page)).toBeVisible();
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(settings(await workflow(page, org, id))).toMatchObject({
      version: 1,
      timeline: { enabled: true, startMinute: 450, endMinute: 1170, axis: "y" },
      priority: { enabled: true, axis: "x" },
    });
    await page.reload();
    await expect(timeline(page)).toContainText("07:30");
    await expect(priority(page)).toBeVisible();
    await expect(timeline(page)).toHaveAttribute("data-axis", "y");
    await expect(priority(page)).toHaveAttribute("data-axis", "x");
    const single = await configure(page);
    await single.getByLabel("显示优先级", { exact: true }).uncheck();
    const singleSaved = nextSave(page, org);
    await single.getByRole("button", { name: "应用", exact: true }).click();
    expect((await singleSaved).ok()).toBe(true);
    await expect(timeline(page)).toHaveAttribute("data-axis", "y");
    await expect(priority(page)).toHaveCount(0);
    await page.reload();
    await expect(timeline(page)).toHaveAttribute("data-axis", "y");
    await expect(priority(page)).toHaveCount(0);
    await screenshot(page, "axes-single-time-mobile");
    await expectNoGlobalNavigation(page);
  });
  expect(errors).toEqual([]);
});
