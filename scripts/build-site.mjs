import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLocalBuild, checkSite, DEMO_ASSETS } from "./check-site.mjs";

export async function buildSite(
  rootDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  ),
) {
  const root = path.resolve(rootDirectory);
  const application = path.join(root, "frontend", "dist-local");
  const output = path.join(root, "site-output");
  const staging = path.join(root, `.site-output-${randomUUID()}`);
  // Validate before touching an existing generated website.
  await checkLocalBuild(application);
  const html = await readFile(
    path.join(root, "downloads", "index.html"),
    "utf8",
  );
  try {
    await mkdir(path.join(staging, "demo"), { recursive: true });
    await writeFile(path.join(staging, "index.html"), html);
    await writeFile(
      path.join(staging, ".nojekyll"),
      "# Static application files; no Jekyll processing.\n",
    );
    await cp(application, path.join(staging, "app"), {
      recursive: true,
      errorOnExist: true,
    });
    for (const file of DEMO_ASSETS)
      await cp(
        path.join(root, "docs", "demo", file),
        path.join(staging, "demo", file),
        { errorOnExist: true },
      );
    const checks = await checkSite(staging);
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
    return { output, ...checks };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log("静态下载站已生成：", await buildSite());
  } catch (error) {
    console.error("静态下载站构建失败：", error.message);
    process.exitCode = 1;
  }
}
