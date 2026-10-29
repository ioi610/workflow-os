import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());
describe("personal mode silently restores expired sessions", () => {
  it("recovers a rejected read without showing authentication", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ message: "请先登录" }, 401))
      .mockResolvedValueOnce(
        response({ token: "new", headerName: "X-CSRF-TOKEN" }),
      )
      .mockResolvedValueOnce(response({ personalMode: true }))
      .mockResolvedValueOnce(response([{ title: "我的流程" }]));
    vi.stubGlobal("fetch", fetch);
    const { api, configurePersonalMode } = await import("./api");
    configurePersonalMode(true);
    expect(await api("/orgs/test/sops")).toEqual([{ title: "我的流程" }]);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "/api/orgs/test/sops",
      "/api/csrf",
      "/api/personal/bootstrap",
      "/api/orgs/test/sops",
    ]);
  });
  it("recovers CSRF then expired-session rejection and resends the unchanged saved content", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ token: "old", headerName: "X-CSRF-TOKEN" }),
      )
      .mockResolvedValueOnce(response({}, 403))
      .mockResolvedValueOnce(
        response({ token: "fresh", headerName: "X-CSRF-TOKEN" }),
      )
      .mockResolvedValueOnce(response({ message: "请先登录" }, 401))
      .mockResolvedValueOnce(
        response({ token: "restored", headerName: "X-CSRF-TOKEN" }),
      )
      .mockResolvedValueOnce(response({ personalMode: true }))
      .mockResolvedValueOnce(response({ id: "saved" }));
    vi.stubGlobal("fetch", fetch);
    const { api, configurePersonalMode } = await import("./api");
    configurePersonalMode(true);
    const body = {
      title: "未丢失的输入",
      steps: [{ kind: "MODULE", title: "清洁" }],
    };
    expect(await api("/orgs/test/sops/save", body)).toEqual({ id: "saved" });
    const saves = fetch.mock.calls.filter(
      (call) => call[0] === "/api/orgs/test/sops/save",
    );
    expect(saves).toHaveLength(3);
    expect(saves.map((call) => call[1].body)).toEqual(
      Array(3).fill(JSON.stringify(body)),
    );
  });
  it("keeps login required when personal mode is disabled", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ message: "请先登录" }, 401));
    vi.stubGlobal("fetch", fetch);
    const { api } = await import("./api");
    await expect(api("/auth/me")).rejects.toThrow("请先登录");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
