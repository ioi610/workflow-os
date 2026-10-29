import { afterEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("routes the installed app through persistent storage without any HTTP request", async () => {
  vi.stubEnv("VITE_LOCAL_APP", "true");
  vi.stubGlobal("indexedDB", new IDBFactory());
  const network = vi.fn(() => {
    throw new Error("Standalone app must not depend on a server");
  });
  vi.stubGlobal("fetch", network);
  vi.resetModules();
  const { api } = await import("./api");
  expect(await api("/mode")).toMatchObject({ personalMode: true });
  const session = await api("/personal/bootstrap", {});
  const org = session.defaultOrganizationId;
  const workflow = await api(`/orgs/${org}/sops/save`, {
    title: "离线流程",
    category: "日常",
    steps: [
      {
        kind: "MODULE",
        id: "m1",
        title: "整理材料",
        frame: { x: 0, y: 0, width: 120, height: 80 },
        detailId: "d1",
      },
      {
        kind: "DETAIL",
        id: "d1",
        title: "整理材料",
        items: [{ id: "i1", text: "把材料按用途放好。" }],
      },
    ],
    draftOnly: true,
  });
  const rows = await api(`/orgs/${org}/sops`);
  expect(rows[0].id).toBe(workflow.id);
  expect(rows[0].draft).toContain("把材料按用途放好。");
  expect((await api(`/orgs/${org}/work-items`))[0].name).toBe("整理材料");
  expect(network).not.toHaveBeenCalled();
});
