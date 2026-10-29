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
  revision: number;
};
type StoredModule = {
  kind: string;
  id: string;
  title: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  frame?: { x: number; y: number; width: number; height: number };
};

// This scenario keeps its default 820px board; compare legacy ratios and new
// logical frames in the same units while the board-size scenario checks raw pixels.
const geometry = (module: StoredModule) =>
  module.frame
    ? {
        position: { x: module.frame.x / 820, y: module.frame.y / 820 },
        size: {
          width: module.frame.width / 820,
          height: module.frame.height / 820,
        },
      }
    : {
        position: module.position!,
        size: module.size ?? { width: 0.2, height: 0.2 },
      };

const board = (page: Page) =>
  page.getByRole("region", { name: "流程图", exact: true });
const canvas = (page: Page) => board(page).locator(".flow-board-canvas");
const handle = (page: Page, name: string) =>
  page.getByRole("button", { name: `拖动工作 ${name}`, exact: true });

const port = (page: Page, name: string) =>
  page.getByRole("button", { name: `从 ${name} 画箭头`, exact: true });
const tile = (page: Page, name: string) =>
  handle(page, name)
    .locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' flow-tile ')]",
    )
    .first();
const arrows = (page: Page) =>
  canvas(page).locator("path[data-source][data-target]");

async function dragArrow(
  page: Page,
  source: string,
  target?: string,
  inspectBeforeRelease?: () => Promise<void>,
) {
  await canvas(page).scrollIntoViewIfNeeded();
  const start = await port(page, source).boundingBox();
  const destination = await (
    target ? tile(page, target) : canvas(page)
  ).boundingBox();
  expect(start).toBeTruthy();
  expect(destination).toBeTruthy();
  const end = target
    ? {
        x: destination!.x + destination!.width / 2,
        y: destination!.y + destination!.height / 2,
      }
    : {
        x: destination!.x + destination!.width * 0.91,
        y: destination!.y + destination!.height * 0.87,
      };
  await page.mouse.move(
    start!.x + start!.width / 2,
    start!.y + start!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 16 });
  if (inspectBeforeRelease) await inspectBeforeRelease();
  await page.mouse.up();
}

const resizeHandle = (page: Page, name: string) =>
  page.getByRole("button", { name: `调整 ${name} 的大小`, exact: true });

async function resizeWork(
  page: Page,
  name: string,
  size: { width: number; height: number },
  inspectBeforeRelease?: () => Promise<void>,
) {
  await canvas(page).scrollIntoViewIfNeeded();
  const bounds = await canvas(page).boundingBox();
  const current = await tile(page, name).boundingBox();
  const grip = await resizeHandle(page, name).boundingBox();
  expect(bounds).toBeTruthy();
  expect(current).toBeTruthy();
  expect(grip).toBeTruthy();
  const start = { x: grip!.x + grip!.width / 2, y: grip!.y + grip!.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x + bounds!.width * size.width - current!.width,
    start.y + bounds!.height * size.height - current!.height,
    { steps: 16 },
  );
  if (inspectBeforeRelease) await inspectBeforeRelease();
  await page.mouse.up();
}

