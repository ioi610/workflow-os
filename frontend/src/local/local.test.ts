import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { createLocalAdapter, inspectImage } from "./index";
import {
  applyLocalRequest,
  initialLocalState,
  type LocalEnvironment,
  type LocalState,
  type LocalWorkflow,
  type LocalWorkItem,
} from "./core";

let sequence = 0;
const env: LocalEnvironment = {
  id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  now: () => "2026-10-29T00:00:00.000Z",
};
const closers: Array<() => Promise<void>> = [];
const adapter = (factory = new IDBFactory(), databaseName = "local-test") => {
  const local = createLocalAdapter({
    indexedDB: factory,
    databaseName,
    environment: env,
  });
  closers.push(local.close);
  return local;
};
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const steps = [
  {
    kind: "MODULE",
    id: "m1",
    title: "切葱",
    frame: { x: 12, y: 20, width: 120, height: 80 },
    detailId: "d1",
    nextModuleIds: ["m2"],
    connectionPorts: { m2: { source: "left", target: "top" } },
    extra: { preserve: true },
  },
  {
    kind: "MODULE",
    id: "m2",
    title: "下锅",
    frame: { x: 220, y: 120, width: 100, height: 80 },
  },
  {
    kind: "DETAIL",
    id: "d1",
    title: "切葱",
    description: "先洗干净。",
    items: [{ id: "i1", text: "把葱切成小段。" }],
    custom: "保留用户字段",
  },
];
const settings = JSON.stringify({
  version: 1,
  timeline: {
    enabled: true,
    axis: "y",
    startMinute: 480,
    endMinute: 1200,
    segments: [{ startOffset: 0, endOffset: 60, scale: 3 }],
  },
  priority: { enabled: true, axis: "x" },
  canvas: { width: 900, height: 1200 },
  referenceCanvas: { width: 820, height: 820 },
  custom: { preserve: "exact" },
});
async function start(local: ReturnType<typeof adapter>) {
  return local.requestLocal<{
    user: { id: string };
    defaultOrganizationId: string;
    memberships: Array<{ role: string }>;
  }>("/personal/bootstrap", {});
}
async function save(
  local: ReturnType<typeof adapter>,
  org: string,
  extra = {},
) {
  return local.requestLocal<LocalWorkflow>(`/orgs/${org}/sops/save`, {
    title: "做饭",
    category: "日常",
    steps,
    boardSettings: settings,
    draftOnly: true,
    ...extra,
  });
}

