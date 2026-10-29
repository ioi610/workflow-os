import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import {
  createHandbookViaApi,
  expectNoGlobalNavigation,
  expectWorkflowHome,
} from "./handbook";

type Frame = { x: number; y: number; width: number; height: number };
type Saved = {
  id: string;
  title: string;
  category: string;
  revision: number;
  draft: string;
  boardSettings: string;
};
type Entry = {
  id: string;
  kind: string;
  title: string;
  frame?: Frame;
  [key: string]: unknown;
};
type Edge = "left" | "right" | "top" | "bottom";
const board = (page: Page) =>
  page.getByRole("region", { name: "流程图", exact: true });
const canvas = (page: Page) => board(page).locator(".flow-board-canvas");
const tile = (page: Page) =>
  canvas(page).locator('.flow-tile[data-module-id="edge-work"]');
const badge = (page: Page) =>
  page.getByLabel("边界工作 的时间和优先级", { exact: true });
const entries = (saved: Saved) => JSON.parse(saved.draft) as Entry[];
async function read(page: Page, org: string, id: string): Promise<Saved> {
  const response = await page.request.get(`/api/orgs/${org}/sops`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).find((item: Saved) => item.id === id);
}
async function save(page: Page, org: string, data: object): Promise<Saved> {
  const csrf = await (await page.request.get("/api/csrf")).json();
  const response = await page.request.post(`/api/orgs/${org}/sops/save`, {
    headers: { [csrf.headerName]: csrf.token },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function gaps(page: Page) {
  return canvas(page).evaluate((element) => {
    const canvas = element as HTMLElement,
      bounds = canvas.getBoundingClientRect();
    const box = canvas
      .querySelector('.flow-tile[data-module-id="edge-work"]')!
      .getBoundingClientRect();
    const scale = bounds.width / canvas.offsetWidth;
    const left = bounds.left + canvas.clientLeft * scale,
      top = bounds.top + canvas.clientTop * scale;
    return {
      left: box.left - left,
      top: box.top - top,
      right: left + canvas.clientWidth * scale - box.right,
      bottom: top + canvas.clientHeight * scale - box.bottom,
    };
  });
}
async function setZoom(page: Page, value: number) {
  const current = await board(page)
    .locator(".flow-board-plane")
    .evaluate((element) =>
      Math.round(
        new DOMMatrixReadOnly(getComputedStyle(element).transform).a * 100,
      ),
    );
  const id = new URL(page.url()).pathname.match(/\/workflows\/([^/]+)/)![1];
  if ((value - current) % 10 !== 0) {
    await page.evaluate(
      ({ id, value }) =>
        localStorage.setItem(
          `workflow-os:board-zoom:${id}`,
          JSON.stringify({ version: 1, mode: "manual", scale: value / 100 }),
        ),
      { id, value },
    );
    await page.reload();
  } else {
    let next = current;
    while (next !== value) {
      await board(page)
        .getByRole("group", { name: "流程图缩放", exact: true })
        .getByRole("button", {
          name: next < value ? "放大" : "缩小",
          exact: true,
        })
        .click();
      next += next < value ? 10 : -10;
      await expect
        .poll(() =>
          board(page)
            .locator(".flow-board-plane")
            .evaluate(
              (element) =>
                new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
            ),
        )
        .toBeCloseTo(next / 100, 4);
    }
  }
}
async function dragToEdge(page: Page, edge: Edge) {
  const handle = page.getByRole("button", {
    name: "拖动工作 边界工作",
    exact: true,
  });
  await handle.scrollIntoViewIfNeeded();
  const hit = await handle.evaluate((element) => {
    const box = element.getBoundingClientRect(),
      target = document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
    return {
      reachable: target === element || element.contains(target),
      target: target?.closest("button")?.getAttribute("aria-label"),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
    };
  });
  expect(hit.reachable, JSON.stringify(hit)).toBe(true);
  const grip = (await handle.boundingBox())!;
  const scale = await canvas(page).evaluate(
    (element) =>
      element.getBoundingClientRect().width /
      (element as HTMLElement).offsetWidth,
  );
  const from = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(
    from.x + (edge === "left" ? -80 : edge === "right" ? 80 : 0) * scale,
    from.y + (edge === "top" ? -80 : edge === "bottom" ? 80 : 0) * scale,
    { steps: 12 },
  );
  const preview = {
    gap: (await gaps(page))[edge],
    time: await badge(page).getAttribute("data-axis-time"),
    priority: await badge(page).getAttribute("data-axis-priority"),
  };
  return { hit, preview };
}
const detail = {
  kind: "DETAIL",
  id: "edge-detail",
  title: "边界工作",
  items: [{ id: "edge-step", text: "保留这份边界工作的原始做法。" }],
  materials: "原参考资料",
};

test("work edges reach all axis endpoints across box sizes and whole-board zoom", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBe("http://127.0.0.1:5174");
  const errors: string[] = [],
    observations: object[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/");
  await expectWorkflowHome(page);
  const org = await createHandbookViaApi(page, `坐标边缘验证-${Date.now()}`);
  for (const size of [32, 56, 164, 656]) {
    let current = await save(page, org, {
      title: `${size}像素方框`,
      category: "边界验证",
      boardSettings: JSON.stringify({
        version: 1,
        timeline: {
          enabled: true,
          startMinute: 480,
          endMinute: 1200,
          axis: "x",
        },
        priority: { enabled: true, axis: "y" },
        canvas: { width: 820, height: 820 },
      }),
      steps: [
        {
          kind: "MODULE",
          id: "edge-work",
          title: "边界工作",
          frame: { x: 20, y: 20, width: size, height: size },
          nextModuleIds: ["edge-target"],
          connectionPorts: {
            "edge-target": { source: "right", target: "top" },
          },
        },
        {
          kind: "MODULE",
          id: "edge-target",
          title: "下一项",
          frame: { x: 700, y: 700, width: 80, height: 80 },
        },
        detail,
      ],
    });
    const recordsBefore = await (
      await page.request.get(`/api/orgs/${org}/work-items`)
    ).json();
    for (const zoom of [75, 50, 200] as const)
      for (const edge of ["right", "left", "top", "bottom"] as const) {
        const limit = 820 - size;
        const frame: Frame = {
          x: edge === "left" ? 20 : edge === "right" ? limit - 20 : limit / 2,
          y: edge === "top" ? 20 : edge === "bottom" ? limit - 20 : limit / 2,
          width: size,
          height: size,
        };
        current = await save(page, org, {
          id: current.id,
          title: current.title,
          category: current.category,
          expectedRevision: current.revision,
          boardSettings: current.boardSettings,
          steps: entries(current).map((item) =>
            item.id === "edge-work" ? { ...item, frame } : item,
          ),
        });
        await page.goto(`/workflows/${current.id}`);
        await expect(canvas(page)).toBeVisible();
        await setZoom(page, zoom);
        if (size <= 56 && edge === "left") {
          const buttons = tile(page).getByRole("button");
          await expect(buttons).toHaveCount(8);
          for (const button of await buttons.all()) {
            await button.scrollIntoViewIfNeeded();
            const hit = await button.evaluate((element) => {
              const box = element.getBoundingClientRect(),
                target = document.elementFromPoint(
                  box.x + box.width / 2,
                  box.y + box.height / 2,
                );
              return {
                name: element.getAttribute("aria-label"),
                reachable: target === element || element.contains(target),
                target: target?.getAttribute("aria-label"),
              };
            });
            expect(hit.reachable, JSON.stringify({ size, zoom, ...hit })).toBe(
              true,
            );
          }
        }
        const observed = await dragToEdge(page, edge);
        const response = page
          .waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              response.url().endsWith(`/api/orgs/${org}/sops/save`),
            { timeout: 3000 },
          )
          .catch(() => null);
        await page.mouse.up();
        const saved = await response;
        expect(
          saved,
          JSON.stringify({ size, zoom, edge, observed }),
        ).toBeTruthy();
        expect(saved!.ok()).toBe(true);
        await expect(tile(page)).not.toHaveClass(/is-dragging/);
        await expect(board(page)).not.toHaveClass(/is-moving-work/);
        const pencil = tile(page).getByRole("button", {
          name: "给 边界工作 改名",
          exact: true,
        });
        await expect(pencil).toBeEnabled();
        expect(
          await pencil.evaluate(
            (element) => getComputedStyle(element).pointerEvents,
          ),
        ).not.toBe("none");
        current = await read(page, org, current.id);
        const persisted = entries(current).find(
          (item) => item.id === "edge-work",
        )!;
        const record = {
          size,
          zoom,
          edge,
          ...observed,
          saved: !!saved,
          frame: persisted.frame,
          gap: (await gaps(page))[edge],
          time: await badge(page).getAttribute("data-axis-time"),
          priority: await badge(page).getAttribute("data-axis-priority"),
        };
        observations.push(record);
        writeFileSync(
          test.info().outputPath("axis-edge-observations.json"),
          JSON.stringify(observations, null, 2),
        );
        expect(observed.hit.reachable, JSON.stringify(record)).toBe(true);
        expect(
          Math.abs(record.gap),
          JSON.stringify(record),
        ).toBeLessThanOrEqual(1);
        expect(
          persisted.frame![edge === "left" || edge === "right" ? "x" : "y"],
        ).toBeCloseTo(edge === "left" || edge === "top" ? 0 : limit, 5);
        {
          const time =
            edge === "left" ? "08:00" : edge === "right" ? "20:00" : "14:00";
          const priority =
            edge === "top"
              ? "优先做"
              : edge === "bottom"
                ? "可以稍后"
                : "正常安排";
          expect(record.preview.time).toBe(time);
          expect(record.preview.priority).toBe(priority);
          expect(record.time).toBe(time);
          expect(record.priority).toBe(priority);
          await page.reload();
          await expect(badge(page)).toHaveAttribute("data-axis-time", time);
          await expect(badge(page)).toHaveAttribute(
            "data-axis-priority",
            priority,
          );
          expect(
            entries(current).find((item) => item.id === detail.id),
          ).toEqual(detail);
          expect(persisted.connectionPorts).toEqual({
            "edge-target": { source: "right", target: "top" },
          });
          const recordsAfter = await (
            await page.request.get(`/api/orgs/${org}/work-items`)
          ).json();
          expect(
            recordsAfter.map((item: { id: string }) => item.id).sort(),
          ).toEqual(
            recordsBefore.map((item: { id: string }) => item.id).sort(),
          );
        }
      }
  }
  await test.step("swapped axes keep cross-midnight endpoints reachable by phone touch and full-board work stays at the start", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    let current = await save(page, org, {
      title: "手机跨日边缘",
      category: "边界验证",
      boardSettings: JSON.stringify({
        version: 1,
        timeline: {
          enabled: true,
          startMinute: 1320,
          endMinute: 360,
          axis: "y",
        },
        priority: { enabled: true, axis: "x" },
      }),
      steps: [
        {
          kind: "MODULE",
          id: "edge-work",
          title: "边界工作",
          frame: { x: 328, y: 636, width: 164, height: 164 },
        },
        detail,
      ],
    });
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 1,
      });
      for (const edge of ["bottom", "right"] as const) {
        const frame = {
          x: edge === "right" ? 636 : 328,
          y: edge === "bottom" ? 636 : 328,
          width: 164,
          height: 164,
        };
        current = await save(page, org, {
          id: current.id,
          title: current.title,
          category: current.category,
          expectedRevision: current.revision,
          boardSettings: current.boardSettings,
          steps: entries(current).map((item) =>
            item.id === "edge-work" ? { ...item, frame } : item,
          ),
        });
        await page.goto(`/workflows/${current.id}`);
        await setZoom(page, 100);
        const handle = page.getByRole("button", {
          name: "拖动工作 边界工作",
          exact: true,
        });
        await handle.scrollIntoViewIfNeeded();
        const box = (await handle.boundingBox())!,
          from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ ...from, id: 1 }],
        });
        await page.waitForTimeout(250);
        for (let i = 1; i <= 12; i++)
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [
              {
                x: from.x + (edge === "right" ? (80 * i) / 12 : 0),
                y: from.y + (edge === "bottom" ? (80 * i) / 12 : 0),
                id: 1,
              },
            ],
          });
        const time = edge === "bottom" ? "次日 06:00" : "次日 02:00",
          priority = edge === "right" ? "可以稍后" : "正常安排";
        await expect(badge(page)).toHaveAttribute("data-axis-time", time);
        await expect(badge(page)).toHaveAttribute(
          "data-axis-priority",
          priority,
        );
        const saved = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().endsWith(`/api/orgs/${org}/sops/save`),
        );
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        expect((await saved).ok()).toBe(true);
        current = await read(page, org, current.id);
        expect(
          entries(current).find((item) => item.id === "edge-work")!.frame![
            edge === "right" ? "x" : "y"
          ],
        ).toBeCloseTo(656, 5);
        await page.reload();
        await expect(badge(page)).toHaveAttribute("data-axis-time", time);
        await expect(badge(page)).toHaveAttribute(
          "data-axis-priority",
          priority,
        );
        await expectNoGlobalNavigation(page);
      }
    } finally {
      await cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: false,
      });
      await cdp.detach();
    }
    await page.setViewportSize({ width: 1440, height: 1200 });
    current = await save(page, org, {
      title: "大方框末端",
      category: "边界验证",
      boardSettings: JSON.stringify({
        version: 1,
        timeline: {
          enabled: true,
          startMinute: 480,
          endMinute: 1200,
          axis: "x",
        },
        priority: { enabled: true, axis: "y" },
      }),
      steps: [
        {
          kind: "MODULE",
          id: "edge-work",
          title: "边界工作",
          frame: { x: 144, y: 144, width: 656, height: 656 },
        },
        detail,
      ],
    });
    await page.goto(`/workflows/${current.id}`);
    await setZoom(page, 100);
    for (const edge of ["right", "bottom"] as const) {
      await dragToEdge(page, edge);
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`/api/orgs/${org}/sops/save`),
      );
      await page.mouse.up();
      expect((await saved).ok()).toBe(true);
    }
    await expect(badge(page)).toHaveAttribute("data-axis-time", "20:00");
    await expect(badge(page)).toHaveAttribute("data-axis-priority", "可以稍后");
    await badge(page).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "../docs/screenshots/axis-edge-large-end-desktop.png",
      fullPage: true,
    });
    await badge(page).screenshot({
      path: "../docs/screenshots/axis-edge-large-end-badge.png",
    });
    current = await read(page, org, current.id);
    const full = await save(page, org, {
      id: current.id,
      title: current.title,
      category: current.category,
      expectedRevision: current.revision,
      boardSettings: current.boardSettings,
      steps: entries(current).map((item) =>
        item.id === "edge-work"
          ? { ...item, frame: { x: 0, y: 0, width: 820, height: 820 } }
          : item,
      ),
    });
    await page.goto(`/workflows/${full.id}`);
    await expect(badge(page)).toHaveAttribute("data-axis-time", "08:00");
    await expect(badge(page)).toHaveAttribute("data-axis-priority", "优先做");
  });
  expect(errors).toEqual([]);
});
