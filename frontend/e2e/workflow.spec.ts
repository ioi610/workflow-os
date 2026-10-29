import { test, expect, type Page } from "@playwright/test";
import { finishWorkflowEditing } from "./editor";
import {
  createHandbookViaApi,
  expectNoGlobalNavigation,
  expectWorkflowHome,
} from "./handbook";

const noAccountControls =
  /^(我的账号|退出登录|邮箱|密码|创建账号|第一次使用？创建账号)$/;

async function isPersonalMode(page: Page) {
  const response = await page.request.get("/api/mode");
  expect(response.ok()).toBe(true);
  return (await response.json()).personalMode === true;
}

async function expectNoAccountControls(page: Page) {
  await expect(page.getByRole("link", { name: noAccountControls })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: noAccountControls }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: noAccountControls }),
  ).toHaveCount(0);
  await expect(page.getByLabel(/邮箱|密码/)).toHaveCount(0);
}

const removedControls =
  /今日工作|今日任务|未完成|待完成|已完成|需要关注|工作记录|工作交接|管理工作台|业务参数|生成当天计划|完成任务|仪表盘/;

async function expectHandbookOnly(page: Page) {
  await expectNoGlobalNavigation(page);
  await expect(
    page.getByRole("link", { name: /手册设置|我的账户/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: /手册设置|我的账户/ }),
  ).toHaveCount(0);
  if (await isPersonalMode(page)) await expectNoAccountControls(page);
  await expect(page.getByRole("link", { name: removedControls })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: removedControls })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: removedControls }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/^(今日任务|未完成|待完成|已完成|需要关注)$/),
  ).toHaveCount(0);
  await expect(page.getByLabel("工作日期", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("工作地点", { exact: true })).toHaveCount(0);
}

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

async function createHandbook(page: Page, suffix: string) {
  await page.goto("/");
  const handbookName = `端到端测试手册-${suffix}-${Date.now()}`;
  if (await isPersonalMode(page)) {
    // Each scenario owns its own handbook, even though personal mode shares an identity.
    await expectWorkflowHome(page);
    await expectNoAccountControls(page);
    await createHandbookViaApi(page, handbookName);
  } else {
    await page
      .getByRole("button", { name: "第一次使用？创建账号", exact: true })
      .click();
    await page.getByLabel("你的姓名", { exact: true }).fill("林晓");
    await page
      .getByLabel("邮箱", { exact: true })
      .fill(`modules-${suffix}-${Date.now()}@example.com`);
    await page.getByLabel("密码", { exact: false }).fill("WorkflowTest123!");
    await page.getByRole("button", { name: "创建账号", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "先给这里起个名字", exact: true }),
    ).toBeVisible();
    await page.getByLabel("名称", { exact: true }).fill(handbookName);
    await page.getByRole("button", { name: "开始使用", exact: true }).click();
  }
  await expectWorkflowHome(page);
  await expectHandbookOnly(page);
  return handbookName;
}

async function newWorkflow(page: Page, title: string, category = "门店操作") {
  await page.goto("/workflows/new");
  await expect(
    page.getByRole("heading", { name: "添加流程", exact: true }),
  ).toBeVisible();
  await page.getByLabel("流程名称", { exact: true }).fill(title);
  await page.getByLabel("分类", { exact: true }).fill(category);
}

const moduleBoard = (page: Page) =>
  page.getByRole("region", { name: "各项工作", exact: true });