function nextSave(page: Page, org: string) {
  return page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/orgs/${org}/sops/save`) &&
      response.request().method() === "POST",
  );
}

async function records(page: Page, org: string): Promise<WorkRecord[]> {
  const response = await page.request.get(`/api/orgs/${org}/work-items`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function workflow(
  page: Page,
  org: string,
  id: string,
): Promise<SavedWorkflow> {
  const response = await page.request.get(`/api/orgs/${org}/sops`);
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(
    true,
  );
  return (await response.json()).find((item: SavedWorkflow) => item.id === id);
}

async function addModule(page: Page, org: string, name: string) {
  await board(page)
    .getByRole("button", { name: "添加工作", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "添加工作", exact: true });
  await dialog.getByLabel("工作名称", { exact: true }).fill(name);
  const saved = nextSave(page, org);
  await dialog
    .getByRole("button", { name: "添加到流程图", exact: true })
    .click();
  expect((await saved).ok()).toBe(true);
  await expect(dialog).toHaveCount(0);
  await expect(handle(page, name)).toBeEnabled();
}

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

async function screenshot(page: Page, name: string) {
  await expectNoGlobalNavigation(page);
  const toast = page.getByRole("button", { name: "关闭提示", exact: true });
  if (await toast.isVisible()) await toast.click();
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: `../docs/screenshots/${name}.png`,
    fullPage: true,
  });
}

test("free positions and arrows persist, while each module retains one durable process record without a notes editor", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  expect(baseURL).toBe("http://127.0.0.1:5174");
  const errors: string[] = [];
  const saveRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/sops/save"))
      saveRequests.push(request.url());
  });
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto("/");
  expect(new URL(page.url()).origin).toBe(baseURL);
  await expectWorkflowHome(page);
  const org = await createHandbookViaApi(
    page,
    `自由画布与独立记录-${Date.now()}`,
  );
  await page.goto("/workflows/new");
  await page.getByLabel("流程名称", { exact: true }).fill("手动连接工作模板");
  await expect(canvas(page)).toBeVisible();
  await expect(board(page).locator(".flow-board-grid")).toHaveCount(0);
  const emptyCanvas = await canvas(page).boundingBox();
  const addBox = await board(page).locator(".flow-add-cell").boundingBox();
  expect(emptyCanvas).toBeTruthy();
  expect(addBox).toBeTruthy();
  expect(
    Math.abs(emptyCanvas!.width - emptyCanvas!.height),
  ).toBeLessThanOrEqual(2);
  expect(Math.abs(addBox!.width * 5 - emptyCanvas!.width)).toBeLessThanOrEqual(
    3,
  );
  expect(
    Math.abs(addBox!.height * 5 - emptyCanvas!.height),
  ).toBeLessThanOrEqual(3);
  await screenshot(page, "free-canvas-empty-desktop");
  await page
    .getByRole("button", { name: "添加流程", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/workflows\/[a-f0-9-]{36}$/);
  const workflowId = new URL(page.url()).pathname.split("/").at(-1)!;
  const path = `/workflows/${workflowId}`;
  expect(await records(page, org)).toHaveLength(0);

  const names = ["准备材料", "加工处理", "整理收尾"];
  for (const [index, name] of names.entries()) {
    await addModule(page, org, name);
    await expect
      .poll(async () => (await records(page, org)).length)
      .toBe(index + 1);
  }
  const originalRecords = await records(page, org);
  expect(originalRecords.map((record) => record.name).sort()).toEqual(
    [...names].sort(),
  );
  expect(
    new Set(
      originalRecords.map(
        (record) => `${record.workflowId}:${record.moduleId}`,
      ),
    ).size,
  ).toBe(3);
  const firstRecord = originalRecords.find(
    (record) => record.name === names[0],
  )!;
  const secondRecord = originalRecords.find(
    (record) => record.name === names[1],
  )!;

  await test.step("drag to an arbitrary unsnapped position without changing creation order", async () => {
    const tile = handle(page, names[0])
      .locator(
        "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' flow-tile ')]",
      )
      .first();
    const tileBox = await tile.boundingBox();
    const canvasBox = await canvas(page).boundingBox();
    const grip = await handle(page, names[0]).boundingBox();
    expect(tileBox).toBeTruthy();
    expect(canvasBox).toBeTruthy();
    expect(grip).toBeTruthy();
    expect(Math.abs(tileBox!.width * 5 - canvasBox!.width)).toBeLessThanOrEqual(
      3,
    );
    expect(
      Math.abs(tileBox!.height * 5 - canvasBox!.height),
    ).toBeLessThanOrEqual(3);
    const before = await workflow(page, org, workflowId);
    const original = JSON.parse(before.draft).filter(
      (entry: StoredModule) => entry.kind === "MODULE",
    );
    const save = nextSave(page, org);
    await page.mouse.move(
      grip!.x + grip!.width / 2,
      grip!.y + grip!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      grip!.x +
        grip!.width / 2 +
        canvasBox!.x +
        canvasBox!.width * 0.317 -
        tileBox!.x,
      grip!.y +
        grip!.height / 2 +
        canvasBox!.y +
        canvasBox!.height * 0.421 -
        tileBox!.y,
      { steps: 24 },
    );
    await page.mouse.up();
    const response = await save;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON().expectedRevision).toBe(
      before.revision,
    );
    await expect(handle(page, names[0])).toBeEnabled();
    const after = await workflow(page, org, workflowId);
    const stored: StoredModule[] = JSON.parse(after.draft).filter(
      (entry: StoredModule) => entry.kind === "MODULE",
    );
    expect(stored.map((module) => module.id)).toEqual(
      original.map((module: StoredModule) => module.id),
    );
    const moved = stored.find((module) => module.id === firstRecord.moduleId)!;
    expect(moved.frame).toBeTruthy();
    expect(moved.position).toBeUndefined();
    expect(geometry(moved).position).toBeTruthy();
    expect(geometry(moved).position!.x).toBeGreaterThan(0.03);
    expect(geometry(moved).position!.y).toBeGreaterThan(0.03);
    expect(geometry(moved).position!.x).toBeCloseTo(0.317, 2);
    expect(geometry(moved).position!.y).toBeCloseTo(0.421, 2);
    // A free position must not be rounded to the old 20% cells.
    expect(
      Math.abs(
        geometry(moved).position!.x / 0.2 -
          Math.round(geometry(moved).position!.x / 0.2),
      ),
    ).toBeGreaterThan(0.04);
    await page.reload();
    const restoredCanvas = await canvas(page).boundingBox();
    const restoredTile = await handle(page, names[0])
      .locator(
        "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' flow-tile ')]",
      )
      .first()
      .boundingBox();
    expect(restoredCanvas).toBeTruthy();
    expect(restoredTile).toBeTruthy();
    expect(
      (restoredTile!.x - restoredCanvas!.x) / restoredCanvas!.width,
    ).toBeCloseTo(geometry(moved).position!.x, 2);
    expect(
      (restoredTile!.y - restoredCanvas!.y) / restoredCanvas!.height,
    ).toBeCloseTo(geometry(moved).position!.y, 2);
    expect(
      (await records(page, org)).find(
        (record) => record.moduleId === firstRecord.moduleId,
      )!.id,
    ).toBe(firstRecord.id);

    const keyboardHandle = handle(page, names[0]);
    await keyboardHandle.focus();
    const keyboardSave = nextSave(page, org);
    await page.keyboard.press("Space", { delay: 80 });
    await expect(keyboardHandle).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("ArrowRight", { delay: 80 });
    await expect
      .poll(async () => {
        const box = await keyboardHandle
          .locator(
            "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' flow-tile ')]",
          )
          .first()
          .boundingBox();
        return box!.x - restoredTile!.x;
      })
      .toBeGreaterThan(10);
    await page.keyboard.press("Space", { delay: 80 });
    expect((await keyboardSave).ok()).toBe(true);
    await expect(keyboardHandle).toBeEnabled();
    const keyboardStored: StoredModule = JSON.parse(
      (await workflow(page, org, workflowId)).draft,
    ).find((entry: StoredModule) => entry.id === firstRecord.moduleId);
    expect(geometry(keyboardStored).position!.x).toBeGreaterThan(
      geometry(moved).position!.x,
    );
    expect(geometry(keyboardStored).position!.y).toBeCloseTo(
      geometry(moved).position!.y,
      3,
    );
  });

  await test.step("draw directly from work ports, ignore invalid attempts, and retain keyboard connections after reload", async () => {
    await expect(
      board(page).getByRole("button", { name: "画箭头", exact: true }),
    ).toHaveCount(0);
    const saved = nextSave(page, org);
    await dragArrow(page, names[0], names[1], async () => {
      await expect(port(page, names[0])).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(
        canvas(page).locator('path[data-connection-preview="true"]'),
      ).toHaveAttribute("d", /^M .+ [CL] .+/);
      await expect(tile(page, names[1])).toHaveClass(/is-connection-target/);
      await page.screenshot({
        path: "../docs/screenshots/direct-arrow-preview-desktop.png",
      });
    });
    expect((await saved).ok()).toBe(true);
    await expect(arrows(page)).toHaveCount(1);
    await expect(board(page)).toHaveAttribute("aria-busy", "false");
    const unchangedRevision = (await workflow(page, org, workflowId)).revision;
    const unchangedRequests = saveRequests.length;
    await dragArrow(page, names[0], names[0]);
    await page.keyboard.press("Escape");
    await dragArrow(page, names[0]);
    await expect(port(page, names[0])).toHaveAttribute("aria-pressed", "false");
    await expect(
      canvas(page).locator('path[data-connection-preview="true"]'),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await dragArrow(page, names[0], names[1]);
    await page.keyboard.press("Escape");
    await port(page, names[0]).focus();
    await page.keyboard.press("Enter");
    await expect(
      board(page).getByRole("button", {
        name: `连接工作 ${names[1]}`,
        exact: true,
      }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      board(page).getByRole("button", {
        name: `连接工作 ${names[1]}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await port(page, names[0]).click();
    const blankCanvas = await canvas(page).boundingBox();
    expect(blankCanvas).toBeTruthy();
    await page.mouse.click(
      blankCanvas!.x + blankCanvas!.width * 0.91,
      blankCanvas!.y + blankCanvas!.height * 0.87,
    );
    await expect(
      board(page).getByRole("button", {
        name: `连接工作 ${names[1]}`,
        exact: true,
      }),
    ).toHaveCount(0);
    expect((await workflow(page, org, workflowId)).revision).toBe(
      unchangedRevision,
    );
    expect(saveRequests).toHaveLength(unchangedRequests);
    await expect(arrows(page)).toHaveCount(1);

    await port(page, names[1]).focus();
    await page.keyboard.press("Space");
    const keyboardTarget = board(page).getByRole("button", {
      name: `连接工作 ${names[2]}`,
      exact: true,
    });
    await keyboardTarget.focus();
    const connected = nextSave(page, org);
    await page.keyboard.press("Enter");
    expect((await connected).ok()).toBe(true);
    await expect(handle(page, names[0])).toBeEnabled();
    await expect(arrows(page)).toHaveCount(2);
    await page.reload();
    await expect(
      canvas(page).locator(
        `path[data-source="${firstRecord.moduleId}"][data-target="${secondRecord.moduleId}"]`,
      ),
    ).toHaveCount(1);
    await expect(arrows(page)).toHaveCount(2);
    await screenshot(page, "free-canvas-desktop");
    const removed = nextSave(page, org);
    await board(page)
      .getByRole("button", {
        name: `删除箭头 ${names[1]} 到 ${names[2]}`,
        exact: true,
      })
      .click();
    expect((await removed).ok()).toBe(true);
    await page.reload();
    await expect(arrows(page)).toHaveCount(1);
  });

  await test.step("resize a linked work into a rectangle, keep its position and methods, and cancel without saving", async () => {
    const current = await workflow(page, org, workflowId);
    const method = {
      kind: "DETAIL",
      id: "resize-preserved-method",
      title: names[0],
      items: [
        { id: "resize-method-item", text: "将所需材料集中放在台面左侧。" },
      ],
      materials: "保留的准备材料",
      safetyNotice: "保留的注意事项",
    };
    const csrf = await (await page.request.get("/api/csrf")).json();
    const seeded = await page.request.post(`/api/orgs/${org}/sops/save`, {
      headers: { [csrf.headerName]: csrf.token },
      data: {
        id: workflowId,
        title: current.title,
        category: current.category,
        expectedRevision: current.revision,
        steps: [...JSON.parse(current.draft), method],
      },
    });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    await page.reload();
    const before = await workflow(page, org, workflowId);
    const beforeModule = (JSON.parse(before.draft) as StoredModule[]).find(
      (entry) => entry.kind === "MODULE" && entry.id === firstRecord.moduleId,
    )!;
    const beforePath = await arrows(page).first().getAttribute("d");
    const saved = nextSave(page, org);
    await resizeWork(
      page,
      names[0],
      { width: 0.34, height: 0.28 },
      async () => {
        await expect(tile(page, names[0])).toHaveClass(/is-resizing/);
        const preview = await tile(page, names[0]).boundingBox();
        expect(preview).toBeTruthy();
        expect(Math.abs(preview!.width - preview!.height)).toBeGreaterThan(20);
        await expect(arrows(page).first()).not.toHaveAttribute(
          "d",
          beforePath!,
        );
        await page.screenshot({
          path: "../docs/screenshots/resize-preview-desktop.png",
        });
      },
    );
    const resizedResponse = await saved;
    expect(resizedResponse.ok()).toBe(true);
    expect(resizedResponse.request().postDataJSON().expectedRevision).toBe(
      before.revision,
    );
    await expect(board(page)).toHaveAttribute("aria-busy", "false");
    const resized = await workflow(page, org, workflowId);
    const resizedSteps = JSON.parse(resized.draft) as StoredModule[];
    let resizedModule = resizedSteps.find(
      (entry) => entry.kind === "MODULE" && entry.id === firstRecord.moduleId,
    )!;
    expect(geometry(resizedModule).position).toEqual(
      geometry(beforeModule).position,
    );
    expect(geometry(resizedModule).size!.width).toBeCloseTo(0.34, 2);
    expect(geometry(resizedModule).size!.height).toBeCloseTo(0.28, 2);
    expect(
      resizedSteps.find(
        (entry) => entry.kind === "DETAIL" && entry.id === method.id,
      ),
    ).toEqual(method);
    expect((await records(page, org)).map((entry) => entry.id).sort()).toEqual(
      originalRecords.map((entry) => entry.id).sort(),
    );
    await page.reload();
    const frame = await canvas(page).boundingBox();
    const restored = await tile(page, names[0]).boundingBox();
    expect(restored!.width / frame!.width).toBeCloseTo(0.34, 2);
    expect(restored!.height / frame!.height).toBeCloseTo(0.28, 2);
    await screenshot(page, "resized-work-desktop");
    await resizeHandle(page, names[0]).focus();
    const keyboardSizeSaved = nextSave(page, org);
    await page.keyboard.press("ArrowDown");
    expect((await keyboardSizeSaved).ok()).toBe(true);
    await expect(board(page)).toHaveAttribute("aria-busy", "false");
    const keyboardSized = (
      JSON.parse(
        (await workflow(page, org, workflowId)).draft,
      ) as StoredModule[]
    ).find(
      (entry) => entry.kind === "MODULE" && entry.id === firstRecord.moduleId,
    )!;
    expect(geometry(keyboardSized).position).toEqual(
      geometry(resizedModule).position,
    );
    expect(geometry(keyboardSized).size!.width).toEqual(
      geometry(resizedModule).size!.width,
    );
    expect(geometry(keyboardSized).size!.height).toBeGreaterThan(
      geometry(resizedModule).size!.height,
    );
    resizedModule = keyboardSized;

    const grip = await handle(page, names[0]).boundingBox();
    const moved = nextSave(page, org);
    await page.mouse.move(
      grip!.x + grip!.width / 2,
      grip!.y + grip!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      frame!.x + frame!.width + 60,
      frame!.y + frame!.height + 60,
      { steps: 20 },
    );
    await page.mouse.up();
    expect((await moved).ok()).toBe(true);
    await expect(board(page)).toHaveAttribute("aria-busy", "false");
    const afterMove = await workflow(page, org, workflowId);
    const movedModule = (JSON.parse(afterMove.draft) as StoredModule[]).find(
      (entry) => entry.kind === "MODULE" && entry.id === firstRecord.moduleId,
    )!;
    expect(geometry(movedModule).size).toEqual(geometry(resizedModule).size);
    expect(
      geometry(movedModule).position!.x + geometry(movedModule).size!.width,
    ).toBeLessThanOrEqual(1.001);
    expect(
      geometry(movedModule).position!.y + geometry(movedModule).size!.height,
    ).toBeLessThanOrEqual(1.001);
    const movedBox = await tile(page, names[0]).boundingBox();
    expect(movedBox!.x + movedBox!.width).toBeLessThanOrEqual(
      frame!.x + frame!.width + 2,
    );
    expect(movedBox!.y + movedBox!.height).toBeLessThanOrEqual(
      frame!.y + frame!.height + 2,
    );

    const unchangedRequests = saveRequests.length;
    await resizeWork(page, names[0], { width: 0, height: 0 }, async () => {
      const smallest = await tile(page, names[0]).boundingBox();
      expect(smallest!.width).toBeGreaterThanOrEqual(
        Math.min(movedBox!.width, 64) - 1,
      );
      expect(smallest!.height).toBeGreaterThanOrEqual(
        Math.min(movedBox!.height, 64) - 1,
      );
      expect(smallest!.width).toBeLessThan(movedBox!.width);
      await page.keyboard.press("Escape");
    });
    await expect
      .poll(async () =>
        Math.abs(
          (await tile(page, names[0]).boundingBox())!.width - movedBox!.width,
        ),
      )
      .toBeLessThanOrEqual(1);
    await expect
      .poll(async () =>
        Math.abs(
          (await tile(page, names[0]).boundingBox())!.height - movedBox!.height,
        ),
      )
      .toBeLessThanOrEqual(1);
    await resizeWork(page, names[0], { width: 0.5, height: 0.5 }, async () => {
      const largest = await tile(page, names[0]).boundingBox();
      expect(largest!.x + largest!.width).toBeLessThanOrEqual(
        frame!.x + frame!.width + 2,
      );
      expect(largest!.y + largest!.height).toBeLessThanOrEqual(
        frame!.y + frame!.height + 2,
      );
      await page.keyboard.press("Escape");
    });
    await expect
      .poll(async () =>
        Math.abs(
          (await tile(page, names[0]).boundingBox())!.height - movedBox!.height,
        ),
      )
      .toBeLessThanOrEqual(1);
    const canceled = await workflow(page, org, workflowId);
    expect(canceled.revision).toBe(afterMove.revision);
    expect(saveRequests).toHaveLength(unchangedRequests);
    expect(
      (JSON.parse(canceled.draft) as StoredModule[]).find(
        (entry) => entry.kind === "MODULE" && entry.id === firstRecord.moduleId,
      ),
    ).toEqual(movedModule);
    expect(
      (JSON.parse(canceled.draft) as StoredModule[]).find(
        (entry) => entry.kind === "DETAIL" && entry.id === method.id,
      ),
    ).toEqual(method);
    expect((await records(page, org)).map((entry) => entry.id).sort()).toEqual(
      originalRecords.map((entry) => entry.id).sort(),
    );
    await board(page)
      .getByRole("link", { name: names[0], exact: true })
      .click();
    await expect(
      page
        .getByRole("list", { name: `${names[0]}的具体步骤`, exact: true })
        .locator("li p"),
    ).toHaveText([method.items[0].text]);
    await page.goto(path);
    await expect(arrows(page)).toHaveCount(1);
  });

  await test.step("use row actions directly and retain record identity through a module rename", async () => {
    await page.goto("/");
    const table = page
      .getByRole("region", { name: "工作清单", exact: true })
      .getByRole("table");
    await expect(table.getByRole("row")).toHaveCount(4);
    await expect(table.getByRole("columnheader")).toHaveText([
      "工作名称",
      "编号",
      "所属流程",
      "具体做法",
      "操作",
    ]);
    const firstRow = table
      .getByRole("row")
      .filter({ has: page.getByTitle(firstRecord.id, { exact: true }) });
    await expect(firstRow.getByRole("rowheader")).toHaveText(names[0]);
    await expect(
      page.getByRole("region", { name: "工作记录详情", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("选中的工作记录", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.locator("textarea")).toHaveCount(0);
    await expect(page.getByText(/备注/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /保存备注/ })).toHaveCount(0);
    await page.reload();
    await expect(firstRow.getByRole("rowheader")).toHaveText(names[0]);
    const current = await workflow(page, org, workflowId);
    const renamed = "准备全部材料";
    const steps = JSON.parse(current.draft).map((entry: StoredModule) =>
      entry.kind === "MODULE" && entry.id === firstRecord.moduleId
        ? { ...entry, title: renamed }
        : entry,
    );
    const csrf = await (await page.request.get("/api/csrf")).json();
    const response = await page.request.post(`/api/orgs/${org}/sops/save`, {
      headers: { [csrf.headerName]: csrf.token },
      data: {
        id: workflowId,
        title: current.title,
        category: current.category,
        expectedRevision: current.revision,
        steps,
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const updated = (await records(page, org)).find(
      (record) => record.moduleId === firstRecord.moduleId,
    )!;
    expect(updated.id).toBe(firstRecord.id);
    expect(updated.name).toBe(renamed);
    await page.reload();
    await expect(firstRow.getByRole("rowheader")).toHaveText(renamed);
    await expect(
      firstRow.getByTitle(firstRecord.id, { exact: true }),
    ).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(4);
    await screenshot(page, "process-records-desktop");
    const locate = firstRow.getByRole("link", {
      name: "在流程里查看",
      exact: true,
    });
    await expect(locate).toHaveAttribute(
      "href",
      `${path}?module=${firstRecord.moduleId}`,
    );
    await locate.click();
    await expect(
      canvas(page).locator(`[data-module-id="${firstRecord.moduleId}"]`),
    ).toHaveClass(/is-focused/);
  });

  await test.step("phone retains free positions, then deleting a module removes one record and its connections", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(
      page
        .getByRole("region", { name: "工作清单", exact: true })
        .getByRole("table")
        .getByRole("row"),
    ).toHaveCount(4);
    await expect(page.locator("textarea")).toHaveCount(0);
    await expect(page.getByText(/备注/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /保存备注/ })).toHaveCount(0);
    await expect(page.getByRole("table").getByRole("columnheader")).toHaveText([
      "工作名称",
      "编号",
      "所属流程",
      "具体做法",
      "操作",
    ]);
    await expect(
      page.getByRole("region", { name: "工作记录详情", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("选中的工作记录", { exact: true })).toHaveCount(
      0,
    );
    const mobileRow = page
      .getByRole("table")
      .getByRole("row")
      .filter({ has: page.getByTitle(firstRecord.id, { exact: true }) });
    await expect(
      mobileRow.getByRole("link", { name: "在流程里查看", exact: true }),
    ).toHaveAttribute("href", `${path}?module=${firstRecord.moduleId}`);
    await screenshot(page, "process-records-mobile");
    await expectNoOverflow(page);
    await page.goto(path);
    await expect(
      canvas(page).locator("path[data-source][data-target]"),
    ).toHaveCount(1);
    await expectNoOverflow(page);
    await screenshot(page, "free-canvas-mobile");
    const saved = nextSave(page, org);
    await board(page)
      .getByRole("button", { name: `删除工作 ${names[1]}`, exact: true })
      .click();
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(canvas(page).locator(".flow-tile")).toHaveCount(2);
    await expect(
      canvas(page).locator("path[data-source][data-target]"),
    ).toHaveCount(0);
    const remaining = await records(page, org);
    expect(remaining).toHaveLength(2);
    expect(remaining.some((record) => record.id === secondRecord.id)).toBe(
      false,
    );
    expect(remaining.find((record) => record.id === firstRecord.id)!.name).toBe(
      "准备全部材料",
    );
    await page.goto("/");
    await expect(
      page
        .getByRole("region", { name: "工作清单", exact: true })
        .getByRole("table")
        .getByRole("row"),
    ).toHaveCount(3);
    await expectNoOverflow(page);
    await expect(page.getByLabel(/邮箱|密码/)).toHaveCount(0);
    await expect(
      page.getByText(/^(今日任务|未完成|待完成|已完成|需要关注)$/),
    ).toHaveCount(0);
  });
  await test.step("removing a legacy module keeps its empty instruction document, media and custom metadata", async () => {
    const csrf = await (await page.request.get("/api/csrf")).json();
    const legacyTitle = "旧版空白说明";
    const imageUrl = "https://example.com/reference/legacy.png";
    const seeded = await page.request.post(`/api/orgs/${org}/sops/save`, {
      headers: { [csrf.headerName]: csrf.token },
      data: {
        title: "旧版资料保护",
        category: "兼容记录",
        steps: [
          {
            id: "legacy-empty-item",
            title: legacyTitle,
            description: "",
            imageUrl,
            materials: "旧物料记录",
            safetyNotice: "旧注意事项",
            customField: "应当保留的附加内容",
          },
        ],
      },
    });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    const legacy: SavedWorkflow = await seeded.json();
    expect(
      (await records(page, org)).filter(
        (record) => record.workflowId === legacy.id,
      ),
    ).toHaveLength(1);
    await page.goto(`/workflows/${legacy.id}`);
    const saved = nextSave(page, org);
    await board(page)
      .getByRole("button", { name: `删除工作 ${legacyTitle}`, exact: true })
      .click();
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(board(page)).toBeVisible();
    await expect(canvas(page).locator(".flow-tile")).toHaveCount(0);
    const preserved = JSON.parse(
      (await workflow(page, org, legacy.id)).draft,
    ).find(
      (entry: StoredModule) =>
        entry.kind === "DETAIL" && entry.title === legacyTitle,
    );
    expect(preserved).toMatchObject({
      kind: "DETAIL",
      title: legacyTitle,
      legacyEmpty: true,
      items: [],
      imageUrl,
      materials: "旧物料记录",
      safetyNotice: "旧注意事项",
      customField: "应当保留的附加内容",
    });
    expect(
      (await records(page, org)).filter(
        (record) => record.workflowId === legacy.id,
      ),
    ).toHaveLength(0);
  });
  await test.step("a new editor saves a direct connection and phone touch can redraw the same arrow", async () => {
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.goto("/workflows/new");
    await page.getByLabel("流程名称", { exact: true }).fill("手动画线的新流程");
    const draftNames = ["先准备工具", "再清理台面"];
    for (const name of draftNames) {
      await board(page)
        .getByRole("button", { name: "添加工作", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "添加工作",
        exact: true,
      });
      await dialog.getByLabel("工作名称", { exact: true }).fill(name);
      await dialog
        .getByRole("button", { name: "添加到流程图", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
    }
    const draftRequests = saveRequests.length;
    await resizeWork(page, draftNames[0], { width: 0.2, height: 0.3 });
    const draftSize = await tile(page, draftNames[0]).boundingBox();
    expect(draftSize!.height).toBeGreaterThan(draftSize!.width + 50);
    expect(saveRequests).toHaveLength(draftRequests);
    await port(page, draftNames[0]).click();
    await board(page)
      .getByRole("button", { name: `连接工作 ${draftNames[1]}`, exact: true })
      .click();
    await expect(arrows(page)).toHaveCount(1);
    expect(saveRequests).toHaveLength(draftRequests);
    await screenshot(page, "direct-arrows-editor-desktop");
    const created = nextSave(page, org);
    await page
      .getByRole("button", { name: "添加流程", exact: true })
      .first()
      .click();
    expect((await created).ok()).toBe(true);
    await expect(page).toHaveURL(/\/workflows\/[a-f0-9-]{36}$/);
    const createdPath = new URL(page.url()).pathname;
    const createdId = createdPath.split("/").at(-1)!;
    await page.reload();
    await expect(arrows(page)).toHaveCount(1);
    const createdSteps = JSON.parse(
      (await workflow(page, org, createdId)).draft,
    ) as StoredModule[];
    const createdWork = createdSteps.find(
      (entry) => entry.kind === "MODULE" && entry.title === draftNames[0],
    )!;
    expect(geometry(createdWork).size!.width).toBeCloseTo(0.2, 2);
    expect(geometry(createdWork).size!.height).toBeCloseTo(0.3, 2);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(createdPath);
    const removed = nextSave(page, org);
    await board(page)
      .getByRole("button", {
        name: `删除箭头 ${draftNames[0]} 到 ${draftNames[1]}`,
        exact: true,
      })
      .click();
    expect((await removed).ok()).toBe(true);
    await expect(arrows(page)).toHaveCount(0);
    await canvas(page).scrollIntoViewIfNeeded();
    const start = await port(page, draftNames[0]).boundingBox();
    const target = await tile(page, draftNames[1]).boundingBox();
    expect(start).toBeTruthy();
    expect(target).toBeTruthy();
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 1,
      });
      const from = {
        x: start!.x + start!.width / 2,
        y: start!.y + start!.height / 2,
      };
      const to = {
        x: target!.x + target!.width / 2,
        y: target!.y + target!.height / 2,
      };
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ ...from, id: 1 }],
      });
      for (let step = 1; step <= 12; step++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            {
              x: from.x + ((to.x - from.x) * step) / 12,
              y: from.y + ((to.y - from.y) * step) / 12,
              id: 1,
            },
          ],
        });
      }
      await expect(
        canvas(page).locator('path[data-connection-preview="true"]'),
      ).toHaveAttribute("d", /^M .+ [CL] .+/);
      await expect(tile(page, draftNames[1])).toHaveClass(
        /is-connection-target/,
      );
      const touchSaved = nextSave(page, org);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      expect((await touchSaved).ok()).toBe(true);
    } finally {
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await cdp.detach();
    }
    await expect(arrows(page)).toHaveCount(1);
    await expect(port(page, draftNames[0])).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(
      canvas(page).locator('path[data-connection-preview="true"]'),
    ).toHaveCount(0);
    await page.reload();
    await expect(arrows(page)).toHaveCount(1);
    await expectNoOverflow(page);
    await screenshot(page, "direct-arrows-mobile");

    const beforePhone = await workflow(page, org, createdId);
    const beforePhoneBox = await tile(page, draftNames[0]).boundingBox();
    const phoneRecordIds = (await records(page, org))
      .filter((entry) => entry.workflowId === createdId)
      .map((entry) => entry.id)
      .sort();
    const phoneRequests = saveRequests.length;
    const beforePhoneArrow = await arrows(page).first().getAttribute("d");
    const touchCdp = await page.context().newCDPSession(page);
    try {
      await touchCdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 1,
      });
      const touchResize = async (
        size: { width: number; height: number },
        cancel: boolean,
      ) => {
        await canvas(page).scrollIntoViewIfNeeded();
        const bounds = await canvas(page).boundingBox();
        const current = await tile(page, draftNames[0]).boundingBox();
        const grip = await resizeHandle(page, draftNames[0]).boundingBox();
        const from = {
          x: grip!.x + grip!.width / 2,
          y: grip!.y + grip!.height / 2,
        };
        const to = {
          x: from.x + bounds!.width * size.width - current!.width,
          y: from.y + bounds!.height * size.height - current!.height,
        };
        await touchCdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ ...from, id: 1 }],
        });
        for (let step = 1; step <= 12; step++) {
          await touchCdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [
              {
                x: from.x + ((to.x - from.x) * step) / 12,
                y: from.y + ((to.y - from.y) * step) / 12,
                id: 1,
              },
            ],
          });
        }
        if (cancel) {
          await touchCdp.send("Input.dispatchTouchEvent", {
            type: "touchCancel",
            touchPoints: [],
          });
        } else {
          await expect(arrows(page).first()).not.toHaveAttribute(
            "d",
            beforePhoneArrow!,
          );
          const resized = nextSave(page, org);
          await touchCdp.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
          expect((await resized).ok()).toBe(true);
        }
      };
      await touchResize({ width: 0.31, height: 0.4 }, true);
      const canceledPhone = await workflow(page, org, createdId);
      expect(canceledPhone.revision).toBe(beforePhone.revision);
      expect(canceledPhone.draft).toBe(beforePhone.draft);
      expect(saveRequests).toHaveLength(phoneRequests);
      await expect
        .poll(async () =>
          Math.abs(
            (await tile(page, draftNames[0]).boundingBox())!.width -
              beforePhoneBox!.width,
          ),
        )
        .toBeLessThanOrEqual(1);
      await expect
        .poll(async () =>
          Math.abs(
            (await tile(page, draftNames[0]).boundingBox())!.height -
              beforePhoneBox!.height,
          ),
        )
        .toBeLessThanOrEqual(1);
      await touchResize({ width: 0.18, height: 0.38 }, false);
    } finally {
      await touchCdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: false,
      });
      await touchCdp.detach();
    }
    await page.reload();
    await expect(arrows(page)).toHaveCount(1);
    const resizedPhone = (
      JSON.parse((await workflow(page, org, createdId)).draft) as StoredModule[]
    ).find((entry) => entry.kind === "MODULE" && entry.id === createdWork.id)!;
    const phoneCanvasWidth = (await canvas(page).boundingBox())!.width;
    const initialPhoneModule = (
      JSON.parse(beforePhone.draft) as StoredModule[]
    ).find((entry) => entry.id === createdWork.id)!;
    // The 64px practical minimum uses the scaled screen width, not clientWidth.
    expect(geometry(resizedPhone).size!.width).toBeCloseTo(
      Math.max(
        0.18,
        Math.min(
          geometry(initialPhoneModule).size.width,
          64 / phoneCanvasWidth,
        ),
      ),
      2,
    );
    expect(geometry(resizedPhone).size!.height).toBeCloseTo(0.38, 2);
    expect(
      (await records(page, org))
        .filter((entry) => entry.workflowId === createdId)
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(phoneRecordIds);
    await expectNoOverflow(page);
    await screenshot(page, "resized-work-mobile");
  });
  expect(errors).toEqual([]);
});
