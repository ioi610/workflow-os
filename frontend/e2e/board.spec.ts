import { expect, test, type Page } from "@playwright/test";
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

async function createIsolatedHandbook(page: Page) {
  // This scenario writes fixtures only to the dedicated personal-mode test instance.
  await page.goto("/");
  expect(new URL(page.url()).origin).toBe("http://127.0.0.1:5174");
  const mode = await (await page.request.get("/api/mode")).json();
  expect(mode.personalMode).toBe(true);
  await expectWorkflowHome(page);
  await expect(page.getByLabel(/邮箱|密码/)).toHaveCount(0);
  return createHandbookViaApi(page, `流程板验证手册-${Date.now()}`);
}

async function seedWorkflow(
  page: Page,
  org: string,
  title: string,
  category: string,
  names: string[],
): Promise<SavedWorkflow> {
  const csrf = await (await page.request.get("/api/csrf")).json();
  const response = await page.request.post(`/api/orgs/${org}/sops/save`, {
    headers: { [csrf.headerName]: csrf.token },
    data: {
      title,
      category,
      steps: [
        ...names.map((name, index) => ({
          id: `${category}-module-${index}`,
          kind: "MODULE",
          title: name,
        })),
        ...names.map((name, index) => ({
          id: `${category}-detail-${index}`,
          kind: "DETAIL",
          title: name,
          items: [
            {
              id: `item-${index}-1`,
              text: `${title}：先准备${name}所需的材料。`,
            },
            {
              id: `item-${index}-2`,
              text: `${title}：按照自己的方法进行${name}。`,
            },
          ],
        })),
      ],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
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

test("the unified homepage lists workflows and persisted process records with process search and keeps row actions working", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  expect(baseURL).toBe("http://127.0.0.1:5174");
  const errors: string[] = [];
  const recordMutations: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "PUT" && /\/work-items\//.test(request.url()))
      recordMutations.push(request.url());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const org = await createIsolatedHandbook(page);
  const names = [
    "清洁操作台",
    "核对原料",
    "准备工具",
    "整理包装",
    "检查设备",
    "记录方法",
  ];
  const primary = await seedWorkflow(
    page,
    org,
    "开店准备流程",
    "门店操作",
    names,
  );
  const secondary = await seedWorkflow(page, org, "采购资料流程", "行政工作", [
    "核对原料",
    "整理采购资料",
  ]);
  const loaded = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/orgs/${org}/work-items`) &&
      response.request().method() === "GET",
  );
  await page.goto("/manager");
  await expect(page).toHaveURL("http://127.0.0.1:5174/");
  const response = await loaded;
  expect(response.ok()).toBe(true);
  const records = await response.json();
  expect(records).toHaveLength(8);
  expect(new Set(records.map((record: { id: string }) => record.id)).size).toBe(
    8,
  );
  expect(
    records.every(
      (record: { moduleId: string; workflowId: string }) =>
        record.moduleId &&
        [primary.id, secondary.id].includes(record.workflowId),
    ),
  ).toBe(true);

  await expectNoGlobalNavigation(page);
  await expect(
    page.getByRole("link", { name: "工作管理器", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('input[type="search"]')).toHaveCount(1);
  await expect(
    page.getByRole("textbox", { name: "搜索工作流程", exact: true }),
  ).toHaveCount(0);
  await expectWorkflowHome(page);
  await expect(
    page.getByRole("heading", { name: "工作清单", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".workflow-card")).toHaveCount(2);
  await expect(page.locator("#work-processes")).toHaveAttribute(
    "aria-label",
    "工作清单",
  );
  const libraryBox = await page
    .getByRole("region", { name: "工作流程列表", exact: true })
    .boundingBox();
  const recordsBox = await page.locator("#work-processes").boundingBox();
  expect(libraryBox).toBeTruthy();
  expect(recordsBox).toBeTruthy();
  expect(recordsBox!.y).toBeGreaterThanOrEqual(
    libraryBox!.y + libraryBox!.height,
  );
  const table = page
    .getByRole("region", { name: "工作清单", exact: true })
    .getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(9);
  await expect(table.getByRole("columnheader")).toHaveText([
    "工作名称",
    "编号",
    "所属流程",
    "具体做法",
    "操作",
  ]);
  await expect(page.locator("textarea")).toHaveCount(0);
  await expect(page.getByText(/备注/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /保存备注/ })).toHaveCount(0);
  await expect(
    table.getByRole("link", { name: "核对原料", exact: true }),
  ).toHaveCount(2);
  for (const name of names)
    await expect(
      table.getByRole("link", { name, exact: true }).first(),
    ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "工作记录详情", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("选中的工作记录", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    table.getByRole("link", { name: "在流程里查看", exact: true }),
  ).toHaveCount(8);
  for (const record of records) {
    const row = table
      .getByRole("row")
      .filter({ has: page.getByTitle(record.id, { exact: true }) });
    await expect(
      row.getByRole("link", { name: "在流程里查看", exact: true }),
    ).toHaveAttribute(
      "href",
      `/workflows/${record.workflowId}?module=${encodeURIComponent(record.moduleId)}`,
    );
  }
  const firstRow = table
    .getByRole("row")
    .filter({ has: page.getByTitle(records[0].id, { exact: true }) });
  await firstRow
    .getByRole("link", { name: "在流程里查看", exact: true })
    .click();
  await expect(page).toHaveURL(
    `http://127.0.0.1:5174/workflows/${records[0].workflowId}?module=${encodeURIComponent(records[0].moduleId)}`,
  );
  await expect(
    page.locator(`[data-module-id="${records[0].moduleId}"]`),
  ).toHaveClass(/is-focused/);
  await page.goto("/");
  await expect(table.getByRole("row")).toHaveCount(9);
  await expectNoOverflow(page);
  await screenshot(page, "work-manager-desktop");
  await page.setViewportSize({ width: 1100, height: 1000 });
  await expectNoGlobalNavigation(page);
  await page.setViewportSize({ width: 800, height: 1000 });
  await expect(table.getByRole("row")).toHaveCount(9);
  await screenshot(page, "work-manager-tablet");
  await page.setViewportSize({ width: 1440, height: 1000 });

  await expect(page.getByRole("searchbox")).toHaveCount(1);
  const search = page
    .getByRole("region", { name: "工作清单", exact: true })
    .getByRole("searchbox", { name: "搜索工作", exact: true });
  const templateFilter = page.getByRole("combobox", {
    name: "选择流程",
    exact: true,
  });
  await expect(search).toBeVisible();
  await search.fill("  核对原料  ");
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(
    table.getByRole("link", { name: "核对原料", exact: true }),
  ).toHaveCount(2);
  await expect(page.locator(".workflow-card")).toHaveCount(2);
  await search.fill("采购资料");
  await expect(table.getByRole("row")).toHaveCount(3);
  await search.fill(records[0].id.slice(0, 8).toUpperCase());
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(
    table.getByRole("link", { name: records[0].name, exact: true }),
  ).toHaveCount(1);
  await search.fill("核对原料");
  await templateFilter.selectOption(secondary.id);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(
    table.getByRole("row").filter({ hasText: secondary.title }),
  ).toHaveCount(1);
  await search.fill("没有这项工作-测试");
  await expect(
    page.getByRole("heading", { name: "没有找到这项工作", exact: true }),
  ).toBeVisible();
  await expect(table).toHaveCount(0);
  await expect(page.locator(".workflow-card")).toHaveCount(2);
  await page.getByRole("button", { name: "显示全部工作", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(templateFilter).toHaveValue("");
  await expect(table.getByRole("row")).toHaveCount(9);
  await templateFilter.selectOption(primary.id);
  await expect(table.getByRole("row")).toHaveCount(7);
  await expect(
    table.getByRole("link", { name: "整理采购资料", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "选择流程", exact: true })
    .selectOption("");
  const secondaryRow = table
    .getByRole("row")
    .filter({
      has: page.getByRole("link", { name: "核对原料", exact: true }),
    })
    .filter({ hasText: secondary.title });
  await expect(
    secondaryRow.getByRole("link", { name: "查看做法", exact: true }),
  ).toHaveAttribute(
    "href",
    `/workflows/${secondary.id}/steps?name=${encodeURIComponent("核对原料")}`,
  );
  await secondaryRow
    .getByRole("link", { name: "核对原料", exact: true })
    .click();
  expect(new URL(page.url()).pathname).toBe(`/workflows/${secondary.id}/steps`);
  await expect(
    page
      .getByRole("list", { name: "核对原料的具体步骤", exact: true })
      .locator("li p"),
  ).toHaveText([
    `${secondary.title}：先准备核对原料所需的材料。`,
    `${secondary.title}：按照自己的方法进行核对原料。`,
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(table.getByRole("row")).toHaveCount(9);
  await expect(table.getByRole("columnheader")).toHaveText([
    "工作名称",
    "编号",
    "所属流程",
    "具体做法",
    "操作",
  ]);
  await expect(page.locator("textarea")).toHaveCount(0);
  await expect(page.getByText(/备注/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /保存备注/ })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "工作记录详情", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("选中的工作记录", { exact: true })).toHaveCount(
    0,
  );
  const mobileRow = table
    .getByRole("row")
    .filter({ has: page.getByTitle(records[0].id, { exact: true }) });
  const mobileLocate = mobileRow.getByRole("link", {
    name: "在流程里查看",
    exact: true,
  });
  await expect(mobileLocate).toHaveAttribute(
    "href",
    `/workflows/${records[0].workflowId}?module=${encodeURIComponent(records[0].moduleId)}`,
  );
  await mobileLocate.scrollIntoViewIfNeeded();
  await mobileLocate.click();
  await expect(
    page.locator(`[data-module-id="${records[0].moduleId}"]`),
  ).toHaveClass(/is-focused/);
  await page.goto("/");
  await expect(table.getByRole("row")).toHaveCount(9);
  await expectNoOverflow(page);
  await expectWorkflowHome(page);
  await expect(page.locator(".workflow-card")).toHaveCount(2);
  await expect(page.getByRole("searchbox")).toHaveCount(1);
  await expect(page.locator('input[type="search"]')).toHaveCount(1);
  await expect(search).toBeVisible();
  await search.fill("准备工具");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expectNoOverflow(page);
  await search.fill("");
  await expect(table.getByRole("row")).toHaveCount(9);
  await screenshot(page, "work-manager-mobile");
  await expect(
    page.getByText(/^(今日任务|未完成|待完成|已完成|需要关注)$/),
  ).toHaveCount(0);
  await expect(page.getByLabel(/邮箱|密码/)).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(recordMutations).toEqual([]);
});
