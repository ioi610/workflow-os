import { expect, type Page } from "@playwright/test";

export async function expectNoGlobalNavigation(page: Page) {
  await expect(
    page.locator("aside.sidebar, .sidebar, .app > header"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "主导航", exact: true }),
  ).toHaveCount(0);
  const layout = await page.locator(".handbook-app").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      x: bounds.x,
      y: bounds.y + window.scrollY,
      width: bounds.width,
      viewport: window.innerWidth,
      marginLeft: parseFloat(style.marginLeft),
      paddingTop: parseFloat(style.paddingTop),
      paddingBottom: parseFloat(style.paddingBottom),
      mainTop:
        (element.querySelector("main")?.getBoundingClientRect().y ?? 0) +
        window.scrollY,
      overflows: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  expect(layout.x).toBe(0);
  expect(layout.y).toBe(0);
  expect(layout.width).toBe(layout.viewport);
  expect(layout.marginLeft).toBe(0);
  expect(layout.paddingTop).toBe(0);
  expect(layout.paddingBottom).toBe(0);
  expect(layout.mainTop).toBe(0);
  expect(layout.overflows).toBe(false);
}

export async function expectWorkflowHome(page: Page) {
  const home = page.locator("main.workflow-library");
  await expect(home).toBeVisible();
  await expect(
    home.getByRole("heading", { name: "工作流程", exact: true }),
  ).toHaveCount(0);
  await expect(home.locator(".page-title")).toHaveCount(0);
  await expect(
    home.getByRole("region", { name: "工作流程列表", exact: true }),
  ).toBeVisible();
}

export async function createHandbookViaApi(page: Page, name: string) {
  // Fixtures belong to the isolated test instance; the daily-use library is untouched.
  expect(new URL(page.url()).origin).toBe("http://127.0.0.1:5174");
  const csrf = await (await page.request.get("/api/csrf")).json();
  const response = await page.request.post("/api/organizations", {
    headers: { [csrf.headerName]: csrf.token },
    data: { name },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const organization = await response.json();
  expect(organization.id).toBeTruthy();
  await page.evaluate((id) => localStorage.setItem("org", id), organization.id);
  await page.goto("/");
  await expectWorkflowHome(page);
  await expect(
    page
      .locator(".library-controls")
      .getByRole("combobox", { name: "切换工作内容", exact: true }),
  ).toHaveValue(organization.id);
  await expectNoGlobalNavigation(page);
  return organization.id as string;
}