describe("standalone local database", () => {
  it("preserves all 33 boxes, individual instructions and origin metadata exactly", async () => {
    const local = adapter();
    const { defaultOrganizationId: org } = await start(local);
    const manySteps = Array.from({ length: 33 }, (_, index) => [
      {
        kind: "MODULE",
        id: `module-${index}`,
        title: `工作 ${index + 1}`,
        detailId: `detail-${index}`,
        frame: {
          x: (index % 6) * 140,
          y: Math.floor(index / 6) * 140,
          width: 100,
          height: 100,
        },
        nextModuleIds: index < 32 ? [`module-${index + 1}`] : [],
        ...(index === 0
          ? {
              workflowOSOriginalText: {
                version: 1,
                text: "用户复制的全文",
                signature: "原样保留",
              },
            }
          : {}),
      },
      {
        kind: "DETAIL",
        id: `detail-${index}`,
        title: `工作 ${index + 1}`,
        items: [
          { id: `item-${index}`, text: `第 ${index + 1} 项工作的具体做法。` },
        ],
      },
    ]).flat();
    const saved = await save(local, org, { steps: manySteps });
    expect(JSON.parse(saved.draft)).toEqual(manySteps);
    const listed = await local.requestLocal<LocalWorkItem[]>(
      `/orgs/${org}/work-items`,
    );
    expect(listed).toHaveLength(33);
    expect(new Set(listed.map((item) => item.id)).size).toBe(33);
  });
  it("reopens a stable personal identity and complete graph without a backend or bulk localStorage", async () => {
    const fetch = vi.fn(() => {
      throw new Error("不应联网");
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("不应读取");
      },
      setItem: () => {
        throw new Error("不应写入");
      },
    });
    const factory = new IDBFactory(),
      first = adapter(factory);
    const profile = await start(first);
    expect(profile.memberships[0].role).toBe("OWNER");
    const flow = await save(first, profile.defaultOrganizationId);
    const list = await first.requestLocal<LocalWorkItem[]>(
      `/orgs/${profile.defaultOrganizationId}/work-items`,
    );
    await first.close();
    const reopened = adapter(factory);
    expect(await start(reopened)).toEqual(profile);
    const restored = await reopened.requestLocal<LocalWorkflow[]>(
      `/orgs/${profile.defaultOrganizationId}/sops`,
    );
    expect(restored).toEqual([flow]);
    expect(JSON.parse(restored[0].draft)).toEqual(steps);
    expect(restored[0].boardSettings).toBe(settings);
    expect(
      await reopened.requestLocal(
        `/orgs/${profile.defaultOrganizationId}/work-items`,
      ),
    ).toEqual(list);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("serializes concurrent windows, rejects stale revisions, and rolls back graph plus work items", async () => {
    const factory = new IDBFactory(),
      one = adapter(factory),
      two = adapter(factory);
    const { defaultOrganizationId: org } = await start(one);
    const flow = await save(one, org);
    const results = await Promise.allSettled([
      save(one, org, {
        id: flow.id,
        expectedRevision: flow.revision,
        title: "窗口一",
      }),
      save(two, org, {
        id: flow.id,
        expectedRevision: flow.revision,
        title: "窗口二",
        steps: [steps[1]],
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { message: "内容已经更新，请刷新后再试" } });
    const winner = (
      await one.requestLocal<LocalWorkflow[]>(`/orgs/${org}/sops`)
    )[0];
    const expectedModules = JSON.parse(winner.draft)
      .filter((step: { kind: string }) => step.kind === "MODULE")
      .map((step: { id: string }) => step.id)
      .sort();
    const items = await one.requestLocal<LocalWorkItem[]>(
      `/orgs/${org}/work-items`,
    );
    expect(items.map((item) => item.moduleId).sort()).toEqual(expectedModules);
    await expect(
      save(one, org, {
        id: winner.id,
        expectedRevision: winner.revision,
        steps: [{ ...steps[0], nextModuleIds: ["missing"] }],
      }),
    ).rejects.toThrow("箭头只能");
    expect(await one.requestLocal(`/orgs/${org}/sops`)).toEqual([winner]);
    expect(await one.requestLocal(`/orgs/${org}/work-items`)).toEqual(items);
  });
  it("a retried creation returns its receipt without replacing edits or duplicating work records", async () => {
    const local = adapter();
    const { defaultOrganizationId: org } = await start(local);
    const createRequestId = env.id();
    const [one, two] = await Promise.all([
      save(local, org, { createRequestId }),
      save(local, org, { createRequestId }),
    ]);
    expect(one.id).toBe(two.id);
    const edited = await save(local, org, {
      id: one.id,
      expectedRevision: one.revision,
      title: "修改后的流程",
    });
    expect(await save(local, org, { createRequestId })).toEqual(edited);
    expect(await local.requestLocal(`/orgs/${org}/sops`)).toHaveLength(1);
    expect(await local.requestLocal(`/orgs/${org}/work-items`)).toHaveLength(2);
  });
  it("a quota failure during the actual write rolls back both graph and derived work records", async () => {
    const local = adapter();
    const { defaultOrganizationId: org } = await start(local);
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await expect(save(local, org)).rejects.toThrow("空间不足");
    expect(await local.requestLocal(`/orgs/${org}/sops`)).toEqual([]);
    expect(await local.requestLocal(`/orgs/${org}/work-items`)).toEqual([]);
  });
  it("retains record IDs through rename and removes only records for deleted boxes", async () => {
    const local = adapter();
    const { defaultOrganizationId: org } = await start(local);
    const flow = await save(local, org);
    const before = await local.requestLocal<LocalWorkItem[]>(
      `/orgs/${org}/work-items`,
    );
    const renamedSteps = [
      { ...steps[0], title: "洗葱", nextModuleIds: [] },
      steps[2],
    ];
    const renamed = await save(local, org, {
      id: flow.id,
      expectedRevision: flow.revision,
      steps: renamedSteps,
    });
    const after = await local.requestLocal<LocalWorkItem[]>(
      `/orgs/${org}/work-items`,
    );
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.find((item) => item.moduleId === "m1")!.id);
    expect(after[0].name).toBe("洗葱");
    expect(
      JSON.parse(renamed.draft).some(
        (step: { id: string }) => step.id === "d1",
      ),
    ).toBe(true);
  });
  it("prevents deleting shared instructions or their source; renaming keeps consumers bound", async () => {
    const local = adapter();
    const { defaultOrganizationId: org } = await start(local);
    const source = await save(local, org, {
      title: "共用做法",
      steps: [steps[2]],
    });
    const consumer = await save(local, org, {
      title: "晚饭",
      steps: [{ kind: "MODULE", id: "c1", title: "切葱" }],
    });
    await expect(
      local.requestLocal(
        `/orgs/${org}/sops/${source.id}`,
        { expectedRevision: source.revision },
        "DELETE",
      ),
    ).rejects.toThrow("还在使用");
    await expect(
      save(local, org, {
        id: source.id,
        expectedRevision: source.revision,
        title: source.title,
        steps: [],
      }),
    ).rejects.toThrow("还在使用");
    const renamed = await save(local, org, {
      id: source.id,
      expectedRevision: source.revision,
      title: source.title,
      steps: [{ ...steps[2], title: "葱的做法" }],
    });
    const all = await local.requestLocal<LocalWorkflow[]>(`/orgs/${org}/sops`);
    const updated = all.find((flow) => flow.id === consumer.id)!;
    expect(JSON.parse(updated.draft)[0]).toMatchObject({
      detailWorkflowId: source.id,
      detailId: "d1",
    });
    expect(updated.revision).toBeGreaterThan(consumer.revision);
    await expect(
      local.requestLocal(
        `/orgs/${org}/sops/${source.id}`,
        { expectedRevision: renamed.revision },
        "DELETE",
      ),
    ).rejects.toThrow("还在使用");
    await local.requestLocal(
      `/orgs/${org}/sops/${updated.id}`,
      { expectedRevision: updated.revision },
      "DELETE",
    );
    await local.requestLocal(
      `/orgs/${org}/sops/${source.id}`,
      { expectedRevision: renamed.revision },
      "DELETE",
    );
    expect(await local.requestLocal(`/orgs/${org}/sops`)).toEqual([]);
    expect(await local.requestLocal(`/orgs/${org}/work-items`)).toEqual([]);
  });
  it("keeps workspaces separate and rejects unsupported or cross-workspace references", async () => {
    const local = adapter();
    const profile = await start(local);
    const org = profile.defaultOrganizationId;
    const source = await save(local, org);
    const next = await local.requestLocal<{ id: string }>("/organizations", {
      name: "第二份工作",
    });
    expect(
      (await local.requestLocal<{ user: { id: string } }>("/auth/me")).user.id,
    ).toBe(profile.user.id);
    expect(await local.requestLocal(`/orgs/${next.id}/sops`)).toEqual([]);
    await expect(
      save(local, next.id, {
        steps: [
          {
            kind: "MODULE",
            id: "x",
            title: "切葱",
            detailWorkflowId: source.id,
            detailId: "d1",
          },
        ],
      }),
    ).rejects.toThrow("来源已经不存在");
    await expect(
      local.requestLocal(
        `/orgs/${next.id}/sops/${source.id}`,
        { expectedRevision: source.revision },
        "DELETE",
      ),
    ).rejects.toThrow("没有找到");
    await expect(
      local.requestLocal(`/orgs/${org}/not-a-feature`),
    ).rejects.toThrow("尚未提供离线版支持");
    expect(await local.requestLocal(`/orgs/${org}/sops`)).toEqual([source]);
  });
  it("stores image bytes in IDB and restores URLs before a fresh bootstrap resolves", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ close: vi.fn() })),
    );
    const factory = new IDBFactory(),
      first = adapter(factory);
    const { defaultOrganizationId: org } = await start(first);
    const image = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2XsAAAAASUVORK5CYII=",
      ),
      (character) => character.charCodeAt(0),
    );
    const path = await first.uploadLocal(
      org,
      new File([image], "pixel.png", { type: "image/png" }),
    );
    expect(path).toMatch(new RegExp(`^/api/orgs/${org}/files/`));
    const url = first.resolveLocalMedia(path);
    expect(url).toMatch(/^blob:/);
    await first.requestLocal("/auth/me");
    expect(first.resolveLocalMedia(path)).toBe(url);
    expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(
      image,
    );
    await first.close();
    const second = adapter(factory);
    expect(second.resolveLocalMedia(path)).toBe("");
    await start(second);
    const restoredUrl = second.resolveLocalMedia(path);
    expect(restoredUrl).toMatch(/^blob:/);
    expect(
      new Uint8Array(await (await fetch(restoredUrl)).arrayBuffer()),
    ).toEqual(image);
    expect(second.resolveLocalMedia("https://example.com/image.png")).toBe(
      "https://example.com/image.png",
    );
  });
  it("rejects a corrupt stored state without replacing it with an empty installation", async () => {
    const factory = new IDBFactory(),
      local = adapter(factory);
    await start(local);
    await local.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open("local-test", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(
        { version: 99, precious: "保留此数据" },
        "workspace",
      );
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    await expect(start(adapter(factory))).rejects.toThrow("原数据已保留");
    const stored = await new Promise<unknown>((resolve) => {
      const req = db.transaction("state").objectStore("state").get("workspace");
      req.onsuccess = () => resolve(req.result);
    });
    expect(stored).toEqual({ version: 99, precious: "保留此数据" });
    db.close();
  });
});