async function addModule(page: Page, name: string) {
  await page.getByRole("button", { name: "添加工作", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加工作", exact: true });
  await dialog.getByLabel("工作名称", { exact: true }).fill(name);
  await dialog
    .getByRole("button", { name: "添加到流程图", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
}

async function moveModuleFreely(page: Page, name: string) {
  const handle = page.getByRole("button", {
    name: `拖动工作 ${name}`,
    exact: true,
  });
  const tile = handle
    .locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' flow-tile ')]",
    )
    .first();
  const before = await tile.boundingBox();
  expect(before).toBeTruthy();
  await handle.focus();
  await page.keyboard.press("Space", { delay: 80 });
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight", { delay: 80 });
  await page.keyboard.press("ArrowDown", { delay: 80 });
  await expect
    .poll(async () => {
      const after = await tile.boundingBox();
      return after!.x - before!.x;
    })
    .toBeGreaterThan(15);
  await page.keyboard.press("Space", { delay: 80 });
  await expect(handle).not.toHaveAttribute("aria-pressed", "true");
}
const detailEditor = (page: Page, index: number) =>
  page.getByRole("region", { name: `具体做法 ${index}`, exact: true });

async function addDetail(
  page: Page,
  index: number,
  name: string,
  texts: string[],
) {
  await page.getByRole("button", { name: "添加一份做法", exact: true }).click();
  const detail = detailEditor(page, index);
  await detail.getByLabel("对应的工作名称", { exact: true }).fill(name);
  for (let i = 0; i < texts.length; i++) {
    if (i)
      await detail
        .getByRole("button", { name: "添加步骤", exact: true })
        .click();
    await detail
      .getByRole("textbox", { name: `步骤 ${i + 1}`, exact: true })
      .fill(texts[i]);
  }
  return detail;
}

async function saveWorkflow(page: Page) {
  return finishWorkflowEditing(page);
}

async function expectList(page: Page, name: string, texts: string[]) {
  await expect(
    page.getByRole("heading", { name, exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("list", { name: `${name}的具体步骤`, exact: true })
      .locator("li p"),
  ).toHaveText(texts);
}

async function screenshot(page: Page, name: string) {
  await expectNoGlobalNavigation(page);
  const toast = page.getByRole("button", { name: "关闭提示", exact: true });
  if (await toast.isVisible()) await toast.click();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: `../docs/screenshots/${name}.png`,
    fullPage: true,
  });
}

test("module boxes open separate handwritten lists, persist edits and work on mobile", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  const locationRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/\/api\/orgs\/[^/]+\/locations(?:\?|$)/.test(request.url()))
      locationRequests.push(request.url());
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  const handbookName = await createHandbook(page, "lists");
  await page.goto("/me");
  await expect(page).toHaveURL(/\/$/);
  await expectWorkflowHome(page);
  await expectHandbookOnly(page);
  const title = "开店准备流程";
  const cleaning = "清洁操作台";
  const supplies = "核对原料与工具";
  const prepare = "用温水浸湿干净抹布，准备一块干布。";
  const wipe = "从内到外擦拭操作台，再用干布擦干。";
  const revisedWipe = "从内到外擦拭操作台，迎光检查边角，再用干布擦干。";
  const inspect = "收好抹布，把操作台上的工具摆回原位。";
  const suppliesList = [
    "对照清单查看原料包装和保质期。",
    "把量具和收纳盒放在操作台右侧。",
  ];
  let overviewUrl = "";
  let cleaningUrl = "";

  await test.step("write modules, move one freely, then author each independent list", async () => {
    await newWorkflow(page, title);
    await expect(moduleBoard(page).getByRole("link")).toHaveCount(0);
    await addModule(page, cleaning);
    await addModule(page, supplies);
    await moveModuleFreely(page, supplies);
    await expect(moduleBoard(page).getByRole("link")).toHaveText([
      cleaning,
      supplies,
    ]);
    await addModule(page, "临时模块");
    await page
      .getByRole("button", { name: "删除工作 临时模块", exact: true })
      .click();
    await expect(moduleBoard(page).getByRole("link")).toHaveText([
      cleaning,
      supplies,
    ]);
    await page.getByRole("tab", { name: "写具体做法", exact: true }).click();
    const first = await addDetail(page, 1, cleaning, [wipe, prepare]);
    await first
      .getByRole("button", { name: "上移步骤 2", exact: true })
      .click();
    await expect(
      first.getByRole("textbox", { name: "步骤 1", exact: true }),
    ).toHaveValue(prepare);
    await first.getByRole("button", { name: "添加步骤", exact: true }).click();
    await first
      .getByRole("textbox", { name: "步骤 3", exact: true })
      .fill("删除这条临时说明。");
    await first
      .getByRole("button", { name: "删除步骤 3", exact: true })
      .click();
    await first
      .getByLabel("需要准备", { exact: false })
      .fill("干净抹布、温水、干布");
    await first
      .getByLabel("注意事项", { exact: false })
      .fill("清洁布与食品接触用布分开放置。");
    await first.getByText("添加参考图片或视频", { exact: false }).click();
    await first
      .getByLabel("参考图片", { exact: true })
      .setInputFiles("public/icon-192.png");
    await expect(
      first.getByRole("img", { name: `${cleaning}的参考图片`, exact: true }),
    ).toBeVisible();
    await first
      .getByLabel("操作视频链接", { exact: true })
      .fill("https://example.com/operations/worktop");
    await addDetail(page, 2, supplies, suppliesList);
    await page.getByRole("tab", { name: "安排工作", exact: true }).click();
    await expect(moduleBoard(page).getByRole("link")).toHaveText([
      cleaning,
      supplies,
    ]);
    overviewUrl = await saveWorkflow(page);
  });

  await test.step("module overview shows link boxes and opens only the correctly named list", async () => {
    const modules = page.getByRole("region", { name: "各项工作", exact: true });
    await expect(modules.getByRole("link")).toHaveText([cleaning, supplies]);
    await expect(page.getByRole("list")).toHaveCount(0);
    await expect(page.getByText(prepare, { exact: true })).toHaveCount(0);
    await expect(page.getByText(suppliesList[0], { exact: true })).toHaveCount(
      0,
    );
    await expectNoOverflow(page);
    await screenshot(page, "modules-desktop");
    await modules.getByRole("link", { name: cleaning, exact: true }).click();
    cleaningUrl = page.url();
    expect(new URL(cleaningUrl).searchParams.get("name")).toBe(cleaning);
    await expectList(page, cleaning, [prepare, wipe]);
    await expect(page.getByText(suppliesList[0], { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByText("干净抹布、温水、干布", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("清洁布与食品接触用布分开放置。", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "观看操作视频", exact: true }),
    ).toHaveAttribute("href", "https://example.com/operations/worktop");
    const image = page.getByRole("img", {
      name: `${cleaning}的操作参考图`,
      exact: true,
    });
    await expect
      .poll(() =>
        image.evaluate(
          (element: HTMLImageElement) =>
            element.complete && element.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await page.reload();
    await expectList(page, cleaning, [prepare, wipe]);
    await screenshot(page, "module-detail-desktop");
    await expect(
      page.getByRole("navigation", { name: "其他工作", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: /返回流程$/ }).click();
    await moduleBoard(page)
      .getByRole("link", { name: supplies, exact: true })
      .click();
    await expectList(page, supplies, suppliesList);
    await expect(page.getByText(prepare, { exact: true })).toHaveCount(0);
    await expectHandbookOnly(page);
  });

  await test.step("edit a list on mobile, save it and reopen its direct link", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(cleaningUrl);
    await page.getByRole("link", { name: "修改具体做法", exact: true }).click();
    await expect(
      page.getByRole("region", { name: /^具体做法 \d+$/ }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("tab", { name: "写具体做法", exact: true }),
    ).toHaveCount(0);
    const first = detailEditor(page, 1);
    await expect(
      first.getByRole("textbox", { name: "步骤 2", exact: true }),
    ).toHaveValue(wipe);
    await first
      .getByRole("textbox", { name: "步骤 2", exact: true })
      .fill(revisedWipe);
    await first.getByRole("button", { name: "添加步骤", exact: true }).click();
    await first
      .getByRole("textbox", { name: "步骤 3", exact: true })
      .fill(inspect);
    await expectNoOverflow(page);
    await screenshot(page, "module-editor-mobile");
    if (await isPersonalMode(page)) {
      // Simulate expiry after authoring, so saving must recover without losing typed work.
      const csrf = await (await page.request.get("/api/csrf")).json();
      const logout = await page.request.post("/api/auth/logout", {
        headers: { [csrf.headerName]: csrf.token },
        data: {},
      });
      expect(logout.ok()).toBe(true);
      await expect(
        first.getByRole("textbox", { name: "步骤 2", exact: true }),
      ).toHaveValue(revisedWipe);
    }
    await saveWorkflow(page);
    await expectNoOverflow(page);
    await screenshot(page, "modules-mobile");
    await page
      .getByRole("region", { name: "各项工作", exact: true })
      .getByRole("link", { name: cleaning, exact: true })
      .click();
    await expectList(page, cleaning, [prepare, revisedWipe, inspect]);
    await expectNoOverflow(page);
    await screenshot(page, "module-detail-mobile");
    await page.goto(cleaningUrl);
    await expectList(page, cleaning, [prepare, revisedWipe, inspect]);
    await page.reload();
    await expectList(page, cleaning, [prepare, revisedWipe, inspect]);
  });

  await test.step("filter categories with only process search and keep removed task pages absent", async () => {
    await newWorkflow(page, "行政资料流程", "行政工作");
    await addModule(page, "整理会议文件");
    await saveWorkflow(page);
    await page.goto("/");
    await page.getByRole("button", { name: "门店操作", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "行政资料流程", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "行政工作", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "行政资料流程", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "全部流程", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "搜索工作流程", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("searchbox")).toHaveCount(1);
    await expect(page.locator('input[type="search"]')).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "行政资料流程", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "工作清单", exact: true }),
    ).toBeVisible();
    for (const path of ["/admin", "/records", "/handover", "/sops", "/me"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/$/);
      await expectHandbookOnly(page);
    }
    await page.goto(overviewUrl);
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expectNoOverflow(page);
  });
  if (await isPersonalMode(page)) {
    await test.step("a fresh browser session opens without login and keeps the same personal library", async () => {
      const originalResponse = await page.request.get("/api/auth/me");
      expect(originalResponse.ok()).toBe(true);
      const originalIdentity = await originalResponse.json();
      const freshContext = await browser.newContext({
        baseURL: new URL(overviewUrl).origin,
      });
      try {
        const freshPage = await freshContext.newPage();
        // No cookies or localStorage are carried over from the authoring browser.
        await freshPage.goto(new URL("/workflows/new", overviewUrl).href);
        await expect(
          freshPage.getByRole("heading", {
            name: "添加流程",
            exact: true,
          }),
        ).toBeVisible();
        await expectNoAccountControls(freshPage);
        const freshResponse = await freshPage.request.get("/api/auth/me");
        expect(freshResponse.ok()).toBe(true);
        const freshIdentity = await freshResponse.json();
        expect(freshIdentity.user.id).toBe(originalIdentity.user.id);
        await freshPage.goto(new URL("/", overviewUrl).href);
        await expectNoAccountControls(freshPage);
        await freshPage
          .getByRole("combobox", { name: "切换工作内容", exact: true })
          .selectOption({ label: handbookName });
        await expectWorkflowHome(freshPage);
        await expect(
          freshPage.getByRole("heading", { name: title, exact: true }),
        ).toBeVisible();
        await freshPage.goto(cleaningUrl);
        await expectList(freshPage, cleaning, [prepare, revisedWipe, inspect]);
        await expectHandbookOnly(freshPage);
      } finally {
        await freshContext.close();
      }
    });
  }
  expect(locationRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("name matching is exact, duplicate names are blocked and missing links can be authored", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await createHandbook(page, "names");
  await newWorkflow(page, "名称匹配流程");
  let saves = 0;
  page.on("request", (request) => {
    if (/\/sops\/save$/.test(request.url())) saves++;
  });
  await addModule(page, " CAFÉ ");
  await page.getByRole("button", { name: "添加工作", exact: true }).click();
  const duplicateDialog = page.getByRole("dialog", {
    name: "添加工作",
    exact: true,
  });
  await duplicateDialog
    .getByLabel("工作名称", { exact: true })
    .fill("CAFE\u0301");
  await duplicateDialog
    .getByRole("button", { name: "添加到流程图", exact: true })
    .click();
  await expect(duplicateDialog.getByRole("alert")).toContainText("请换个名称");
  expect(saves).toBe(0);
  await page.keyboard.press("Escape");
  await addModule(page, "核对原料");
  await page.getByRole("tab", { name: "写具体做法", exact: true }).click();
  await addDetail(page, 1, "CAFE\u0301", ["按配方称量咖啡豆。"]);
  const second = await addDetail(page, 2, " CAFÉ ", [
    "查看包装标注的原料保质期。",
  ]);
  await page
    .getByRole("button", { name: "添加流程", exact: true })
    .first()
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "已经有做法叫“CAFÉ”了，请换个名称",
  );
  expect(saves).toBe(0);
  await second
    .getByLabel("对应的工作名称", { exact: true })
    .fill("核对原料包装");
  await addDetail(page, 3, "补充资料", [
    "把供应商联系方式记录在这份独立说明中。",
  ]);
  const overviewUrl = await saveWorkflow(page);
  const modules = () =>
    page.getByRole("region", { name: "各项工作", exact: true });
  await expect(modules().getByRole("link")).toHaveText(["CAFÉ", "核对原料"]);
  await modules().getByRole("link", { name: "CAFÉ", exact: true }).click();
  await expectList(page, "CAFÉ", ["按配方称量咖啡豆。"]);
  const instructionsPath = new URL(page.url()).pathname;
  await page.goto(
    `${instructionsPath}?name=${encodeURIComponent(" CAFE\u0301 ")}`,
  );
  await expectList(page, "CAFÉ", ["按配方称量咖啡豆。"]);
  await page.goto(`${instructionsPath}?name=${encodeURIComponent("café")}`);
  await expect(page).toHaveURL(/\/edit\?/);
  await expect(
    page.getByRole("region", { name: /^具体做法 \d+$/ }),
  ).toHaveCount(1);
  await expect(
    page.getByText("按配方称量咖啡豆。", { exact: true }),
  ).toHaveCount(0);
  await page.goto(overviewUrl);
  await modules().getByRole("link", { name: "核对原料", exact: true }).click();
  await expect(page).toHaveURL(/\/edit\?/);
  await expect(
    page.getByRole("region", { name: /^具体做法 \d+$/ }),
  ).toHaveCount(1);
  await expect(
    page.getByText("查看包装标注的原料保质期。", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "写具体做法", exact: true }),
  ).toHaveCount(0);

  await test.step("renaming the detail repairs its link and a standalone detail keeps its own list", async () => {
    await page.goto(overviewUrl);
    await expect(
      page.getByRole("link", { name: "修改流程和做法", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "查看做法列表", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "做法列表", exact: true })
      .getByRole("link", { name: "核对原料包装", exact: true })
      .click();
    await page.getByRole("link", { name: "修改具体做法", exact: true }).click();
    await expect(page.locator("main.workflow-editor h1")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: /^具体做法 \d+$/ }),
    ).toHaveCount(1);
    await detailEditor(page, 2)
      .getByLabel("对应的工作名称", { exact: true })
      .fill("核对原料");
    await saveWorkflow(page);
    await modules()
      .getByRole("link", { name: "核对原料", exact: true })
      .click();
    await expectList(page, "核对原料", ["查看包装标注的原料保质期。"]);
    await page.reload();
    await expectList(page, "核对原料", ["查看包装标注的原料保质期。"]);
    await page.goto(overviewUrl);
    await page
      .getByRole("button", { name: "查看做法列表", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "做法列表", exact: true })
      .getByRole("link", { name: "补充资料", exact: true })
      .click();
    await expectList(page, "补充资料", [
      "把供应商联系方式记录在这份独立说明中。",
    ]);
    await expect(
      page.getByText("按配方称量咖啡豆。", { exact: true }),
    ).toHaveCount(0);
  });

  await test.step("a unique same-name list in the handbook links automatically, with local details taking precedence", async () => {
    await newWorkflow(page, "另一份独立流程");
    await addModule(page, "CAFÉ");
    const linkedOverview = await saveWorkflow(page);
    await modules().getByRole("link", { name: "CAFÉ", exact: true }).click();
    await expectList(page, "CAFÉ", ["按配方称量咖啡豆。"]);
    await page.goto(
      `${linkedOverview}/edit?detail=${encodeURIComponent("CAFÉ")}`,
    );
    await expect(
      detailEditor(page, 1).getByLabel("对应的工作名称", { exact: true }),
    ).toHaveValue("CAFÉ");
    await detailEditor(page, 1)
      .getByRole("textbox", { name: "步骤 1", exact: true })
      .fill("这份流程只记录清洗咖啡杯的操作。");
    await saveWorkflow(page);
    await modules().getByRole("link", { name: "CAFÉ", exact: true }).click();
    await expectList(page, "CAFÉ", ["这份流程只记录清洗咖啡杯的操作。"]);
  });

  await test.step("a workflow can save only standalone detail documents", async () => {
    await newWorkflow(page, "独立说明资料库");
    await page.getByRole("tab", { name: "写具体做法", exact: true }).click();
    await addDetail(page, 1, "工具使用说明", ["使用后擦干工具并放回收纳盒。"]);
    await saveWorkflow(page);
    await expect(modules().getByRole("link")).toHaveCount(0);
    await page
      .getByRole("button", { name: "查看做法列表", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "做法列表", exact: true })
      .getByRole("link", { name: "工具使用说明", exact: true })
      .click();
    await expectList(page, "工具使用说明", ["使用后擦干工具并放回收纳盒。"]);
    await page.reload();
    await expectList(page, "工具使用说明", ["使用后擦干工具并放回收纳盒。"]);
  });
  await expectHandbookOnly(page);
});
