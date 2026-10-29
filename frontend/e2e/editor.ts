import { expect, type Page } from "@playwright/test";

export const autoSaveStatus = (page: Page) =>
  page.getByRole("status", { name: "自动保存状态", exact: true });

export async function waitForAutoSave(page: Page) {
  await expect(autoSaveStatus(page)).toHaveText("已自动保存", {
    timeout: 15_000,
  });
}

export async function finishWorkflowEditing(page: Page) {
  await expect(
    page.getByRole("button", { name: "保存流程", exact: true }),
  ).toHaveCount(0);
  if (new URL(page.url()).pathname.endsWith("/new"))
    await page.getByRole("button", { name: "添加流程", exact: true }).click();
  else {
    await waitForAutoSave(page);
    await page.getByRole("link", { name: "返回流程", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/workflows\/[a-f0-9-]{36}$/);
  return page.url();
}
