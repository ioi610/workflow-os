import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile, access } from "node:fs/promises";

const output = new URL("../frontend/dist-local/", import.meta.url);
const sw = await readFile(new URL("sw.js", output), "utf8");
function worker() {
  const handlers = {};
  const put = [],
    removed = [],
    fetched = [];
  const shell = { name: "offline index" };
  const context = vm.createContext({
    URL,
    self: {
      registration: { scope: "https://ioi610.github.io/workflow-os/app/" },
      addEventListener: (name, fn) => {
        handlers[name] = fn;
      },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => ({
        addAll: async (urls) => {
          put.push(...urls);
        },
        match: async (url) =>
          String(url).endsWith("/index.html") ? shell : undefined,
      }),
      keys: async () => [
        "workflow-os-shell-https://other.example/app/old",
        "workflow-os-shell-https://ioi610.github.io/workflow-os/app/old",
      ],
      delete: async (key) => {
        removed.push(key);
      },
    },
    fetch: async (request) => {
      fetched.push(request);
      return { name: "network" };
    },
  });
  vm.runInContext(sw, context);
  return { handlers, put, removed, fetched, shell };
}
test("offline shell pre-caches only real, scoped build files", async () => {
  const w = worker();
  let completion;
  w.handlers.install({
    waitUntil: (promise) => {
      completion = promise;
    },
  });
  await completion;
  assert.ok(w.put.length >= 6);
  for (const url of w.put) {
    assert.ok(url.startsWith("https://ioi610.github.io/workflow-os/app/"));
    await access(
      new URL(
        url.replace("https://ioi610.github.io/workflow-os/app/", ""),
        output,
      ),
    );
  }
});
test("offline navigation uses cached shell and leaves unrelated sites alone", async () => {
  const w = worker();
  let response;
  w.handlers.fetch({
    request: {
      url: "https://ioi610.github.io/workflow-os/app/",
      method: "GET",
      mode: "navigate",
    },
    respondWith: (value) => {
      response = value;
    },
  });
  assert.equal(await response, w.shell);
  assert.equal(w.fetched.length, 0);
  let intercepted = false;
  w.handlers.fetch({
    request: { url: "https://example.com/picture.png", method: "GET" },
    respondWith: () => {
      intercepted = true;
    },
  });
  assert.equal(intercepted, false);
});
test("updates remove only this app shell cache, never another deployment or business data", async () => {
  const w = worker();
  let completion;
  w.handlers.activate({
    waitUntil: (promise) => {
      completion = promise;
    },
  });
  await completion;
  assert.deepEqual(w.removed, [
    "workflow-os-shell-https://ioi610.github.io/workflow-os/app/old",
  ]);
  assert.doesNotMatch(sw, /indexedDB|localStorage/);
});
