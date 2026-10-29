import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite } from "./build-site.mjs";
import { checkLocalBuild, checkSite } from "./check-site.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "workflow-site-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(path.join(temp, "frontend"), { recursive: true });
  await mkdir(path.join(temp, "docs"), { recursive: true });
  await cp(
    path.join(root, "frontend", "dist-local"),
    path.join(temp, "frontend", "dist-local"),
    { recursive: true },
  );
  await cp(path.join(root, "downloads"), path.join(temp, "downloads"), {
    recursive: true,
  });
  await cp(path.join(root, "docs", "demo"), path.join(temp, "docs", "demo"), {
    recursive: true,
  });
  return temp;
}
test("builds a subdirectory-safe offline app and all download/demo links", async (t) => {
  const temp = await fixture(t);
  const built = await buildSite(temp);
  assert.equal(built.releaseLinks, 11);
  assert.equal(built.demos, 4);
  assert(built.application.files > 5);
  assert.deepEqual(await checkSite(built.output), {
    releaseLinks: built.releaseLinks,
    demos: built.demos,
    application: built.application,
  });
  for (const file of ["index.html", "manifest.webmanifest", "sw.js"])
    assert.deepEqual(
      await readFile(path.join(built.output, "app", file)),
      await readFile(path.join(temp, "frontend", "dist-local", file)),
    );
  const base = new URL("https://ioi610.github.io/workflow-os/");
  assert.equal(
    new URL("./app/", base).href,
    "https://ioi610.github.io/workflow-os/app/",
  );
  const manifest = JSON.parse(
    await readFile(
      path.join(built.output, "app", "manifest.webmanifest"),
      "utf8",
    ),
  );
  assert.equal(
    new URL(manifest.scope, new URL("./app/", base)).pathname,
    "/workflow-os/app/",
  );
});
test("rejects a backend request accidentally included in the standalone bundle", async (t) => {
  const temp = await fixture(t);
  const app = path.join(temp, "frontend", "dist-local");
  const html = await readFile(path.join(app, "index.html"), "utf8");
  const bundle = /src="(\.\/assets\/[^\"]+\.js)"/.exec(html);
  assert(bundle);
  const filename = path.join(app, bundle[1]);
  await writeFile(
    filename,
    `${await readFile(filename, "utf8")}\nfetch('/api/csrf');\n`,
  );
  await assert.rejects(checkLocalBuild(app), /仍在请求 Java 后端/);
});
test("rejects a backend-dependent build and leaves an existing site untouched", async (t) => {
  const temp = await fixture(t);
  await mkdir(path.join(temp, "site-output"));
  await writeFile(
    path.join(temp, "site-output", "sentinel.txt"),
    "previous successful build",
  );
  const app = path.join(temp, "frontend", "dist-local");
  const html = await readFile(path.join(app, "index.html"), "utf8");
  await writeFile(
    path.join(app, "index.html"),
    html.replace("./manifest.webmanifest", "/manifest.webmanifest"),
  );
  await assert.rejects(buildSite(temp), /相对路径 manifest/);
  assert.equal(
    await readFile(path.join(temp, "site-output", "sentinel.txt"), "utf8"),
    "previous successful build",
  );
});
test("rejects a missing demo and a wrong release asset without publishing partial output", async (t) => {
  const temp = await fixture(t);
  const source = path.join(temp, "downloads", "index.html");
  const html = await readFile(source, "utf8");
  await writeFile(
    source,
    html.replace("v0.2.0/WorkFlow-OS-Android.apk", "v0.2.0/missing.apk"),
  );
  await assert.rejects(buildSite(temp), /下载链接与发布文件名不一致/);
  await writeFile(source, html);
  await rm(path.join(temp, "docs", "demo", "workflow-os-mobile-demo.gif"));
  await assert.rejects(buildSite(temp), /ENOENT/);
});
test("rejects an absolute PWA scope and missing offline-cache entries", async (t) => {
  const temp = await fixture(t);
  const app = path.join(temp, "frontend", "dist-local");
  const manifestFile = path.join(app, "manifest.webmanifest");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  await writeFile(manifestFile, JSON.stringify({ ...manifest, scope: "/" }));
  await assert.rejects(checkLocalBuild(app), /scope 必须为/);
  await writeFile(manifestFile, JSON.stringify(manifest));
  const swFile = path.join(app, "sw.js");
  const sw = await readFile(swFile, "utf8");
  await writeFile(
    swFile,
    sw.replace(/const ASSETS = (\[[\s\S]*?\])\.map/, "const ASSETS = [].map"),
  );
  await assert.rejects(checkLocalBuild(app), /预缓存必须覆盖/);
});
