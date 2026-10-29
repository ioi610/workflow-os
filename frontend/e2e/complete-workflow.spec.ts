import { expect, test, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  createHandbookViaApi,
  expectNoGlobalNavigation,
  expectWorkflowHome,
} from "./handbook";

type Saved = {
  id: string;
  title: string;
  revision: number;
  draft: string;
  boardSettings?: string | null;
};
const complete = (page: Page) => page.getByRole("main");
const prose = (page: Page) => complete(page).locator(".complete-prose");
async function proseText(page: Page) {
  return (await prose(page).locator("p").allTextContents()).join("\n\n");
}
async function get(page: Page, path: string) {
  const response = await page.request.get(path);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function seed(page: Page, org: string, data: object): Promise<Saved> {
  const token = await get(page, "/api/csrf");
  const response = await page.request.post(`/api/orgs/${org}/sops/save`, {
    headers: { [token.headerName]: token.token },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function snapshot(page: Page, org: string) {
  const [sops, records, me] = await Promise.all([
    get(page, `/api/orgs/${org}/sops`),
    get(page, `/api/orgs/${org}/work-items`),
    get(page, "/api/auth/me"),
  ]);
  const ordered = (values: { id: string }[]) =>
    [...values].sort((a, b) => a.id.localeCompare(b.id));
  return {
    sops: ordered(sops),
    records: ordered(records),
    organizations: ordered(me.organizations),
    memberships: ordered(me.memberships),
    versions: await Promise.all(
      ordered(sops).map(async (item) => ({
        id: item.id,
        versions: await get(page, `/api/orgs/${org}/sops/${item.id}/versions`),
      })),
    ),
  };
}
async function open(page: Page, id: string) {
  await page.goto(`/workflows/${id}`);
  await page.getByRole("link", { name: "生成完整流程", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${id}/complete$`));
  await expect(complete(page)).toHaveAttribute("aria-label", "完整操作流程");
  await expect(complete(page).getByRole("heading", { level: 1 })).toBeVisible();
}
function precedes(text: string, first: string, last: string) {
  expect(text.indexOf(first)).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(last)).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(first)).toBeLessThan(text.indexOf(last));
}
async function screenshot(page: Page, name: string) {
  await expectNoGlobalNavigation(page);
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: `../docs/screenshots/${name}.png`,
    fullPage: true,
  });
}

test("complete prose preserves ordering and shared handwritten content without changing stored data across copy and print", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(90_000);
  expect(baseURL).toBe("http://127.0.0.1:5174");
  const errors: string[] = [],
    mutations: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL,
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/");
  await expectWorkflowHome(page);
  const org = await createHandbookViaApi(page, `完整操作流程-${Date.now()}`),
    token = await get(page, "/api/csrf");
  const upload = await page.request.post(`/api/orgs/${org}/files`, {
    headers: { [token.headerName]: token.token },
    multipart: {
      file: {
        name: "complete-reference.png",
        mimeType: "image/png",
        buffer: readFileSync("public/icon-192.png"),
      },
    },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  const media = await upload.json(),
    sharedText = "用酒精擦拭两遍，等待完全干燥。";
  const shared = await seed(page, org, {
    title: "共享消毒来源",
    category: "汇总验证",
    steps: [
      {
        kind: "DETAIL",
        id: "complete-shared-detail",
        title: "公共消毒步骤",
        items: [{ id: "complete-shared-line", text: sharedText }],
        materials: "75%酒精与无尘布",
        safetyNotice: "远离火源，先断电。",
        imageUrl: media.url,
        videoUrl: "https://example.com/disinfect-guide",
      },
    ],
  });
  const first = await seed(page, org, {
    title: "歧义来源一",
    steps: [
      {
        kind: "DETAIL",
        id: "ambiguous-one",
        title: "同名检查",
        items: [
          { id: "ambiguous-line-one", text: "歧义来源一的内容不能擅自选中。" },
        ],
      },
    ],
  });
  const second = await seed(page, org, {
    title: "歧义来源二",
    steps: [
      {
        kind: "DETAIL",
        id: "ambiguous-two",
        title: "同名检查",
        items: [
          { id: "ambiguous-line-two", text: "歧义来源二的内容不能擅自选中。" },
        ],
      },
    ],
  });
  const sharedModule = (id: string, title: string, x: number) => ({
    kind: "MODULE",
    id,
    title,
    frame: { x, y: 240, width: 100, height: 80 },
    detailWorkflowId: shared.id,
    detailName: "公共消毒步骤",
  });
  const timed = await seed(page, org, {
    title: "按真正时间汇总的完整流程",
    category: "汇总验证",
    boardSettings: JSON.stringify({
      version: 1,
      timeline: {
        enabled: true,
        startMinute: 480,
        endMinute: 1200,
        axis: "x",
        focus: { startOffset: 120, endOffset: 240, scale: 3 },
      },
      priority: { enabled: true, axis: "y" },
      canvas: { width: 820, height: 820 },
    }),
    steps: [
      {
        kind: "MODULE",
        id: "complete-late",
        title: "最后清理",
        frame: { x: 360, y: 650, width: 100, height: 80 },
      },
      sharedModule("complete-shared-b", "第二处消毒", 90),
      {
        kind: "MODULE",
        id: "complete-early",
        title: "先核对时钟",
        frame: { x: 57.9375, y: 40, width: 100, height: 80 },
      },
      sharedModule("complete-shared-a", "第一处消毒", 90),
      {
        kind: "DETAIL",
        id: "complete-early-detail",
        title: "先核对时钟",
        items: [
          { id: "complete-early-line", text: "核对墙上时钟与设备时间一致。" },
        ],
      },
      {
        kind: "DETAIL",
        id: "complete-late-detail",
        title: "最后清理",
        items: [{ id: "complete-late-line", text: "清理工作台后关闭照明。" }],
      },
    ],
  });
  const graph = await seed(page, org, {
    title: "箭头分支和汇合",
    category: "汇总验证",
    steps: [
      { kind: "MODULE", id: "graph-end", title: "结束复核", nextModuleIds: [] },
      {
        kind: "MODULE",
        id: "graph-join",
        title: "尚未填写的汇合检查",
        nextModuleIds: ["graph-end"],
      },
      {
        ...sharedModule("graph-left", "左侧消毒", 80),
        nextModuleIds: ["graph-join"],
      },
      {
        ...sharedModule("graph-right", "右侧消毒", 400),
        nextModuleIds: ["graph-join"],
      },
      {
        kind: "MODULE",
        id: "graph-start",
        title: "设备准备",
        nextModuleIds: ["graph-left", "graph-right"],
      },
      { kind: "MODULE", id: "graph-ambiguous", title: "同名检查" },
      {
        kind: "DETAIL",
        id: "graph-start-detail",
        title: "设备准备",
        items: [{ id: "graph-start-line", text: "先把设备断电。" }],
      },
      {
        kind: "DETAIL",
        id: "graph-end-detail",
        title: "结束复核",
        items: [{ id: "graph-end-line", text: "最后复核所有记录。" }],
      },
    ],
  });
  const cyclic = await seed(page, org, {
    title: "箭头成环需要提示",
    steps: [
      {
        kind: "MODULE",
        id: "cycle-a",
        title: "循环甲",
        nextModuleIds: ["cycle-b"],
      },
      {
        kind: "MODULE",
        id: "cycle-b",
        title: "循环乙",
        nextModuleIds: ["cycle-a"],
      },
    ],
  });
  const before = await snapshot(page, org);
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      /\/api\/(?:orgs\/[^/]+\/(?:sops|work-items|files)|organizations)/.test(
        request.url(),
      )
    )
      mutations.push(`${request.method()} ${request.url()}`);
  });

  const sharedProse = (name: string, time?: string) =>
    `${time ? `${time} ` : ""}${name}：75%酒精与无尘布，${sharedText}远离火源，先断电。`;
  const timedProse =
    "09:17 先核对时钟：核对墙上时钟与设备时间一致。" +
    sharedProse("第二处消毒", "10:00") +
    sharedProse("第一处消毒", "10:00") +
    "12:00 最后清理：清理工作台后关闭照明。";
  await test.step("a nonlinear time board adds each scheduled time to the original handwritten prose, repeating each shared occurrence", async () => {
    await open(page, timed.id);
    await expect(prose(page)).toHaveText(timedProse);
    await expect(prose(page).locator("ol, ul, li, a, img, video")).toHaveCount(
      0,
    );
    expect((await proseText(page)).split(sharedText)).toHaveLength(3);
    for (const name of ["第一处消毒", "第二处消毒"]) {
      precedes(await proseText(page), "先核对时钟", name);
      precedes(await proseText(page), name, "最后清理");
    }
    for (const omitted of [
      shared.title,
      "公共消毒步骤",
      media.url,
      "https://example.com/disinfect-guide",
    ])
      await expect(prose(page)).not.toContainText(omitted);
    await screenshot(page, "complete-workflow-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, "complete-workflow-mobile");
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByRole("button", { name: "复制全文", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "已复制", exact: true }),
    ).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(timedProse);
    expect(copied).toBe(await proseText(page));
    expect(copied).not.toContain(timed.title);
    expect(copied).not.toContain("https://example.com/disinfect-guide");
    expect(copied.split(sharedText)).toHaveLength(3);
    await page.reload();
    await expect(prose(page)).toHaveText(timedProse);
  });

  await test.step("printing invokes the browser and hides page controls in print media", async () => {
    await page.evaluate(() =>
      addEventListener(
        "beforeprint",
        () => document.body.setAttribute("data-before-print", "true"),
        { once: true },
      ),
    );
    await page.getByRole("button", { name: "打印", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute(
      "data-before-print",
      "true",
    );
    await page.emulateMedia({ media: "print" });
    await expect(complete(page).locator(".complete-tools")).toBeHidden();
    await expect(
      page.getByRole("button", { name: "打印", exact: true }),
    ).toBeHidden();
    await expect(prose(page)).toBeVisible();
    await expect(prose(page)).toHaveText(timedProse);
    await page.emulateMedia({ media: "screen" });
    await page.getByRole("link", { name: "返回流程", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${timed.id}$`));
  });

  await test.step("arrow dependencies preserve prose order without inventing missing, ambiguous, or cyclic instructions", async () => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await open(page, graph.id);
    await expect(prose(page)).toContainText("设备准备：先把设备断电。");
    const text = await proseText(page);
    for (const name of ["左侧消毒", "右侧消毒"]) {
      precedes(text, "设备准备", name);
      precedes(text, name, "尚未填写的汇合检查");
      expect(text).toContain(sharedProse(name));
    }
    precedes(text, "尚未填写的汇合检查", "结束复核");
    expect(text).toContain("尚未填写的汇合检查。");
    expect(text).toContain("同名检查。");
    expect(text).toContain("结束复核：最后复核所有记录。");
    expect(text.split(sharedText)).toHaveLength(3);
    await expect(prose(page)).not.toContainText(
      "歧义来源一的内容不能擅自选中。",
    );
    await expect(prose(page)).not.toContainText(
      "歧义来源二的内容不能擅自选中。",
    );
    await expect(prose(page).locator("ol, ul, li, a")).toHaveCount(0);
    for (const omitted of ["还没有找到", "无法确定", "连线衔接", "分支条件"])
      await expect(prose(page)).not.toContainText(omitted);
    await screenshot(page, "complete-workflow-branches-desktop");
    await open(page, cyclic.id);
    await expect(prose(page)).toHaveText("循环甲。循环乙。");
    await expect(prose(page)).not.toContainText("重复次数");
    await expect(prose(page)).not.toContainText("结束条件");
  });

  await test.step("the employee view cannot author missing instructions", async () => {
    const mockedRole = async (route: Route) => {
      const response = await route.fetch(),
        data = await response.json();
      data.memberships = data.memberships?.map(
        (item: { organizationId: string; role: string }) =>
          item.organizationId === org ? { ...item, role: "EMPLOYEE" } : item,
      );
      await route.fulfill({ response, json: data });
    };
    await page.route("**/api/auth/me", mockedRole);
    await page.route("**/api/personal/bootstrap", mockedRole);
    await page.goto(`/workflows/${graph.id}/complete`);
    await expect(prose(page)).toContainText("尚未填写的汇合检查。");
    await expect(complete(page).locator('a[href*="/edit"]')).toHaveCount(0);
    await expect(prose(page)).toContainText(sharedProse("左侧消毒"));
    await expect(
      page.getByRole("button", { name: "保存本机做法", exact: true }),
    ).toHaveCount(0);
    await page.unroute("**/api/auth/me", mockedRole);
    await page.unroute("**/api/personal/bootstrap", mockedRole);
  });
  expect(await snapshot(page, org)).toEqual(before);
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
  expect(first.id).not.toBe(second.id);
});

