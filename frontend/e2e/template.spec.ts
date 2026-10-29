import { expect, test, type Page } from "@playwright/test";
import { finishWorkflowEditing } from "./editor";
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
};

async function createHandbook(page: Page) {
  await page.goto("/");
  expect(new URL(page.url()).origin).toBe("http://127.0.0.1:5174");
  await expectWorkflowHome(page);
  return createHandbookViaApi(page, `工作模板验证-${Date.now()}`);
}

async function seedWorkflow(
  page: Page,
  org: string,
  title: string,
  names: string[],
  includeDetails = true,
  moduleTargetId?: string,
): Promise<SavedWorkflow> {
  const csrf = await (await page.request.get("/api/csrf")).json();
  const result = await page.request.post(`/api/orgs/${org}/sops/save`, {
    headers: { [csrf.headerName]: csrf.token },
    data: {
      title,
      category: "做法资料",
      steps: [
        ...names.map((name, index) => ({
          kind: "MODULE",
          id: `module-${index}`,
          title: name,
          ...(moduleTargetId ? { detailWorkflowId: moduleTargetId } : {}),
        })),
        ...(includeDetails
          ? names.map((name, index) => ({
              kind: "DETAIL",
              id: `detail-${index}`,
              title: name,
              items: [
                {
                  id: `item-${index}`,
                  text: `${title}：${name}的手写具体做法。`,
                },
              ],
            }))
          : []),
      ],
    },
  });
  expect(result.ok(), await result.text()).toBe(true);
  return result.json();
}

async function readWorkflow(
  page: Page,
  org: string,
  id: string,
): Promise<SavedWorkflow> {
  const response = await page.request.get(`/api/orgs/${org}/sops`);
  expect(response.ok()).toBe(true);
  return (await response.json()).find(
    (record: SavedWorkflow) => record.id === id,
  );
}

const board = (page: Page) =>
  page.getByRole("region", { name: "流程图", exact: true });
const modules = (page: Page) =>
  board(page).getByRole("region", { name: "各项工作", exact: true });

async function expectFifthModule(page: Page) {
  const canvas = await board(page).locator(".flow-board-canvas").boundingBox();
  const cell = await board(page).locator(".flow-add-cell").boundingBox();
  expect(canvas).toBeTruthy();
  expect(cell).toBeTruthy();
  expect(Math.abs(canvas!.width - canvas!.height)).toBeLessThanOrEqual(2);
  expect(Math.abs(cell!.width * 5 - canvas!.width)).toBeLessThanOrEqual(3);
  expect(Math.abs(cell!.height * 5 - canvas!.height)).toBeLessThanOrEqual(3);
  await expect(board(page).locator(".flow-board-grid")).toHaveCount(0);
}

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

