import { expect, test, type Page } from "@playwright/test";
import { autoSaveStatus, waitForAutoSave } from "./editor";
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
};
type StoredStep = {
  id: string;
  kind: string;
  title: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  frame?: { x: number; y: number; width: number; height: number };
  nextModuleIds?: string[];
  items?: { id: string; text: string }[];
  materials?: string;
  safetyNotice?: string;
  imageUrl?: string;
  videoUrl?: string;
};

async function workflows(page: Page, org: string): Promise<SavedWorkflow[]> {
  const response = await page.request.get(`/api/orgs/${org}/sops`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function workflow(page: Page, org: string, id: string) {
  const record = (await workflows(page, org)).find((item) => item.id === id);
  expect(record).toBeTruthy();
  return record!;
}

async function saveViaApi(page: Page, org: string, data: object) {
  const csrf = await (await page.request.get("/api/csrf")).json();
  const response = await page.request.post(`/api/orgs/${org}/sops/save`, {
    headers: { [csrf.headerName]: csrf.token },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as SavedWorkflow;
}

const steps = (record: SavedWorkflow) =>
  JSON.parse(record.draft) as StoredStep[];
const detail = (page: Page) =>
  page.getByRole("region", { name: "具体做法 1", exact: true });
const stepInput = (page: Page) =>
  detail(page).getByRole("textbox", { name: "步骤 1", exact: true });
const board = (page: Page) =>
  page.getByRole("region", { name: "流程图", exact: true });

async function screenshot(page: Page, name: string) {
  await expectNoGlobalNavigation(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: `../docs/screenshots/${name}.png`,
    fullPage: true,
  });
}
async function localBackups(page: Page, key: string) {
  return page.evaluate(
    (key) =>
      Object.keys(localStorage)
        .filter((item) => item === key || item.startsWith(`${key}:tab:`))
        .map((item) => ({ key: item, raw: localStorage.getItem(item) }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    key,
  );
}

test("existing editors save sequentially, preserve incomplete local drafts and never overwrite conflicting changes", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  expect(baseURL).toBe("http://127.0.0.1:5174");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/");
  await expectWorkflowHome(page);
  const org = await createHandbookViaApi(page, `自动保存验证-${Date.now()}`);
  const me = await (await page.request.get("/api/auth/me")).json();
  const user = String(me.user.id);
  const firstName = "清洁操作台";
  const secondName = "收好工具";
  const original = await saveViaApi(page, org, {
    title: "自动保存原始流程",
    category: "验证分类",
    steps: [
      {
        kind: "MODULE",
        id: "auto-first",
        title: firstName,
        position: { x: 0.1, y: 0.1 },
      },
      {
        kind: "MODULE",
        id: "auto-second",
        title: secondName,
        position: { x: 0.6, y: 0.45 },
      },
      {
        kind: "DETAIL",
        id: "auto-detail",
        title: firstName,
        items: [{ id: "auto-item-1", text: "用干净的抹布擦拭操作台。" }],
        materials: "干净抹布、温水",
        safetyNotice: "断开电源再清洁。",
      },
    ],
  });
  const path = `/workflows/${original.id}`;
  const backupKey = `workflow-os:editor:${user}:${org}:${original.id}`;
  const recordsBefore = await (
    await page.request.get(`/api/orgs/${org}/work-items`)
  ).json();
  const edit = async () => {
    await page.goto(`${path}/edit`);
    await expect(
      page.locator("main.workflow-editor #workflow-editor-form"),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "修改流程和做法", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator("main.workflow-editor h1")).toHaveCount(0);
    await waitForAutoSave(page);
    await expect(
      page.getByRole("button", { name: /保存流程|添加流程/ }),
    ).toHaveCount(0);
  };
  await page.goto(path);
  await expect(board(page)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "修改流程和做法", exact: true }),
  ).toHaveCount(0);
  await screenshot(page, "workflow-reader-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, "workflow-reader-mobile");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await edit();

  await test.step("name, category, continuous instructions and uploaded media save without a button", async () => {
    await page.getByLabel("流程名称", { exact: true }).fill("会自动保存的流程");
    await page.getByLabel("分类", { exact: true }).fill("日常清洁");
    await page.getByRole("tab", { name: "写具体做法", exact: true }).click();
    await stepInput(page).fill("");
    await stepInput(page).pressSequentially(
      "先准备抹布，再从内到外擦拭并晾干。",
      { delay: 30 },
    );
    await detail(page).locator("summary").click();
    await detail(page)
      .getByLabel("参考图片", { exact: true })
      .setInputFiles("public/icon-192.png");
    await expect(
      detail(page).getByRole("img", {
        name: `${firstName}的参考图片`,
        exact: true,
      }),
    ).toBeVisible();
    await detail(page)
      .getByLabel("操作视频链接", { exact: true })
      .fill("https://example.com/autosave-cleaning");
    await waitForAutoSave(page);
    const saved = await workflow(page, org, original.id);
    expect(saved.title).toBe("会自动保存的流程");
    expect(saved.category).toBe("日常清洁");
    const instructions = steps(saved).find((item) => item.kind === "DETAIL")!;
    expect(instructions.items?.[0].text).toBe(
      "先准备抹布，再从内到外擦拭并晾干。",
    );
    expect(instructions.imageUrl).toMatch(
      new RegExp(`^/api/orgs/${org}/files/`),
    );
    expect(instructions.videoUrl).toBe("https://example.com/autosave-cleaning");
    const image = await page.request.get(instructions.imageUrl!);
    expect(image.ok()).toBe(true);
    await screenshot(page, "autosave-editor-desktop");
  });

  await test.step("a slow response never permits concurrent saves and queued edits use the new revision", async () => {
    const payloads: {
      expectedRevision: number;
      title: string;
      steps: StoredStep[];
    }[] = [];
    let active = 0;
    let maximumActive = 0;
    let firstSaved: SavedWorkflow | undefined;
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const firstRequest = new Promise<void>((resolve) => (arrived = resolve));
    const pattern = `**/api/orgs/${org}/sops/save`;
    await page.route(pattern, async (route) => {
      payloads.push(route.request().postDataJSON());
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        const response = await route.fetch();
        if (payloads.length === 1) {
          firstSaved = await response.json();
          arrived();
          await gate;
        }
        await route.fulfill({ response });
      } finally {
        active--;
      }
    });
    try {
      await page.getByLabel("流程名称", { exact: true }).fill("先发出的修改");
      await firstRequest;
      await expect(autoSaveStatus(page)).toHaveText("正在保存…");
      await expect(stepInput(page)).toBeEnabled();
      await stepInput(page).fill("最终做法：擦拭后检查边角，再把抹布洗净。 ");
      await page
        .getByLabel("流程名称", { exact: true })
        .fill("连续修改后的最终流程");
      // Let the debounce expire while the first server response is deliberately held.
      await page.waitForTimeout(950);
      expect(payloads).toHaveLength(1);
      release();
      await waitForAutoSave(page);
      expect(payloads).toHaveLength(2);
      expect(maximumActive).toBe(1);
      expect(payloads[1].expectedRevision).toBe(firstSaved!.revision);
      expect(payloads[1].title).toBe("连续修改后的最终流程");
      const saved = await workflow(page, org, original.id);
      expect(saved.revision).toBe(firstSaved!.revision + 1);
      expect(
        steps(saved).find((item) => item.kind === "DETAIL")!.items?.[0].text,
      ).toBe("最终做法：擦拭后检查边角，再把抹布洗净。 ");
    } finally {
      release();
      await page.unroute(pattern);
    }
  });

  await test.step("Chinese input composition stays local until the user confirms the characters", async () => {
    const before = await workflow(page, org, original.id);
    await stepInput(page).dispatchEvent("compositionstart", { data: "" });
    await stepInput(page).fill("正在输入的中文做法");
    await page.waitForTimeout(950);
    expect(await workflow(page, org, original.id)).toEqual(before);
    await stepInput(page).dispatchEvent("compositionend", {
      data: "正在输入的中文做法",
    });
    await waitForAutoSave(page);
    const saved = await workflow(page, org, original.id);
    expect(
      steps(saved).find((item) => item.kind === "DETAIL")!.items?.[0].text,
    ).toBe("正在输入的中文做法");
  });

  await test.step("editor canvas operations share autosave and keep record IDs, instructions and media", async () => {
    const before = await workflow(page, org, original.id);
    const instructionsBefore = steps(before).find(
      (item) => item.kind === "DETAIL",
    );
    await page.getByRole("tab", { name: "安排工作", exact: true }).click();
    const resize = page.getByRole("button", {
      name: `调整 ${firstName} 的大小`,
      exact: true,
    });
    await resize.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    const handle = page.getByRole("button", {
      name: `拖动工作 ${firstName}`,
      exact: true,
    });
    await handle.focus();
    await page.keyboard.press("Space", { delay: 80 });
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("ArrowRight", { delay: 80 });
    await page.keyboard.press("Space", { delay: 80 });
    await expect(handle).not.toHaveAttribute("aria-pressed", "true");
    await page
      .getByRole("button", { name: `从 ${firstName} 画箭头`, exact: true })
      .click();
    await page
      .getByRole("button", { name: `连接工作 ${secondName}`, exact: true })
      .click();
    await waitForAutoSave(page);
    const saved = await workflow(page, org, original.id);
    const first = steps(saved).find((item) => item.id === "auto-first")!;
    expect(first.frame!.x).toBeGreaterThan(82);
    expect(first.frame!.width).toBeGreaterThan(164);
    expect(first.frame!.height).toBeGreaterThan(164);
    expect(first.nextModuleIds).toEqual(["auto-second"]);
    expect(steps(saved).find((item) => item.kind === "DETAIL")).toEqual(
      instructionsBefore,
    );
    const recordsAfter = await (
      await page.request.get(`/api/orgs/${org}/work-items`)
    ).json();
    expect(recordsAfter.map((item: { id: string }) => item.id).sort()).toEqual(
      recordsBefore.map((item: { id: string }) => item.id).sort(),
    );
    await page.reload();
    await waitForAutoSave(page);
    expect(
      await board(page).locator("path[data-source][data-target]").count(),
    ).toBe(1);
  });

  await test.step("invalid content survives refresh locally while the saved workflow stays intact", async () => {
    const before = await workflow(page, org, original.id);
    const untouched = await page.context().newPage();
    await untouched.goto(`${path}/edit`);
    await waitForAutoSave(untouched);
    await page.getByLabel("流程名称", { exact: true }).fill("");
    await expect(autoSaveStatus(page)).toHaveText("草稿已保留，补全后自动保存");
    await expect(page.getByRole("alert")).toContainText("请填写流程名称");
    const pending = await localBackups(page, backupKey);
    expect(
      pending.some(
        (item) =>
          item.key.startsWith(`${backupKey}:tab:`) &&
          JSON.parse(item.raw!).draft.title === "",
      ),
    ).toBe(true);
    expect(pending.some((item) => item.key === backupKey)).toBe(false);
    await untouched.close();
    expect(await localBackups(page, backupKey)).toEqual(pending);
    await page.waitForTimeout(850);
    expect(await workflow(page, org, original.id)).toEqual(before);
    await page.reload();
    await expect(page.getByLabel("流程名称", { exact: true })).toHaveValue("");
    await expect(autoSaveStatus(page)).toHaveText("草稿已保留，补全后自动保存");
    expect(await workflow(page, org, original.id)).toEqual(before);
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, "autosave-draft-mobile");
    await page.getByLabel("流程名称", { exact: true }).fill(before.title);
    await waitForAutoSave(page);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await workflow(page, org, original.id)).toEqual(before);
    await page.getByLabel("流程名称", { exact: true }).fill("补全名称后的流程");
    await waitForAutoSave(page);
    expect((await workflow(page, org, original.id)).title).toBe(
      "补全名称后的流程",
    );
  });

  await test.step("returning immediately flushes the latest edit and refresh retains it", async () => {
    await page.getByLabel("分类", { exact: true }).fill("返回前的最后修改");
    await page.getByRole("link", { name: "返回流程", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    expect((await workflow(page, org, original.id)).category).toBe(
      "返回前的最后修改",
    );
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "补全名称后的流程", exact: true }),
    ).toBeVisible();
    await edit();
    await screenshot(page, "autosave-editor-mobile");
  });

  await test.step("new workflows are created only by the explicit add button", async () => {
    const before = await workflows(page, org);
    const newKey = `workflow-os:editor:${user}:${org}:new`;
    await page.goto("/workflows/new");
    await page.getByLabel("流程名称", { exact: true }).fill("明确添加的新流程");
    await expect(
      page.getByRole("button", { name: "保存流程", exact: true }),
    ).toHaveCount(0);
    await expect(autoSaveStatus(page)).toHaveText(
      "草稿已保留在本机，点击添加流程后创建",
    );
    const pending = await localBackups(page, newKey);
    expect(
      pending.some(
        (item) =>
          item.key.startsWith(`${newKey}:tab:`) &&
          JSON.parse(item.raw!).draft.title === "明确添加的新流程",
      ),
    ).toBe(true);
    await page.waitForTimeout(950);
    expect(await workflows(page, org)).toHaveLength(before.length);
    await page.reload();
    await expect(page.getByLabel("流程名称", { exact: true })).toHaveValue(
      "明确添加的新流程",
    );
    expect(await workflows(page, org)).toHaveLength(before.length);
    await page.getByRole("button", { name: "添加流程", exact: true }).click();
    await expect(page).toHaveURL(/\/workflows\/[a-f0-9-]{36}$/);
    await expect(board(page)).toBeVisible();
    expect(await localBackups(page, newKey)).toEqual([]);
    expect(await workflows(page, org)).toHaveLength(before.length + 1);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "明确添加的新流程", exact: true }),
    ).toBeVisible();
  });

  await test.step("a conflicting remote revision pauses saving and retains the local draft", async () => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await edit();
    const before = await workflow(page, org, original.id);
    const remote = await saveViaApi(page, org, {
      id: original.id,
      expectedRevision: before.revision,
      title: "另一页面已经修改的流程",
      category: before.category,
      steps: steps(before),
    });
    let rejectedSaves = 0;
    page.on("response", (response) => {
      if (
        response.url().endsWith(`/api/orgs/${org}/sops/save`) &&
        response.status() === 409
      )
        rejectedSaves++;
    });
    await page.getByLabel("流程名称", { exact: true }).fill("保留在本机的修改");
    await expect(page.getByRole("alert")).toContainText("没有覆盖另一份修改");
    await expect(autoSaveStatus(page)).toHaveText("草稿已保留在本机");
    expect(
      (await localBackups(page, backupKey)).some(
        (item) =>
          item.key.startsWith(`${backupKey}:tab:`) &&
          JSON.parse(item.raw!).draft.title === "保留在本机的修改",
      ),
    ).toBe(true);
    await page.waitForTimeout(950);
    expect(rejectedSaves).toBe(1);
    expect(await workflow(page, org, original.id)).toEqual(remote);
    await page.reload();
    await expect(page.getByLabel("流程名称", { exact: true })).toHaveValue(
      "保留在本机的修改",
    );
    await expect(page.getByRole("alert")).toContainText("自动保存已暂停");
    await expect(autoSaveStatus(page)).toHaveText("草稿已保留在本机");
    expect(await workflow(page, org, original.id)).toEqual(remote);
  });
  expect(errors).toEqual([]);
});
