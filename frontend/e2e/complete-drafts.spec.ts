import { expect, test, type Page, type Route } from "@playwright/test";
import { waitForAutoSave } from "./editor";
import {
  createHandbookViaApi,
  expectNoGlobalNavigation,
  expectWorkflowHome,
} from "./handbook";

type Entry = {
  id: string;
  kind: string;
  title: string;
  items?: { id: string; text: string }[];
  frame?: { x: number; y: number; width: number; height: number };
  [key: string]: unknown;
};
type Saved = {
  id: string;
  title: string;
  category: string;
  revision: number;
  draft: string;
  boardSettings: string;
  status: string;
  currentVersionId: string;
};
const prose = (page: Page) => page.locator(".complete-prose");
async function proseText(page: Page) {
  return (await prose(page).locator("p").allTextContents()).join("\n\n");
}
const entries = (saved: Saved) => JSON.parse(saved.draft) as Entry[];
const modules = (saved: Saved) =>
  entries(saved).filter((item) => item.kind === "MODULE");
const details = (saved: Saved) =>
  entries(saved).filter((item) => item.kind === "DETAIL");
async function get(page: Page, path: string) {
  const response = await page.request.get(path);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function seed(page: Page, org: string, data: object): Promise<Saved> {
  const csrf = await get(page, "/api/csrf");
  const response = await page.request.post(`/api/orgs/${org}/sops/save`, {
    headers: { [csrf.headerName]: csrf.token },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function read(page: Page, org: string, id: string): Promise<Saved> {
  return (await get(page, `/api/orgs/${org}/sops`)).find(
    (item: Saved) => item.id === id,
  );
}
async function snapshot(page: Page, org: string) {
  const sops = (await get(page, `/api/orgs/${org}/sops`)).sort(
    (a: Saved, b: Saved) => a.id.localeCompare(b.id),
  );
  return {
    sops,
    records: await get(page, `/api/orgs/${org}/work-items`),
    versions: await Promise.all(
      sops.map(async (saved: Saved) => ({
        id: saved.id,
        versions: await get(page, `/api/orgs/${org}/sops/${saved.id}/versions`),
      })),
    ),
  };
}
async function setup(page: Page, name: string) {
  await page.goto("/");
  await expectWorkflowHome(page);
  const org = await createHandbookViaApi(page, `${name}-${Date.now()}`);
  const me = await get(page, "/api/auth/me");
  return { org, user: String(me.user.id) };
}
async function framework(page: Page, org: string) {
  const old = await seed(page, org, {
    title: "旧工作框架",
    category: "旧分类",
    boardSettings: JSON.stringify({
      version: 1,
      timeline: { enabled: true, startMinute: 540, endMinute: 1080, axis: "x" },
      priority: { enabled: true, axis: "y" },
      canvas: { width: 820, height: 820 },
    }),
    steps: [
      {
        kind: "MODULE",
        id: "draft-module-a",
        title: "清洁操作台",
        frame: { x: 120, y: 60, width: 100, height: 80 },
      },
      {
        kind: "MODULE",
        id: "draft-module-b",
        title: "整理工具",
        frame: { x: 240, y: 600, width: 100, height: 80 },
      },
    ],
  });
  const latest = await seed(page, org, {
    id: old.id,
    expectedRevision: old.revision,
    title: "最新保存的框架和时间",
    category: "最新分类",
    boardSettings: JSON.stringify({
      version: 1,
      timeline: { enabled: true, startMinute: 480, endMinute: 1200, axis: "x" },
      priority: { enabled: true, axis: "y" },
      canvas: { width: 820, height: 820 },
    }),
    steps: modules(old).map((item) => ({
      ...item,
      frame: { ...item.frame!, x: item.id === "draft-module-a" ? 480 : 80 },
    })),
  });
  return { old, latest };
}
async function screenshot(page: Page, name: string) {
  await expectNoGlobalNavigation(page);
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: `../docs/screenshots/${name}.png`,
    fullPage: true,
  });
}
const saveResponse = (page: Page, org: string) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${org}/sops/save`),
  );
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

test("unsynced written instructions preview with the latest board and recover safely without publishing", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(90_000);
  expect(baseURL).toBe("http://127.0.0.1:5174");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL,
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  const errors: string[] = [],
    writes: { url: string; data: any }[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { org, user } = await setup(page, "未同步做法恢复"),
    { old, latest } = await framework(page, org);
  const key = `workflow-os:editor:${user}:${org}:${latest.id}`;
  const localDetails = [
    {
      kind: "DETAIL",
      id: "local-written-a",
      title: "清洁操作台",
      items: [
        { id: "local-a-one", text: "这是已经写在本机的清洁做法。" },
        { id: "local-a-empty", text: "" },
      ],
      materials: "干净抹布",
      safetyNotice: "先断开电源。",
    },
    {
      kind: "DETAIL",
      id: "local-written-b",
      title: "整理工具",
      items: [{ id: "local-b-one", text: "把工具擦干，按编号放回收纳盒。" }],
    },
    {
      kind: "DETAIL",
      id: "local-unnamed",
      title: "",
      items: [{ id: "local-unnamed-empty", text: "" }],
    },
  ];
  const raw = JSON.stringify({
    revision: old.revision,
    draft: {
      title: old.title,
      category: old.category,
      modules: modules(old),
      details: localDetails,
      boardSettings: old.boardSettings,
    },
  });
  // Keep the legacy snapshot and a newer independently owned tab snapshot.
  // Recovery must consume only the chosen newer snapshot, never the old one.
  const tabKey = `${key}:tab:newer-draft-fixture`;
  const tabDetails = structuredClone(localDetails);
  tabDetails[0].items[0].text = "这是较新标签页里写下的清洁做法。";
  const tabRaw = JSON.stringify({
    ...JSON.parse(raw),
    updatedAt: 2,
    draft: { ...JSON.parse(raw).draft, details: tabDetails },
  });
  const conflict = await seed(page, org, {
    title: "已有服务器正文的冲突流程",
    steps: [
      { kind: "MODULE", id: "conflict-module", title: "冲突工作" },
      {
        kind: "DETAIL",
        id: "conflict-detail",
        title: "冲突工作",
        items: [
          { id: "conflict-line", text: "服务器的正文不得被恢复按钮覆盖。" },
        ],
      },
    ],
  });
  const conflictKey = `workflow-os:editor:${user}:${org}:${conflict.id}`;
  const conflictRaw = JSON.stringify({
    revision: conflict.revision,
    draft: {
      title: conflict.title,
      category: "",
      modules: modules(conflict),
      details: [
        {
          kind: "DETAIL",
          id: "conflict-detail",
          title: "冲突工作",
          items: [{ id: "conflict-line", text: "本机另一份冲突正文。" }],
        },
      ],
      boardSettings: null,
    },
  });
  await page.evaluate(
    ({ key, raw, tabKey, tabRaw, conflictKey, conflictRaw }) => {
      localStorage.setItem(key, raw);
      localStorage.setItem(tabKey, tabRaw);
      localStorage.setItem(conflictKey, conflictRaw);
    },
    { key, raw, tabKey, tabRaw, conflictKey, conflictRaw },
  );
  const before = await snapshot(page, org),
    versions = await get(page, `/api/orgs/${org}/sops/${latest.id}/versions`);
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/sops(?:\/save|\/[^/]+\/publish)?$/.test(request.url())
    )
      writes.push({ url: request.url(), data: request.postDataJSON() });
  });
  await page.goto(`/workflows/${latest.id}/complete`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    latest.title,
  );
  const expectedProse =
    "09:20 整理工具：把工具擦干，按编号放回收纳盒。" +
    "16:00 清洁操作台：干净抹布，这是较新标签页里写下的清洁做法。先断开电源。";
  await expect(prose(page)).toHaveText(expectedProse);
  await expect(prose(page).locator("ol, ul, li, a")).toHaveCount(0);
  for (const omitted of ["这一步还没有填写", "包含本机尚未同步"])
    await expect(prose(page)).not.toContainText(omitted);
  await expect(
    page.getByRole("button", { name: "保存本机做法", exact: true }),
  ).toBeVisible();
  await screenshot(page, "complete-local-drafts-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, "complete-local-drafts-mobile");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("button", { name: "复制全文", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已复制", exact: true }),
  ).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(expectedProse);
  expect(copied).toBe(await proseText(page));
  expect(copied).not.toContain("包含本机尚未同步的做法");
  expect(copied).toContain("16:00 清洁操作台");
  await page.evaluate(() =>
    addEventListener(
      "beforeprint",
      () => document.body.setAttribute("data-draft-printed", "yes"),
      { once: true },
    ),
  );
  await page.getByRole("button", { name: "打印", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-draft-printed",
    "yes",
  );
  await page.emulateMedia({ media: "print" });
  await expect(prose(page)).toBeVisible();
  await expect(prose(page)).toHaveText(expectedProse);
  await expect(page.locator(".complete-screen-tools")).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  expect(await snapshot(page, org)).toEqual(before);
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    raw,
  );
  expect(await localBackups(page, key)).toEqual([
    { key, raw },
    { key: tabKey, raw: tabRaw },
  ]);
  expect(writes).toHaveLength(0);

  const employee = async (route: Route) => {
    const response = await route.fetch(),
      data = await response.json();
    data.memberships = data.memberships?.map(
      (item: { organizationId: string; role: string }) =>
        item.organizationId === org ? { ...item, role: "EMPLOYEE" } : item,
    );
    await route.fulfill({ response, json: data });
  };
  await page.route("**/api/auth/me", employee);
  await page.route("**/api/personal/bootstrap", employee);
  await page.reload();
  await expect(prose(page)).toHaveText("09:20 整理工具。16:00 清洁操作台。");
  await expect(
    page.getByRole("button", { name: "保存本机做法", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("main")).not.toContainText(
    "这是较新标签页里写下的清洁做法。",
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    raw,
  );
  await page.unroute("**/api/auth/me", employee);
  await page.unroute("**/api/personal/bootstrap", employee);
  await page.reload();
  const savedResponse = saveResponse(page, org);
  await page.getByRole("button", { name: "保存本机做法", exact: true }).click();
  expect((await savedResponse).ok()).toBe(true);
  await expect(
    page.getByRole("button", { name: "保存本机做法", exact: true }),
  ).toHaveCount(0);
  await expect(prose(page)).toHaveText(expectedProse);
  expect(writes).toHaveLength(1);
  expect(writes[0].data.draftOnly).toBe(true);
  const recovered = await read(page, org, latest.id);
  expect(modules(recovered)).toEqual(modules(latest));
  expect(recovered.boardSettings).toBe(latest.boardSettings);
  expect(recovered.title).toBe(latest.title);
  expect(recovered.category).toBe(latest.category);
  expect(details(recovered)).toEqual(tabDetails);
  expect(recovered.currentVersionId).toBe(latest.currentVersionId);
  expect(recovered.status).toBe(latest.status);
  expect(
    await get(page, `/api/orgs/${org}/sops/${latest.id}/versions`),
  ).toEqual(versions);
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    raw,
  );
  expect(
    await page.evaluate((key) => localStorage.getItem(key), tabKey),
  ).toBeNull();
  expect(await localBackups(page, key)).toEqual([{ key, raw }]);
  const archives = await page.evaluate(
    (key) =>
      Object.keys(localStorage)
        .filter((item) => item.startsWith(`${key}:recovery:`))
        .map((item) => localStorage.getItem(item)),
    key,
  );
  expect(archives).toEqual([tabRaw]);
  await page.reload();
  await expect(prose(page)).toHaveText(expectedProse);
  await expect(
    page.getByRole("button", { name: "保存本机做法", exact: true }),
  ).toHaveCount(0);
  await page.goto(`/workflows/${conflict.id}/complete`);
  await expect(prose(page)).toHaveText(
    "冲突工作：服务器的正文不得被恢复按钮覆盖。",
  );
  const conflictNotice = page.locator(".complete-source-choice");
  await expect(conflictNotice).toHaveAttribute("role", "status");
  await expect(conflictNotice).toContainText("当前使用已保存的做法");
  await expect(prose(page)).not.toContainText("草稿");
  await expect(
    page.getByRole("button", { name: "保存本机做法", exact: true }),
  ).toHaveCount(0);
  const beforeChoice = await snapshot(page, org);
  await page.getByRole("button", { name: "查看本机草稿", exact: true }).click();
  await expect(prose(page)).toHaveText("冲突工作：本机另一份冲突正文。");
  await expect(conflictNotice).toContainText("当前查看本机草稿");
  expect(await snapshot(page, org)).toEqual(beforeChoice);
  expect(writes).toHaveLength(1);
  await page.emulateMedia({ media: "print" });
  await expect(conflictNotice).toBeHidden();
  await expect(prose(page)).toHaveText("冲突工作：本机另一份冲突正文。");
  await page.emulateMedia({ media: "screen" });
  await page
    .getByRole("button", { name: "使用已保存的做法", exact: true })
    .click();
  await expect(prose(page)).toHaveText(
    "冲突工作：服务器的正文不得被恢复按钮覆盖。",
  );
  expect(await snapshot(page, org)).toEqual(beforeChoice);
  expect(await read(page, org, conflict.id)).toEqual(conflict);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), conflictKey),
  ).toBe(conflictRaw);
  expect(writes).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("partial editor instructions autosave to the server and remain available after clearing local storage", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000);
  expect(baseURL).toBe("http://127.0.0.1:5174");
  await page.setViewportSize({ width: 1440, height: 1100 });
  const { org, user } = await setup(page, "部分做法自动保存"),
    { latest } = await framework(page, org);
  const versions = await get(
      page,
      `/api/orgs/${org}/sops/${latest.id}/versions`,
    ),
    errors: string[] = [],
    payloads: any[] = [],
    publishes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`/api/orgs/${org}/sops/save`)
    )
      payloads.push(request.postDataJSON());
    if (request.url().endsWith("/publish")) publishes.push(request.url());
  });
  await page.goto(`/workflows/${latest.id}/edit`);
  await waitForAutoSave(page);
  await page.getByRole("tab", { name: "写具体做法", exact: true }).click();
  await page.getByRole("button", { name: "添加一份做法", exact: true }).click();
  const named = page.getByRole("region", { name: "具体做法 1", exact: true });
  await named.getByLabel("对应的工作名称", { exact: true }).fill("清洁操作台");
  await named
    .getByRole("textbox", { name: "步骤 1", exact: true })
    .fill("服务器应当保存这条已经写好的做法。");
  await named.getByRole("button", { name: "添加步骤", exact: true }).click();
  await page.getByRole("button", { name: "添加一份做法", exact: true }).click();
  const unnamed = page.getByRole("region", { name: "具体做法 2", exact: true });
  await unnamed
    .getByRole("textbox", { name: "步骤 1", exact: true })
    .fill("还没起名字的文字也必须保留。");
  await waitForAutoSave(page);
  const partial = await read(page, org, latest.id),
    partialDetails = details(partial);
  expect(partialDetails).toHaveLength(2);
  expect(partialDetails[0].title).toBe("清洁操作台");
  expect(partialDetails[0].items!.map((item) => item.text)).toEqual([
    "服务器应当保存这条已经写好的做法。",
    "",
  ]);
  expect(partialDetails[1].title).toBe("");
  expect(partialDetails[1].items![0].text).toBe("还没起名字的文字也必须保留。");
  expect(partialDetails.every((item) => item.id)).toBe(true);
  expect(modules(partial)).toEqual(modules(latest));
  expect(partial.currentVersionId).toBe(latest.currentVersionId);
  expect(partial.status).toBe(latest.status);
  expect(partial.revision).toBeGreaterThan(latest.revision);
  expect(
    await get(page, `/api/orgs/${org}/sops/${latest.id}/versions`),
  ).toEqual(versions);
  const key = `workflow-os:editor:${user}:${org}:${latest.id}`;
  await page.evaluate((key) => {
    for (const item of Object.keys(localStorage))
      if (item === key || item.startsWith(`${key}:tab:`))
        localStorage.removeItem(item);
  }, key);
  const count = payloads.length;
  await page.goto(`/workflows/${latest.id}/complete`);
  expect(await localBackups(page, key)).toEqual([]);
  await expect(prose(page)).toHaveText(
    "09:20 整理工具。16:00 清洁操作台：服务器应当保存这条已经写好的做法。",
  );
  await expect(prose(page)).not.toContainText("这一步还没有填写");
  await expect(
    page.getByRole("button", { name: "保存本机做法", exact: true }),
  ).toHaveCount(0);
  await expect(prose(page)).not.toContainText("还没起名字的文字也必须保留。");
  expect(payloads).toHaveLength(count);
  await screenshot(page, "complete-server-partial-drafts-desktop");
  await page.goto(`/workflows/${latest.id}`);
  const move = page.getByRole("button", {
    name: "拖动工作 清洁操作台",
    exact: true,
  });
  await move.focus();
  await page.keyboard.press("Space", { delay: 80 });
  await expect(move).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight", { delay: 80 });
  const movedResponse = saveResponse(page, org);
  await page.keyboard.press("Space", { delay: 80 });
  expect((await movedResponse).ok()).toBe(true);
  const moved = await read(page, org, latest.id);
  expect(details(moved)).toEqual(partialDetails);
  expect(
    modules(moved).find((item) => item.id === "draft-module-a")!.frame!.x,
  ).toBeGreaterThan(
    modules(partial).find((item) => item.id === "draft-module-a")!.frame!.x,
  );
  expect(
    await get(page, `/api/orgs/${org}/sops/${latest.id}/versions`),
  ).toEqual(versions);
  expect(payloads.length).toBeGreaterThan(0);
  expect(payloads.every((payload) => payload.draftOnly === true)).toBe(true);
  expect(publishes).toEqual([]);
  expect(errors).toEqual([]);
});