async function expectWorkflowCreateTile(page: Page) {
  const library = page.getByRole("region", {
    name: "工作流程列表",
    exact: true,
  });
  const add = library.getByRole("link", { name: "添加流程", exact: true });
  await expect(
    page.getByRole("link", { name: "添加流程", exact: true }),
  ).toHaveCount(1);
  await expect(add).toBeVisible();
  await expect(add).toHaveClass(/workflow-create-tile/);
  await expect(add).toHaveAttribute("href", "/workflows/new");
  await expect(add).toHaveText("添加流程");
  await expect(add).not.toHaveAttribute("title", /./);
  await expect(add.locator("svg")).toBeVisible();
  const box = await add.boundingBox();
  const content = await add.locator(".workflow-create-content").boundingBox();
  expect(box).toBeTruthy();
  expect(content).toBeTruthy();
  expect(Math.abs(box!.width - box!.height)).toBeLessThanOrEqual(2);
  expect(
    Math.abs(content!.x + content!.width / 2 - box!.x - box!.width / 2),
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(content!.y + content!.height / 2 - box!.y - box!.height / 2),
  ).toBeLessThanOrEqual(2);
  await expect(
    page.locator(
      ".handbook-intro, .sidebar .tip, .sidebar .workspace small, footer",
    ),
  ).toHaveCount(0);
  await expect(
    page.getByText("A PLACE FOR EVERY HOW-TO", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("把工作整理成模块，点击模块查看同名的步骤列表。", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.locator('input[type="search"]')).toHaveCount(1);
  await expect(
    page
      .getByRole("region", { name: "工作清单", exact: true })
      .getByRole("searchbox", { name: "搜索工作", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "搜索工作流程", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "工作清单", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#work-processes")).toHaveAttribute(
    "aria-label",
    "工作清单",
  );
  await expectNoGlobalNavigation(page);
  await expectNoOverflow(page);
  return add;
}

async function screenshot(page: Page, name: string) {
  await expectNoGlobalNavigation(page);
  const close = page.getByRole("button", { name: "关闭提示", exact: true });
  if (
    !(await page.getByRole("dialog").isVisible()) &&
    (await close.isVisible())
  )
    await close.click();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: `../docs/screenshots/${name}.png`,
    fullPage: true,
  });
}

function nextSave(page: Page, org: string) {
  return page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/orgs/${org}/sops/save`) &&
      response.request().method() === "POST",
  );
}

async function openAdd(page: Page) {
  await board(page)
    .getByRole("button", { name: "添加工作", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "添加工作", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("a blank free canvas accepts named or selected work and preserves exact detail sources", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  expect(baseURL).toBe("http://127.0.0.1:5174");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1100 });
  const org = await createHandbook(page);
  await test.step("empty library exposes a single centered plus tile on desktop and phone", async () => {
    await expectWorkflowCreateTile(page);
    await expect(page.locator(".workflow-card")).toHaveCount(0);
    await screenshot(page, "workflow-library-empty-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await expectWorkflowCreateTile(page);
    await screenshot(page, "workflow-library-empty-mobile");
    await page.setViewportSize({ width: 1440, height: 1100 });
  });
  const source = await seedWorkflow(page, org, "标准做法库", [
    "清洁工作台",
    "检查包装",
  ]);
  const other = await seedWorkflow(page, org, "另一份包装做法", ["检查包装"]);
  expect(other.id).not.toBe(source.id);

  await test.step("one homepage contains workflow cards, the process table and a plus tile with only process search", async () => {
    await page.reload();
    await expectWorkflowCreateTile(page);
    await expect(page.locator(".workflow-card")).toHaveCount(2);
    await expect(
      page
        .getByRole("region", { name: "工作清单", exact: true })
        .getByRole("table")
        .getByRole("row"),
    ).toHaveCount(4);
    await screenshot(page, "workflow-library-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".workflow-card")).toHaveCount(2);
    const add = await expectWorkflowCreateTile(page);
    await screenshot(page, "workflow-library-mobile");
    await add.click();
    await expect(page).toHaveURL(/\/workflows\/new$/);
    await expect(page.getByLabel("流程名称", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1100 });
  });

  await test.step("create an ungridded square template with a plus block one fifth on each side", async () => {
    await page.getByLabel("流程名称", { exact: true }).fill("我的完整工作流程");
    await page.getByLabel("分类", { exact: true }).fill("手动组合");
    await expect(modules(page).getByRole("link")).toHaveCount(0);
    await expectFifthModule(page);
    await expectNoOverflow(page);
    await screenshot(page, "template-empty-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await expectFifthModule(page);
    await expectNoOverflow(page);
    await screenshot(page, "template-empty-mobile");
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page
      .getByRole("button", { name: "添加流程", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/workflows\/[a-f0-9-]{36}$/);
    await expect(modules(page).getByRole("link")).toHaveCount(0);
    await expectFifthModule(page);
  });
  const workflowId = new URL(page.url()).pathname.split("/").at(-1)!;
  const workflowPath = `/workflows/${workflowId}`;

  await test.step("typing a name automatically finds its unique matching work list", async () => {
    const dialog = await openAdd(page);
    await expect(
      dialog.getByRole("tab", { name: "添加新工作", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await dialog.getByLabel("工作名称", { exact: true }).fill(" 清洁工作台 ");
    await screenshot(page, "template-dialog-desktop");
    const saved = nextSave(page, org);
    await dialog
      .getByRole("button", { name: "添加到流程图", exact: true })
      .click();
    expect((await saved).ok()).toBe(true);
    await expect(dialog).toHaveCount(0);
    const link = modules(page).getByRole("link", {
      name: "清洁工作台",
      exact: true,
    });
    const href = new URL((await link.getAttribute("href"))!, page.url());
    expect(href.pathname).toBe(`/workflows/${source.id}/steps`);
    expect(href.searchParams.get("name")).toBe("清洁工作台");
    expect(href.searchParams.get("from")).toBe(workflowId);
    await link.click();
    await expect(
      page
        .getByRole("list", { name: "清洁工作台的具体步骤", exact: true })
        .locator("li p"),
    ).toHaveText(["标准做法库：清洁工作台的手写具体做法。"]);
    await page.goto(workflowPath);
    await expect(modules(page).getByRole("link")).toHaveText(["清洁工作台"]);
  });

  await test.step("choosing an existing row pins the right list even when another workflow uses the same name", async () => {
    const dialog = await openAdd(page);
    await dialog.getByLabel("工作名称", { exact: true }).fill("检查包装");
    await expect(dialog.getByRole("status")).toContainText(
      "有几份名称相同的做法",
    );
    await expect(
      dialog.getByRole("button", { name: "添加到流程图", exact: true }),
    ).toBeDisabled();
    await dialog
      .getByRole("tab", { name: "从工作清单选择", exact: true })
      .click();
    const choice = dialog
      .getByRole("button")
      .filter({ hasText: "检查包装" })
      .filter({ hasText: source.title });
    await expect(choice).toHaveCount(1);
    await choice.click();
    const saved = nextSave(page, org);
    await dialog
      .getByRole("button", { name: "添加到流程图", exact: true })
      .click();
    expect((await saved).ok()).toBe(true);
    await expect(modules(page).getByRole("link")).toHaveText([
      "清洁工作台",
      "检查包装",
    ]);
    const record = await readWorkflow(page, org, workflowId);
    const stored = JSON.parse(record.draft).find(
      (entry: { kind: string; title: string }) =>
        entry.kind === "MODULE" && entry.title === "检查包装",
    );
    expect(stored.detailWorkflowId).toBe(source.id);
    await page.reload();
    await modules(page)
      .getByRole("link", { name: "检查包装", exact: true })
      .click();
    expect(new URL(page.url()).pathname).toBe(`/workflows/${source.id}/steps`);
    await expect(
      page
        .getByRole("list", { name: "检查包装的具体步骤", exact: true })
        .locator("li p"),
    ).toHaveText(["标准做法库：检查包装的手写具体做法。"]);
    await page.goto(workflowPath);
  });

  await test.step("the homepage process list opens the selected detail source", async () => {
    await page.goto("/");
    const row = page
      .getByRole("row")
      .filter({ hasText: "检查包装" })
      .filter({ hasText: "我的完整工作流程" });
    await expect(row).toHaveCount(1);
    await row.getByRole("link", { name: "查看做法", exact: true }).click();
    expect(new URL(page.url()).pathname).toBe(`/workflows/${source.id}/steps`);
  });

  await test.step("mobile keeps an ungridded template and an accessible add dialog", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(workflowPath);
    await expectFifthModule(page);
    await expectNoOverflow(page);
    await screenshot(page, "template-built-mobile");
    const dialog = await openAdd(page);
    await dialog.getByLabel("工作名称", { exact: true }).fill("收尾整理");
    await expectNoOverflow(page);
    await screenshot(page, "template-dialog-mobile");
    const saved = nextSave(page, org);
    await dialog
      .getByRole("button", { name: "添加到流程图", exact: true })
      .click();
    expect((await saved).ok()).toBe(true);
    await expect(modules(page).getByRole("link")).toHaveText([
      "清洁工作台",
      "检查包装",
      "收尾整理",
    ]);
    await page.reload();
    await expect(modules(page).getByRole("link")).toHaveText([
      "清洁工作台",
      "检查包装",
      "收尾整理",
    ]);
    await expectNoOverflow(page);
    await expect(page.getByLabel(/邮箱|密码/)).toHaveCount(0);
    await expect(
      page.getByText(/^(今日任务|未完成|待完成|已完成|需要关注)$/),
    ).toHaveCount(0);
  });
  await test.step("selecting work without a list authors its original source and immediately repairs every linked template", async () => {
    const moduleOnly = await seedWorkflow(
      page,
      org,
      "待补充工作库",
      ["归档收尾"],
      false,
    );
    await page.goto(workflowPath);
    const dialog = await openAdd(page);
    await dialog
      .getByRole("tab", { name: "从工作清单选择", exact: true })
      .click();
    await dialog
      .getByRole("button")
      .filter({ hasText: "归档收尾" })
      .filter({ hasText: moduleOnly.title })
      .click();
    const saved = nextSave(page, org);
    await dialog
      .getByRole("button", { name: "添加到流程图", exact: true })
      .click();
    expect((await saved).ok()).toBe(true);
    await modules(page)
      .getByRole("link", { name: "归档收尾", exact: true })
      .click();
    await expect(page).toHaveURL(/\/edit\?/);
    const href = new URL(page.url());
    expect(href.pathname).toBe(`/workflows/${moduleOnly.id}/edit`);
    expect(href.searchParams.get("detail")).toBe("归档收尾");
    await expect(
      page.getByRole("link", { name: "写具体做法", exact: true }),
    ).toHaveCount(0);
    const detail = page.getByRole("region", {
      name: "具体做法 1",
      exact: true,
    });
    await expect(
      detail.getByLabel("对应的工作名称", { exact: true }),
    ).toHaveValue("归档收尾");
    await detail
      .getByRole("textbox", { name: "步骤 1", exact: true })
      .fill("将纸质记录编号后放进原工作库对应文件夹。");
    await finishWorkflowEditing(page);
    await expect(page).toHaveURL(new RegExp(`${workflowPath}$`));
    await page.goto(workflowPath);
    await modules(page)
      .getByRole("link", { name: "归档收尾", exact: true })
      .click();
    expect(new URL(page.url()).pathname).toBe(
      `/workflows/${moduleOnly.id}/steps`,
    );
    await expect(
      page
        .getByRole("list", { name: "归档收尾的具体步骤", exact: true })
        .locator("li p"),
    ).toHaveText(["将纸质记录编号后放进原工作库对应文件夹。"]);
    await page.reload();
    await expect(
      page
        .getByRole("list", { name: "归档收尾的具体步骤", exact: true })
        .locator("li p"),
    ).toHaveText(["将纸质记录编号后放进原工作库对应文件夹。"]);
  });
  await test.step("a detail directory remains local when the same workflow module explicitly links to another source", async () => {
    const name = "同名资料核对";
    const target = await seedWorkflow(page, org, "模块所选做法库", [name]);
    const own = await seedWorkflow(
      page,
      org,
      "目录原始做法库",
      [name],
      true,
      target.id,
    );
    await page.goto(`/workflows/${own.id}`);
    await modules(page).getByRole("link", { name, exact: true }).click();
    await expect(
      page
        .getByRole("list", { name: `${name}的具体步骤`, exact: true })
        .locator("li p"),
    ).toHaveText([`${target.title}：${name}的手写具体做法。`]);
    await page.goto(`/workflows/${own.id}`);
    await page
      .getByRole("button", { name: "查看做法列表", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "做法列表", exact: true })
      .getByRole("link", { name, exact: true })
      .click();
    expect(new URL(page.url()).pathname).toBe(`/workflows/${own.id}/steps`);
    expect(new URL(page.url()).searchParams.has("module")).toBe(false);
    await expect(
      page
        .getByRole("list", { name: `${name}的具体步骤`, exact: true })
        .locator("li p"),
    ).toHaveText([`${own.title}：${name}的手写具体做法。`]);
    await page.reload();
    await expect(
      page
        .getByRole("list", { name: `${name}的具体步骤`, exact: true })
        .locator("li p"),
    ).toHaveText([`${own.title}：${name}的手写具体做法。`]);
  });
  expect(errors).toEqual([]);
});
