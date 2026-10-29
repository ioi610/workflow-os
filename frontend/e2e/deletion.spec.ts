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
type WorkRecord = {
  id: string;
  workflowId: string;
  moduleId: string;
  name: string;
};
type StoredStep = {
  kind: string;
  id: string;
  title: string;
  nextModuleIds?: string[];
};

async function workflows(page: Page, org: string): Promise<SavedWorkflow[]> {
  const response = await page.request.get(`/api/orgs/${org}/sops`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function records(page: Page, org: string): Promise<WorkRecord[]> {
  const response = await page.request.get(`/api/orgs/${org}/work-items`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function seed(
  page: Page,
  org: string,
  title: string,
  names: string[],
): Promise<SavedWorkflow> {
  const csrf = await (await page.request.get("/api/csrf")).json();
  const response = await page.request.post(`/api/orgs/${org}/sops/save`, {
    headers: { [csrf.headerName]: csrf.token },
    data: {
      title,
      category: "删除验证",
      steps: [
        ...names.map((name, index) => ({
          kind: "MODULE",
          id: `module-${index}`,
          title: name,
          position: { x: index * 0.28, y: index * 0.2 },
          nextModuleIds:
            index < names.length - 1 ? [`module-${index + 1}`] : [],
        })),
        ...names.map((name, index) => ({
          kind: "DETAIL",
          id: `detail-${index}`,
          title: name,
          items: [
            { id: `item-${index}`, text: `${name}的手写具体做法需要保留。` },
          ],
          materials: `${name}的原有材料说明`,
          safetyNotice: `${name}的原有注意事项`,
        })),
      ],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function screenshot(page: Page, name: string) {
  await expectNoGlobalNavigation(page);
  const toast = page.getByRole("button", { name: "关闭提示", exact: true });
  if (
    !(await page.getByRole("dialog").isVisible()) &&
    (await toast.isVisible())
  )
    await toast.click();
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: `../docs/screenshots/${name}.png`,
    fullPage: true,
  });
}

test("small delete buttons cancel safely and remove templates or linked processes without losing other methods", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  expect(baseURL).toBe("http://127.0.0.1:5174");
  const errors: string[] = [];
  const deletes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "DELETE") deletes.push(request.url());
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/");
  await expectWorkflowHome(page);
  const org = await createHandbookViaApi(page, `删除按钮验证-${Date.now()}`);
  const names = ["保留准备工作", "移除中间工作", "保留收尾做法"];
  const keep = await seed(page, org, "保留的工作模板", names);
  const discard = await seed(page, org, "需要删除的模板", [
    "可删除工作一",
    "可删除工作二",
  ]);
  const initialRecords = await records(page, org);
  expect(initialRecords).toHaveLength(5);
  const middle = initialRecords.find(
    (record) => record.workflowId === keep.id && record.moduleId === "module-1",
  )!;
  const originalDetails = (JSON.parse(keep.draft) as StoredStep[]).filter(
    (entry) => entry.kind === "DETAIL",
  );
  await page.reload();
  const table = page
    .getByRole("region", { name: "工作清单", exact: true })
    .getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(6);
  const discardedCard = page.locator(
    `article.workflow-card[data-workflow-id="${discard.id}"]`,
  );
  const templateDelete = discardedCard.getByRole("button", {
    name: `删除流程 ${discard.title}`,
    exact: true,
  });
  await expect(templateDelete).toBeVisible();
  await expect(templateDelete.locator("svg")).toBeVisible();
  await expect(templateDelete).toHaveText("");
  await expect(table.getByRole("button", { name: /^删除工作 / })).toHaveCount(
    5,
  );
  await screenshot(page, "deletion-controls-desktop");

  await test.step("a card delete opens its own dialog, cancelling preserves the template and confirming stays on the homepage", async () => {
    await templateDelete.click();
    await expect(page).toHaveURL("http://127.0.0.1:5174/");
    const dialog = page.getByRole("dialog", {
      name: "删除流程",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(discardedCard).toBeVisible();
    expect(deletes).toHaveLength(0);
    expect(await records(page, org)).toHaveLength(5);
    await templateDelete.click();
    const deleted = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes(`/sops/${discard.id}`),
    );
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    expect((await deleted).ok()).toBe(true);
    await expect(dialog).not.toBeVisible();
    await expect(discardedCard).toHaveCount(0);
    await expect(page).toHaveURL("http://127.0.0.1:5174/");
    await expect(table.getByRole("row")).toHaveCount(4);
    expect((await workflows(page, org)).map((workflow) => workflow.id)).toEqual(
      [keep.id],
    );
    expect(
      (await records(page, org)).every(
        (record) => record.workflowId === keep.id,
      ),
    ).toBe(true);
    await page.reload();
    await expect(discardedCard).toHaveCount(0);
    await expect(table.getByRole("row")).toHaveCount(4);
    expect(deletes).toHaveLength(1);
  });

  await test.step("module trash buttons are visible without hover and each module retains its method link", async () => {
    await page.goto(`/workflows/${keep.id}`);
    const canvas = page.locator(".flow-board-canvas");
    await expect(canvas.locator("path[data-source][data-target]")).toHaveCount(
      2,
    );
    await page.mouse.move(0, 0);
    for (const name of names) {
      const button = page.getByRole("button", {
        name: `删除工作 ${name}`,
        exact: true,
      });
      await expect(button).toBeVisible();
      await expect(button.locator("svg")).toBeVisible();
      expect(
        await button.evaluate((element) => getComputedStyle(element).opacity),
      ).toBe("1");
    }
    await screenshot(page, "module-delete-controls");
  });

  await test.step("deleting a mobile process removes its module and connected arrows, while cancel and saved methods remain safe", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const row = table
      .getByRole("row")
      .filter({ has: page.getByTitle(middle.id, { exact: true }) });
    const processDelete = row.getByRole("button", {
      name: `删除工作 ${middle.name}`,
      exact: true,
    });
    await expect(processDelete).toBeVisible();
    await processDelete.click();
    const dialog = page.getByRole("dialog", {
      name: "删除工作",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(row).toHaveCount(1);
    expect(await records(page, org)).toHaveLength(3);
    await processDelete.click();
    await screenshot(page, "deletion-confirm-mobile");
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/orgs/${org}/sops/save`),
    );
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(dialog).not.toBeVisible();
    await expect(row).toHaveCount(0);
    await expect(table.getByRole("row")).toHaveCount(3);
    const after = (await workflows(page, org)).find(
      (workflow) => workflow.id === keep.id,
    )!;
    const steps = JSON.parse(after.draft) as StoredStep[];
    expect(
      steps.filter((entry) => entry.kind === "MODULE").map((entry) => entry.id),
    ).toEqual(["module-0", "module-2"]);
    expect(
      steps
        .filter((entry) => entry.kind === "MODULE")
        .every((entry) => !entry.nextModuleIds?.length),
    ).toBe(true);
    expect(steps.filter((entry) => entry.kind === "DETAIL")).toEqual(
      originalDetails,
    );
    const remaining = await records(page, org);
    expect(remaining).toHaveLength(2);
    expect(remaining.some((record) => record.id === middle.id)).toBe(false);
    expect(remaining.map((record) => record.id).sort()).toEqual(
      initialRecords
        .filter(
          (record) => record.workflowId === keep.id && record.id !== middle.id,
        )
        .map((record) => record.id)
        .sort(),
    );
    await page.reload();
    await expect(table.getByRole("row")).toHaveCount(3);
    await screenshot(page, "deletion-controls-mobile");
    await page.goto(
      `/workflows/${keep.id}/steps?name=${encodeURIComponent(middle.name)}`,
    );
    await expect(
      page
        .getByRole("list", { name: `${middle.name}的具体步骤`, exact: true })
        .locator("li p"),
    ).toHaveText([`${middle.name}的手写具体做法需要保留。`]);
    await page.goto(`/workflows/${keep.id}`);
    await expect(
      page.locator(".flow-board-canvas path[data-source][data-target]"),
    ).toHaveCount(0);
    const savedAgain = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/orgs/${org}/sops/save`),
    );
    await page
      .getByRole("button", { name: `删除工作 ${names[2]}`, exact: true })
      .click();
    expect((await savedAgain).ok()).toBe(true);
    await expect(page.locator(".flow-board-canvas .flow-tile")).toHaveCount(1);
    expect(await records(page, org)).toHaveLength(1);
    expect(
      (
        JSON.parse(
          (await workflows(page, org)).find(
            (workflow) => workflow.id === keep.id,
          )!.draft,
        ) as StoredStep[]
      ).filter((entry) => entry.kind === "DETAIL"),
    ).toEqual(originalDetails);
  });
  expect(errors).toEqual([]);
});