test("written actions form continuous prose and tied-work reading order drives copy and print without saving", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(60_000);
  expect(baseURL).toBe("http://127.0.0.1:5174");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL,
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  const errors: string[] = [],
    mutations: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expectWorkflowHome(page);
  const org = await createHandbookViaApi(page, `步骤衔接验证-${Date.now()}`);
  const procedure = (arrows: boolean) => [
    {
      kind: "MODULE",
      id: "procedure-a",
      title: "甲工作",
      frame: { x: 120, y: 60, width: 100, height: 80 },
      ...(arrows ? { nextModuleIds: ["procedure-b"] } : {}),
    },
    {
      kind: "MODULE",
      id: "procedure-b",
      title: "乙工作",
      frame: { x: 120, y: 400, width: 100, height: 80 },
    },
    {
      kind: "DETAIL",
      id: "procedure-detail-a",
      title: "甲工作",
      items: [
        { id: "a-one", text: "甲工作第一个动作：铺好垫布。" },
        { id: "a-two", text: "甲工作第二个动作：摆放工具。" },
      ],
    },
    {
      kind: "DETAIL",
      id: "procedure-detail-b",
      title: "乙工作",
      items: [
        { id: "b-one", text: "乙工作第一个动作：检查电源。" },
        { id: "b-two", text: "乙工作第二个动作：记录读数。" },
      ],
    },
  ];
  const settings = JSON.stringify({
    version: 1,
    timeline: { enabled: true, startMinute: 480, endMinute: 1200, axis: "x" },
    priority: { enabled: true, axis: "y" },
    canvas: { width: 820, height: 820 },
  });
  const linear = await seed(page, org, {
    title: "两份做法接成四步",
    category: "衔接验证",
    boardSettings: settings,
    steps: procedure(true),
  });
  const tied = await seed(page, org, {
    title: "并列工作可调整衔接顺序",
    category: "衔接验证",
    boardSettings: settings,
    steps: procedure(false),
  });
  const before = await snapshot(page, org);
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      /\/api\/(?:orgs\/[^/]+\/(?:sops|work-items)|organizations)/.test(
        request.url(),
      )
    )
      mutations.push(request.url());
  });
  await open(page, linear.id);
  const firstWork =
      "10:00 甲工作：甲工作第一个动作：铺好垫布。甲工作第二个动作：摆放工具。",
    secondWork =
      "10:00 乙工作：乙工作第一个动作：检查电源。乙工作第二个动作：记录读数。";
  await expect(prose(page)).toHaveText(firstWork + secondWork);
  await expect(prose(page).locator("ol, ul, li, a")).toHaveCount(0);
  await page.getByRole("button", { name: "调整衔接顺序", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "将 乙工作 提前", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "将 甲工作 推后", exact: true }),
  ).toBeDisabled();
  await screenshot(page, "connected-procedure-desktop");
  await page.getByRole("button", { name: "复制全文", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已复制", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    firstWork + secondWork,
  );

  await open(page, tied.id);
  await page.getByRole("button", { name: "调整衔接顺序", exact: true }).click();
  await page
    .getByRole("button", { name: "将 乙工作 提前", exact: true })
    .click();
  await expect(prose(page)).toHaveText(secondWork + firstWork);
  await screenshot(page, "connected-procedure-order-desktop");
  await page.reload();
  await expect(prose(page)).toHaveText(secondWork + firstWork);
  await page.getByRole("button", { name: "复制全文", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已复制", exact: true }),
  ).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const actions = [
    "乙工作第一个动作",
    "乙工作第二个动作",
    "甲工作第一个动作",
    "甲工作第二个动作",
  ];
  expect(copied).toBe(secondWork + firstWork);
  expect(copied).toBe(await proseText(page));
  expect(copied).not.toContain("建议阅读衔接");
  expect(copied).not.toMatch(/(?:^|\n)\d+\.\s/);
  actions.forEach((text, index) => {
    expect(copied).toContain(text);
    if (index)
      expect(copied.indexOf(actions[index - 1])).toBeLessThan(
        copied.indexOf(text),
      );
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, "connected-procedure-mobile");
  await page.evaluate(() =>
    addEventListener(
      "beforeprint",
      () => document.body.setAttribute("data-procedure-printed", "yes"),
      { once: true },
    ),
  );
  await page.getByRole("button", { name: "打印", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-procedure-printed",
    "yes",
  );
  await page.emulateMedia({ media: "print" });
  await expect(prose(page)).toBeVisible();
  await expect(prose(page)).toHaveText(secondWork + firstWork);
  await expect(complete(page).locator(".complete-tools")).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  expect(await snapshot(page, org)).toEqual(before);
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});
