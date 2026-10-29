import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const indexPath = new URL("../frontend/dist-local/index.html", import.meta.url);
const index = await readFile(indexPath, "utf8");
assert.match(index, /http-equiv="Content-Security-Policy"/);
assert.match(index, /connect-src 'none'/);
assert.doesNotMatch(index, /\b(?:src|href)=["']\/(?!\/)/);
const scripts = [...index.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)];
assert.ok(
  scripts.length > 0,
  "The standalone build must include its JavaScript.",
);
for (const [, source] of scripts) {
  assert.ok(
    source.startsWith("./"),
    "Desktop scripts must be bundled local files.",
  );
  await access(fileURLToPath(new URL(source, indexPath)));
}
console.log(
  `Offline desktop entry verified (${scripts.length} bundled script).`,
);
