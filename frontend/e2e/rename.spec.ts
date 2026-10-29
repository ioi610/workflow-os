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
type Step = {
  kind: string;
  id: string;
  title: string;
  frame?: { x: number; y: number; width: number; height: number };
  nextModuleIds?: string[];
  connectionPorts?: unknown;
  detailWorkflowId?: string;
  detailName?: string;
  [key: string]: unknown;
};
const board = (page: Page) =>
  page.getByRole("region", { name: "流程图", exact: true });
const steps = (saved: SavedWorkflow) => JSON.parse(saved.draft) as Step[];
const moduleState = (saved: SavedWorkflow) =>
  steps(saved)
    .filter((item) => item.kind === "MODULE")
    .map(({ id, frame, nextModuleIds, connectionPorts }) => ({
      id,
      frame,
      nextModuleIds,
      connectionPorts,
    }));
async function workflows(page: Page, org: string): Promise<SavedWorkflow[]> {
  const response = await page.request.get(`/api/orgs/${org}/sops`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function workflow(page: Page, org: string, id: string) {
  return (await workflows(page, org)).find((item) => item.id === id)!;
}
async function saveViaApi(
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
async function records(
  page: Page,
  org: string,
): Promise<
  { id: string; moduleId: string; name: string; workflowId: string }[]
> {
  const response = await page.request.get(`/api/orgs/${org}/work-items`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
const nextSave = (page: Page, org: string) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${org}/sops/save`),
  );
async function openRename(page: Page, name: string) {
  await board(page)
    .getByRole("button", { name: `给 ${name} 改名`, exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "工作改名", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("工作名称", { exact: true })).toHaveValue(
    name,
  );
  return dialog;
}
async function rename(
  page: Page,
  org: string,
  from: string,
  to: string,
  editor = false,
) {
  const dialog = await openRename(page, from);
  await dialog.getByLabel("工作名称", { exact: true }).fill(to);
  const saved = nextSave(page, org);
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(dialog).toHaveCount(0);
  if (editor) await waitForAutoSave(page);
  await expect(
    board(page).getByRole("link", { name: to, exact: true }),
  ).toBeVisible();
}
async function screenshot(page: Page, name: string) {
  await expectNoGlobalNavigation(page);
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: `../docs/screenshots/${name}.png`,
    fullPage: true,
  });
}

test("work renaming preserves records, geometry, connections and local or shared instructions", async ({
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
  const org = await createHandbookViaApi(page, `工作改名验证-${Date.now()}`);
  const localName = "准备工作",
    renamed = "准备工具",
    sharedName = "共享检查";
  const localDetail = {
    kind: "DETAIL",
    id: "rename-detail",
    title: localName,
    items: [{ id: "rename-item", text: "把所需工具集中放在干净托盘内。" }],
    materials: "干净托盘、工具",
    safetyNotice: "尖锐部分朝内。",
    videoUrl: "https://example.com/rename",
  };
  const shared = await saveViaApi(page, org, {
    title: "共享做法来源",
    category: "改名验证",
    steps: [
      {
        kind: "DETAIL",
        id: "shared-detail",
        title: sharedName,
        items: [{ id: "shared-item", text: "按原来的共享检查清单逐项确认。" }],
        materials: "共享参考资料",
      },
    ],
  });
  const original = await saveViaApi(page, org, {
    title: "可以给工作改名的流程",
    category: "改名验证",
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
        id: "rename-first",
        title: localName,
        frame: { x: 50, y: 50, width: 200, height: 150 },
        nextModuleIds: ["rename-second"],
        connectionPorts: {
          "rename-second": { source: "bottom", target: "left" },
        },
      },
      {
        kind: "MODULE",
        id: "rename-second",
        title: "收好工具",
        frame: { x: 350, y: 200, width: 180, height: 140 },
      },
      {
        kind: "MODULE",
        id: "rename-shared",
        title: sharedName,
        frame: { x: 700, y: 100, width: 200, height: 160 },
        detailWorkflowId: shared.id,
      },
      localDetail,
    ],
  });
  const path = `/workflows/${original.id}`;
  const originalRecords = (await records(page, org)).filter(
    (item) => item.workflowId === original.id,
  );
  await page.goto(path);
  await expect(board(page)).toBeVisible();

  await test.step("cancel, Escape, same names, empty names and duplicates do not save", async () => {
    const before = saves.length;
    const cancelled = await openRename(page, localName);
    await cancelled
      .getByLabel("工作名称", { exact: true })
      .fill("取消的工作名称");
    await cancelled.getByRole("button", { name: "取消", exact: true }).click();
    const escaped = await openRename(page, localName);
    await escaped.getByLabel("工作名称", { exact: true }).fill("不保存的名称");
    await page.keyboard.press("Escape");
    await expect(escaped).toHaveCount(0);
    const same = await openRename(page, localName);
    await same.getByLabel("工作名称", { exact: true }).fill(` ${localName} `);
    await same.getByRole("button", { name: "确定", exact: true }).click();
    await expect(same).toHaveCount(0);
    const invalid = await openRename(page, localName);
    for (const name of ["   ", "收好工具"]) {
      await invalid.getByLabel("工作名称", { exact: true }).fill(name);
      await invalid.getByRole("button", { name: "确定", exact: true }).click();
      await expect(invalid).toBeVisible();
      await expect(invalid.getByRole("alert")).toBeVisible();
    }
    await invalid.getByRole("button", { name: "取消", exact: true }).click();
    expect(saves).toHaveLength(before);
    expect((await workflow(page, org, original.id)).revision).toBe(
      original.revision,
    );
  });

  await test.step("reader renaming updates the work list and paired method while retaining IDs and saved geometry", async () => {
    const dialog = await openRename(page, localName);
    await dialog.getByLabel("工作名称", { exact: true }).fill(renamed);
    await screenshot(page, "rename-dialog-desktop");
    const saved = nextSave(page, org);
    await dialog.getByRole("button", { name: "确定", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(dialog).toHaveCount(0);
    await expect(
      board(page).getByRole("link", { name: renamed, exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      board(page).getByRole("link", { name: renamed, exact: true }),
    ).toBeVisible();
    const changed = await workflow(page, org, original.id);
    expect(moduleState(changed)).toEqual(moduleState(original));
    expect(JSON.parse(changed.boardSettings!)).toEqual(
      JSON.parse(original.boardSettings!),
    );
    expect(steps(changed).find((item) => item.id === localDetail.id)).toEqual({
      ...localDetail,
      title: renamed,
    });
    const changedRecords = (await records(page, org)).filter(
      (item) => item.workflowId === original.id,
    );
    expect(
      changedRecords
        .map(({ id, moduleId }) => ({ id, moduleId }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(
      originalRecords
        .map(({ id, moduleId }) => ({ id, moduleId }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(
      changedRecords.find((item) => item.moduleId === "rename-first")!.name,
    ).toBe(renamed);
    await board(page).getByRole("link", { name: renamed, exact: true }).click();
    await expect(
      page.getByText("把所需工具集中放在干净托盘内。", { exact: true }),
    ).toBeVisible();
    await page.goto("/");
    await expectWorkflowHome(page);
    const list = page.getByRole("region", { name: "工作清单", exact: true });
    await list
      .getByRole("searchbox", { name: "搜索工作", exact: true })
      .fill(renamed);
    const row = list.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: renamed, exact: true }),
    });
    await expect(row).toHaveCount(1);
    await expect(
      row.getByTitle(
        originalRecords.find((item) => item.moduleId === "rename-first")!.id,
        { exact: true },
      ),
    ).toBeVisible();
    await row.getByRole("link", { name: "在流程里查看", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${original.id}`));
    await expect(
      board(page).getByRole("link", { name: renamed, exact: true }),
    ).toBeVisible();
  });

  await test.step("renaming a shared method reference keeps the source untouched and still opens its original content", async () => {
    await rename(page, org, sharedName, "检查设备");
    const changed = await workflow(page, org, original.id);
    expect(
      steps(changed).find((item) => item.id === "rename-shared"),
    ).toMatchObject({
      title: "检查设备",
      detailWorkflowId: shared.id,
      detailName: sharedName,
    });
    expect(moduleState(changed)).toEqual(moduleState(original));
    const source = await workflow(page, org, shared.id);
    expect(source.draft).toBe(shared.draft);
    expect(source.revision).toBe(shared.revision);
    await page.reload();
    await board(page)
      .getByRole("link", { name: "检查设备", exact: true })
      .click();
    await expect(
      page.getByText("按原来的共享检查清单逐项确认。", { exact: true }),
    ).toBeVisible();
    await page.goto(path);
  });

  await test.step("existing editors autosave renames and phone controls stay independently reachable", async () => {
    // Canvas tools remain in the full workflow editor; single-method editing is covered separately.
    await page.goto(`${path}/edit`);
    await waitForAutoSave(page);
    await rename(page, org, renamed, "准备所需工具", true);
    await page.reload();
    await waitForAutoSave(page);
    await page.getByRole("tab", { name: "安排工作", exact: true }).click();
    await expect(
      board(page).getByRole("link", { name: "准备所需工具", exact: true }),
    ).toBeVisible();
    const changed = await workflow(page, org, original.id);
    expect(moduleState(changed)).toEqual(moduleState(original));
    const details = steps(changed).filter((item) => item.kind === "DETAIL");
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ ...localDetail, title: "准备所需工具" });
    await page.goto(path);
    await page.setViewportSize({ width: 390, height: 844 });
    const tile = board(page).locator(
      '.flow-tile[data-module-id="rename-first"]',
    );
    await tile.scrollIntoViewIfNeeded();
    const pencil = tile.getByRole("button", {
      name: "给 准备所需工具 改名",
      exact: true,
    });
    for (const button of [
      pencil,
      ...(await tile.locator("button[data-side]").all()),
    ]) {
      expect(
        await button.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          );
          return hit === element || element.contains(hit);
        }),
      ).toBe(true);
    }
    const dialog = await openRename(page, "准备所需工具");
    await screenshot(page, "rename-dialog-mobile");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await screenshot(page, "rename-work-mobile");
  });

  await test.step("new editor renaming stays local until explicit creation", async () => {
    await page.goto("/workflows/new");
    await page
      .getByLabel("流程名称", { exact: true })
      .fill("先改工作名再创建的流程");
    const count = saves.length;
    await board(page)
      .getByRole("button", { name: "添加工作", exact: true })
      .click();
    const add = page.getByRole("dialog", { name: "添加工作", exact: true });
    await add.getByLabel("工作名称", { exact: true }).fill("新建时的工作");
    await add
      .getByRole("button", { name: "添加到流程图", exact: true })
      .click();
    const dialog = await openRename(page, "新建时的工作");
    await dialog
      .getByLabel("工作名称", { exact: true })
      .fill("创建前改好的名称");
    await dialog.getByRole("button", { name: "确定", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      board(page).getByRole("link", { name: "创建前改好的名称", exact: true }),
    ).toBeVisible();
    await board(page)
      .getByRole("button", { name: "添加工作", exact: true })
      .click();
    const reuse = page.getByRole("dialog", { name: "添加工作", exact: true });
    await reuse
      .getByRole("tab", { name: "从工作清单选择", exact: true })
      .click();
    await reuse
      .getByRole("searchbox", { name: "搜索可选工作", exact: true })
      .fill("检查设备");
    await reuse
      .locator(".module-picker-options")
      .getByRole("button", { name: /检查设备/ })
      .click();
    await reuse
      .getByRole("button", { name: "添加到流程图", exact: true })
      .click();
    await expect(reuse).toHaveCount(0);
    expect(saves).toHaveLength(count);
    const saved = nextSave(page, org);
    await page.getByRole("button", { name: "添加流程", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(page).toHaveURL(/\/workflows\/[a-f0-9-]{36}$/);
    await page.reload();
    await expect(
      board(page).getByRole("link", { name: "创建前改好的名称", exact: true }),
    ).toBeVisible();
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(
      steps(await workflow(page, org, id)).find(
        (item) => item.title === "检查设备",
      ),
    ).toMatchObject({ detailWorkflowId: shared.id, detailName: sharedName });
    await board(page)
      .getByRole("link", { name: "检查设备", exact: true })
      .click();
    await expect(
      page.getByText("按原来的共享检查清单逐项确认。", { exact: true }),
    ).toBeVisible();
  });
  expect(errors).toEqual([]);
});
