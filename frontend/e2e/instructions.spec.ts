import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { waitForAutoSave } from "./editor";
import {
  createHandbookViaApi,
  expectNoGlobalNavigation,
  expectWorkflowHome,
} from "./handbook";

type Saved = {
  id: string;
  title: string;
  category: string;
  revision: number;
  draft: string;
  boardSettings?: string | null;
};
type Entry = {
  id: string;
  kind: string;
  title: string;
  items?: { id: string; text: string }[];
  [key: string]: unknown;
};
const board = (page: Page) =>
  page.getByRole("region", { name: "流程图", exact: true });
const documentEditor = (page: Page) =>
  page.getByRole("region", { name: /^具体做法 \d+$/ });
const entries = (saved: Saved) => JSON.parse(saved.draft) as Entry[];
const nextSave = (page: Page, org: string) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${org}/sops/save`),
  );
async function read(page: Page, org: string, id: string): Promise<Saved> {
  const response = await page.request.get(`/api/orgs/${org}/sops`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).find((item: Saved) => item.id === id);
}
async function seed(page: Page, org: string, data: object): Promise<Saved> {
  const csrf = await (await page.request.get("/api/csrf")).json();
  const response = await page.request.post(`/api/orgs/${org}/sops/save`, {
    headers: { [csrf.headerName]: csrf.token },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function scoped(page: Page, name: string) {
  const creating = new URL(page.url()).pathname.endsWith("/new");
  await expect(documentEditor(page)).toHaveCount(1);
  await expect(
    documentEditor(page).getByLabel("对应的工作名称", { exact: true }),
  ).toHaveValue(name);
  await expect(
    page.getByRole("heading", { name: "流程信息", exact: true }),
  ).toHaveCount(creating ? 1 : 0);
  await expect(page.getByLabel("流程名称", { exact: true })).toHaveCount(
    creating ? 1 : 0,
  );
  await expect(
    page.getByRole("tab", { name: "安排工作", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "写具体做法", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "添加一份做法", exact: true }),
  ).toHaveCount(0);
  await expect(board(page)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function switchQuery(page: Page, name: string) {
  await page.evaluate((name) => {
    const url = new URL(location.href);
    url.searchParams.set("detail", name);
    url.searchParams.delete("detailId");
    history.pushState(null, "", url);
    dispatchEvent(new PopStateEvent("popstate"));
  }, name);
  await scoped(page, name);
}
async function screenshot(page: Page, name: string) {
  await expectNoGlobalNavigation(page);
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: `../docs/screenshots/${name}.png`,
    fullPage: true,
  });
}

test("a work opens only its own instructions and scoped edits preserve every other document", async ({
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
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/");
  await expectWorkflowHome(page);
  const org = await createHandbookViaApi(page, `单项做法验证-${Date.now()}`);
  const csrf = await (await page.request.get("/api/csrf")).json();
  const upload = await page.request.post(`/api/orgs/${org}/files`, {
    headers: { [csrf.headerName]: csrf.token },
    multipart: {
      file: {
        name: "reference.png",
        mimeType: "image/png",
        buffer: readFileSync("public/icon-192.png"),
      },
    },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  const media = await upload.json();
  const first = "准备工具",
    second = "收好工具",
    missing = "检查设备";
  const textA = "把工具放在蓝色托盘内。",
    textB = "把用过的工具擦干后放回收纳盒。";
  const source = await seed(page, org, {
    title: "共享来源",
    category: "隔离验证",
    steps: [
      {
        kind: "DETAIL",
        id: "shared-method",
        title: "原始检查",
        items: [{ id: "shared-line", text: "按共享来源的清单检查电源。" }],
      },
    ],
  });
  const detailA = {
    kind: "DETAIL",
    id: "only-a",
    title: first,
    items: [{ id: "line-a", text: textA }],
    materials: "蓝色托盘",
    safetyNotice: "尖锐部分朝内。",
  };
  const detailB = {
    kind: "DETAIL",
    id: "only-b",
    title: second,
    items: [{ id: "line-b", text: textB }],
    imageUrl: media.url,
    videoUrl: "https://example.com/store-tools",
    customField: "另一项工作的保留字段",
  };
  const original = await seed(page, org, {
    title: "每项工作各自的做法",
    category: "隔离验证",
    boardSettings: JSON.stringify({
      version: 1,
      timeline: { enabled: false, startMinute: 480, endMinute: 1200 },
      priority: { enabled: false },
    }),
    steps: [
      {
        kind: "MODULE",
        id: "work-a",
        title: first,
        frame: { x: 40, y: 40, width: 164, height: 164 },
        nextModuleIds: ["work-b"],
        connectionPorts: { "work-b": { source: "bottom", target: "top" } },
      },
      {
        kind: "MODULE",
        id: "work-b",
        title: second,
        frame: { x: 320, y: 320, width: 164, height: 164 },
      },
      {
        kind: "MODULE",
        id: "work-missing",
        title: missing,
        frame: { x: 580, y: 40, width: 164, height: 164 },
      },
      {
        kind: "MODULE",
        id: "work-shared",
        title: "外部检查",
        frame: { x: 40, y: 540, width: 164, height: 164 },
        detailWorkflowId: source.id,
        detailName: "原始检查",
      },
      detailA,
      detailB,
    ],
  });
  const path = `/workflows/${original.id}`;
  const modulesBefore = entries(original).filter(
    (item) => item.kind === "MODULE",
  );
  const recordsBefore = await (
    await page.request.get(`/api/orgs/${org}/work-items`)
  ).json();

  await test.step("readers show one document and opening a missing document goes directly to a blank scoped editor", async () => {
    await page.goto(path);
    const before = saves.length;
    await board(page).getByRole("link", { name: first, exact: true }).click();
    await expect(page.getByText(textA, { exact: true })).toBeVisible();
    await expect(page.getByText(textB, { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "其他工作", exact: true }),
    ).toHaveCount(0);
    await screenshot(page, "single-instructions-reader-desktop");
    await page.getByRole("link", { name: /返回流程$/ }).click();
    await board(page).getByRole("link", { name: missing, exact: true }).click();
    await expect(page).toHaveURL(/\/edit\?/);
    await scoped(page, missing);
    await expect(
      documentEditor(page).getByRole("textbox", {
        name: "步骤 1",
        exact: true,
      }),
    ).toHaveValue("");
    await expect(
      page.getByRole("heading", { name: "还没写这项工作的做法", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "写具体做法", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(textA, { exact: true })).toHaveCount(0);
    await screenshot(page, "single-instructions-empty-desktop");
    expect(saves).toHaveLength(before);
    expect((await read(page, org, original.id)).revision).toBe(
      original.revision,
    );
  });

  await test.step("leaving an untouched empty form does not pollute another work, and saving changes only its selected document", async () => {
    await page.getByRole("link", { name: /返回流程$/ }).click();
    await board(page).getByRole("link", { name: second, exact: true }).click();
    await page.getByRole("link", { name: "修改具体做法", exact: true }).click();
    await scoped(page, second);
    await expect(
      documentEditor(page).getByRole("textbox", {
        name: "步骤 1",
        exact: true,
      }),
    ).toHaveValue(textB);
    await expect(
      page.getByRole("textbox", { name: "步骤 1", exact: true }),
    ).toHaveCount(1);
    const saved = nextSave(page, org);
    await documentEditor(page)
      .getByRole("textbox", { name: "步骤 1", exact: true })
      .fill("擦干工具，检查数量，再放回收纳盒。");
    expect((await saved).ok()).toBe(true);
    await waitForAutoSave(page);
    const changed = await read(page, org, original.id);
    expect(entries(changed).filter((item) => item.kind === "MODULE")).toEqual(
      modulesBefore,
    );
    expect(entries(changed).find((item) => item.id === detailA.id)).toEqual(
      detailA,
    );
    expect(
      entries(changed).filter((item) => item.kind === "DETAIL"),
    ).toHaveLength(2);
    expect(
      entries(changed).find((item) => item.id === detailB.id),
    ).toMatchObject({
      ...detailB,
      items: [{ id: "line-b", text: "擦干工具，检查数量，再放回收纳盒。" }],
    });
    expect(changed.boardSettings).toBe(original.boardSettings);
    await switchQuery(page, first);
    await expect(
      documentEditor(page).getByRole("textbox", {
        name: "步骤 1",
        exact: true,
      }),
    ).toHaveValue(textA);
    await switchQuery(page, second);
    await expect(
      documentEditor(page).getByRole("textbox", {
        name: "步骤 1",
        exact: true,
      }),
    ).toHaveValue("擦干工具，检查数量，再放回收纳盒。");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("detailId"))
      .toBe(detailB.id);
    const id = new URL(page.url()).searchParams.get("detailId");
    expect(id).toBe(detailB.id);
    const renamed = nextSave(page, org);
    await documentEditor(page)
      .getByLabel("对应的工作名称", { exact: true })
      .fill("工具归位做法");
    expect((await renamed).ok()).toBe(true);
    await waitForAutoSave(page);
    await page.reload();
    await scoped(page, "工具归位做法");
    await waitForAutoSave(page);
    expect(new URL(page.url()).searchParams.get("detailId")).toBe(id);
    const refreshed = entries(await read(page, org, original.id)).filter(
      (item) => item.kind === "DETAIL",
    );
    expect(refreshed).toHaveLength(2);
    expect(refreshed.find((item) => item.id === id)!.title).toBe(
      "工具归位做法",
    );
  });

  await test.step("a new missing method saves only its own content, while shared aliases edit the actual source", async () => {
    await page.goto(path);
    await board(page).getByRole("link", { name: missing, exact: true }).click();
    await scoped(page, missing);
    const before = await read(page, org, original.id);
    const saved = nextSave(page, org);
    await documentEditor(page)
      .getByRole("textbox", { name: "步骤 1", exact: true })
      .fill("先关闭设备电源，再检查插头。");
    expect((await saved).ok()).toBe(true);
    await waitForAutoSave(page);
    const changed = await read(page, org, original.id);
    for (const item of entries(before))
      expect(entries(changed).find((entry) => entry.id === item.id)).toEqual(
        item,
      );
    await page.getByRole("link", { name: /返回流程$/ }).click();
    await board(page).getByRole("link", { name: first, exact: true }).click();
    await expect(page.getByText(textA, { exact: true })).toBeVisible();
    await expect(
      page.getByText("先关闭设备电源，再检查插头。", { exact: true }),
    ).toHaveCount(0);
    await page.goto(path);
    await board(page)
      .getByRole("link", { name: "外部检查", exact: true })
      .click();
    await expect(
      page.getByText("按共享来源的清单检查电源。", { exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "修改具体做法", exact: true }).click();
    await scoped(page, "原始检查");
    expect(new URL(page.url()).pathname).toBe(`/workflows/${source.id}/edit`);
    expect(new URL(page.url()).searchParams.get("from")).toBe(original.id);
    const sourceSaved = nextSave(page, org);
    await documentEditor(page)
      .getByRole("textbox", { name: "步骤 1", exact: true })
      .fill("关闭电源后，按共享清单检查插头。");
    expect((await sourceSaved).ok()).toBe(true);
    await waitForAutoSave(page);
    await page.getByRole("link", { name: /返回流程$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${original.id}$`));
    await board(page)
      .getByRole("link", { name: "外部检查", exact: true })
      .click();
    await expect(
      page.getByText("关闭电源后，按共享清单检查插头。", { exact: true }),
    ).toBeVisible();
    const records = await (
      await page.request.get(`/api/orgs/${org}/work-items`)
    ).json();
    expect(records.map((item: { id: string }) => item.id).sort()).toEqual(
      recordsBefore.map((item: { id: string }) => item.id).sort(),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, "single-instructions-reader-mobile");
    await page.getByRole("link", { name: "修改具体做法", exact: true }).click();
    await scoped(page, "原始检查");
    await screenshot(page, "single-instructions-editor-mobile");
  });

  await test.step("new draft work selection isolates each method and keeps explicit creation", async () => {
    await page.goto("/workflows/new");
    await page.getByLabel("流程名称", { exact: true }).fill("新建时逐项写做法");
    const count = saves.length;
    for (const name of ["新工作甲", "新工作乙"]) {
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
    await board(page)
      .getByRole("link", { name: "新工作甲", exact: true })
      .click();
    await scoped(page, "新工作甲");
    await documentEditor(page)
      .getByRole("textbox", { name: "步骤 1", exact: true })
      .fill("只属于新工作甲的做法。");
    await page
      .getByRole("button", { name: "返回安排工作", exact: true })
      .click();
    await board(page)
      .getByRole("link", { name: "新工作乙", exact: true })
      .click();
    await scoped(page, "新工作乙");
    await expect(
      documentEditor(page).getByRole("textbox", {
        name: "步骤 1",
        exact: true,
      }),
    ).toHaveValue("");
    await documentEditor(page)
      .getByRole("textbox", { name: "步骤 1", exact: true })
      .fill("只属于新工作乙的做法。");
    await page
      .getByRole("button", { name: "返回安排工作", exact: true })
      .click();
    await board(page)
      .getByRole("link", { name: "新工作甲", exact: true })
      .click();
    await scoped(page, "新工作甲");
    await expect(
      documentEditor(page).getByRole("textbox", {
        name: "步骤 1",
        exact: true,
      }),
    ).toHaveValue("只属于新工作甲的做法。");
    expect(saves).toHaveLength(count);
    await page.getByRole("button", { name: "添加流程", exact: true }).click();
    await expect(page).toHaveURL(/\/workflows\/[a-f0-9-]{36}$/);
    await board(page)
      .getByRole("link", { name: "新工作乙", exact: true })
      .click();
    await expect(
      page.getByText("只属于新工作乙的做法。", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("只属于新工作甲的做法。", { exact: true }),
    ).toHaveCount(0);
  });

  await test.step("the employee UI cannot create a missing method", async () => {
    const before = saves.length;
    const mockedRole = async (route: any) => {
      const response = await route.fetch();
      const data = await response.json();
      data.memberships = data.memberships?.map((item: any) =>
        item.organizationId === org ? { ...item, role: "EMPLOYEE" } : item,
      );
      await route.fulfill({ response, json: data });
    };
    await page.route("**/api/auth/me", mockedRole);
    await page.route("**/api/personal/bootstrap", mockedRole);
    await page.goto(
      `/workflows/${original.id}/steps?name=${encodeURIComponent("员工没有的做法")}`,
    );
    await expect(
      page.getByText("还没有写这项工作的做法。", { exact: true }),
    ).toBeVisible();
    await expect(documentEditor(page)).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "写具体做法", exact: true }),
    ).toHaveCount(0);
    expect(saves).toHaveLength(before);
    await page.unroute("**/api/auth/me", mockedRole);
    await page.unroute("**/api/personal/bootstrap", mockedRole);
  });
  expect(errors).toEqual([]);
});