describe("pure local transitions and image validation", () => {
  it("failed edits leave the caller's entire input state unchanged", () => {
    const initial = initialLocalState(env),
      before = structuredClone(initial);
    expect(() =>
      applyLocalRequest(
        initial,
        `/orgs/${initial.defaultOrganizationId}/sops/save`,
        {
          title: "流程",
          draftOnly: true,
          steps: [{ kind: "DETAIL", title: "缺少编号", items: [] }],
        },
        "POST",
        env,
      ),
    ).toThrow("信息不完整");
    expect(initial).toEqual(before);
  });
  it("clear storage errors never promise a successful save", async () => {
    const quota = {
      open: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    } as unknown as IDBFactory;
    await expect(start(adapter(quota))).rejects.toThrow("空间不足");
  });
  it("rejects disguised and oversized raster images before decoding", () => {
    expect(() => inspectImage(new TextEncoder().encode("<svg></svg>"))).toThrow(
      "PNG 或 JPG",
    );
    const huge = new Uint8Array(24);
    huge.set([137, 80, 78, 71, 13, 10, 26, 10]);
    huge.set([73, 72, 68, 82], 12);
    const view = new DataView(huge.buffer);
    view.setUint32(16, 10000);
    view.setUint32(20, 10000);
    expect(() => inspectImage(huge)).toThrow("图片太大");
  });
});
