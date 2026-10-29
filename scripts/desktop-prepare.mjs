import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { CONTENT_SECURITY_POLICY } = require("../desktop/security.cjs");
const indexPath = fileURLToPath(
  new URL("../frontend/dist-local/index.html", import.meta.url),
);
let index = await readFile(indexPath, "utf8");
if (!index.includes("<head>"))
  throw new Error("The standalone frontend index has no <head>.");
if (/\b(?:src|href)=["']\/(?!\/)/.test(index))
  throw new Error(
    "The standalone frontend must use relative asset paths (Vite base ./).",
  );
index = index.replace(
  /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi,
  "",
);
index = index.replace(
  "<head>",
  `<head><meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY.replaceAll('"', "&quot;")}"/>`,
);
await writeFile(indexPath, index);
console.log(
  "Prepared the offline desktop frontend with a local-content policy.",
);
