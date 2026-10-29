import assert from "node:assert/strict";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_BASE =
  "https://github.com/ioi610/workflow-os/releases/download/v0.2.0/";
export const RELEASE_ASSETS = [
  "WorkFlow-OS-Windows-x64.exe",
  "WorkFlow-OS-macOS-arm64.dmg",
  "WorkFlow-OS-macOS-arm64.zip",
  "WorkFlow-OS-macOS-x64.dmg",
  "WorkFlow-OS-macOS-x64.zip",
  "WorkFlow-OS-Linux-x64.AppImage",
  "WorkFlow-OS-Linux-x64.tar.gz",
  "WorkFlow-OS-Android.apk",
  "workflow-os-demo.gif",
  "workflow-os-mobile-demo.gif",
  "SHA256SUMS.txt",
];
export const DEMO_ASSETS = [
  "workflow-os-demo.gif",
  "workflow-os-mobile-demo.gif",
  "workflow-os-demo-poster.png",
  "workflow-os-mobile-demo-poster.png",
];

async function regularFile(filename) {
  const info = await lstat(filename);
  assert(
    info.isFile() && !info.isSymbolicLink(),
    `需要普通文件，不能是链接：${filename}`,
  );
  assert(info.size > 0, `文件为空：${filename}`);
}
export async function filesUnder(directory, prefix = "") {
  const rows = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const row of rows) {
    assert(!row.isSymbolicLink(), `静态构建中不能包含符号链接：${row.name}`);
    if (row.isDirectory())
      result.push(
        ...(await filesUnder(
          path.join(directory, row.name),
          `${prefix}${row.name}/`,
        )),
      );
    else {
      await regularFile(path.join(directory, row.name));
      result.push(prefix + row.name);
    }
  }
  return result.sort();
}
function localReferences(html) {
  return [...html.matchAll(/\b(?:href|src|srcset)="([^"]+)"/g)].map(
    (match) => match[1],
  );
}
async function checkReferences(html, directory) {
  for (const reference of localReferences(html)) {
    if (reference.startsWith("#")) {
      assert(
        html.includes(`id="${reference.slice(1)}"`),
        `找不到页面锚点：${reference}`,
      );
      continue;
    }
    if (reference.startsWith("https://")) {
      new URL(reference);
      continue;
    }
    assert(
      reference.startsWith("./"),
      `静态资源必须使用相对路径：${reference}`,
    );
    assert(!reference.includes(".."), `静态路径不能跳出目录：${reference}`);
    const filename = path.join(directory, reference.split(/[?#]/)[0]);
    if (reference.endsWith("/"))
      await regularFile(path.join(filename, "index.html"));
    else await regularFile(filename);
  }
}

export async function checkLocalBuild(directory) {
  const html = await readFile(path.join(directory, "index.html"), "utf8");
  assert(
    html.includes('href="./manifest.webmanifest"'),
    "独立版必须引用相对路径 manifest",
  );
  await checkReferences(html, directory);
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.webmanifest"), "utf8"),
  );
  for (const key of ["id", "start_url", "scope"])
    assert.equal(manifest[key], "./", `PWA ${key} 必须为 ./`);
  assert.equal(manifest.display, "standalone");
  for (const icon of manifest.icons) {
    assert(
      icon.src.startsWith("./") && !icon.src.includes(".."),
      "PWA 图标需要相对路径",
    );
    await regularFile(path.join(directory, icon.src));
  }
  const files = await filesUnder(directory);
  const scripts = files.filter(
    (file) => file.endsWith(".js") && file !== "sw.js",
  );
  assert(scripts.length > 0, "未找到独立版 JavaScript");
  const bundle = (
    await Promise.all(
      scripts.map((file) => readFile(path.join(directory, file), "utf8")),
    )
  ).join("\n");
  assert(
    bundle.includes("workflow-os-local-app"),
    "构建缺少本机 IndexedDB 存储，请先执行 build:local",
  );
  assert(
    bundle.includes("hashchange"),
    "独立构建缺少 HashRouter，GitHub Pages 刷新后可能无法打开",
  );
  assert(
    !bundle.includes("/api/csrf"),
    "构建仍在请求 Java 后端，不能用作独立离线版",
  );
  const sw = await readFile(path.join(directory, "sw.js"), "utf8");
  assert(
    sw.includes("self.registration.scope") &&
      sw.includes("caches.open") &&
      sw.includes("index.html"),
    "缺少离线应用缓存",
  );
  const assets = /const ASSETS = (\[[\s\S]*?\])\.map/.exec(sw);
  assert(assets, "未找到离线预缓存资源表");
  const cached = JSON.parse(assets[1]);
  assert.deepEqual(
    [...cached].sort(),
    files.filter((file) => file !== "sw.js").sort(),
    "离线预缓存必须覆盖每个应用文件",
  );
  return { files: files.length, scripts: scripts.length };
}

export async function checkSite(directory) {
  const html = await readFile(path.join(directory, "index.html"), "utf8");
  assert(html.includes('lang="zh-CN"'), "下载页应为中文");
  assert(html.includes("v0.2.0"), "下载页版本不正确");
  assert(!/<script\b/i.test(html), "下载页应无需 JavaScript 即可下载");
  await checkReferences(html, directory);
  const releaseLinks = [
    ...html.matchAll(/data-release-asset="([^"]+)"\s+href="([^"]+)"/g),
  ];
  assert.deepEqual(
    releaseLinks.map((match) => match[1]).sort(),
    [...RELEASE_ASSETS].sort(),
    "下载项不完整或有重复",
  );
  for (const match of releaseLinks)
    assert.equal(
      match[2],
      RELEASE_BASE + match[1],
      `下载链接与发布文件名不一致：${match[1]}`,
    );
  assert(
    html.includes("不提供 IPA") &&
      html.includes("Safari") &&
      html.includes("添加到主屏幕"),
    "iOS 应明确使用 PWA，不得声称提供 IPA",
  );
  assert(
    html.includes("不会自动同步") &&
      /图片(?:文件)?不会随文字迁移/.test(html) &&
      html.includes("首次联网"),
    "缺少本机保存及首次离线使用说明",
  );
  for (const file of DEMO_ASSETS)
    await regularFile(path.join(directory, "demo", file));
  for (const file of DEMO_ASSETS.filter((file) => file.endsWith(".gif"))) {
    const bytes = await readFile(path.join(directory, "demo", file));
    assert(
      ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")),
      `不是有效的 GIF 文件：${file}`,
    );
  }
  const application = await checkLocalBuild(path.join(directory, "app"));
  await regularFile(path.join(directory, ".nojekyll"));
  return {
    releaseLinks: releaseLinks.length,
    demos: DEMO_ASSETS.length,
    application,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const directory = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(root, "site-output");
  try {
    console.log("下载站检查通过：", await checkSite(directory));
  } catch (error) {
    console.error("下载站检查失败：", error.message);
    process.exitCode = 1;
  }
}
