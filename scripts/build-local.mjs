import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.join(root, "frontend");
const output = path.join(frontend, "dist-local");
const env = { ...process.env, VITE_LOCAL_APP: "true" };
for (const [script, args] of [
  ["typescript/bin/tsc", ["-b"]],
  ["vite/bin/vite.js", ["build", "--outDir", "dist-local"]],
]) {
  const result = spawnSync(
    process.execPath,
    [path.join(frontend, "node_modules", script), ...args],
    { cwd: frontend, env, stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const manifestPath = path.join(output, "manifest.webmanifest");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
Object.assign(manifest, {
  id: "./",
  start_url: "./",
  scope: "./",
  lang: "zh-CN",
  theme_color: "#285647",
  background_color: "#f5f4ef",
});
manifest.icons = manifest.icons.map((icon) => ({
  ...icon,
  src: "./" + path.basename(icon.src),
}));
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
const indexPath = path.join(output, "index.html");
let html = await readFile(indexPath, "utf8");
html = html.replace(
  /href="[^"]*manifest.webmanifest"/,
  'href="./manifest.webmanifest"',
);
html = html.replace(
  "</head>",
  `<meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="WorkFlow OS" />
    <link rel="apple-touch-icon" href="./icon-192.png" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; media-src 'self' blob: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'" />
  </head>`,
);
await writeFile(indexPath, html);
async function filesUnder(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const lists = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? filesUnder(path.join(dir, entry.name), prefix + entry.name + "/")
        : [prefix + entry.name],
    ),
  );
  return lists
    .flat()
    .filter((name) => name !== "sw.js")
    .sort();
}
const files = await filesUnder(output);
const digest = createHash("sha256");
for (const file of files)
  digest.update(file).update(await readFile(path.join(output, file)));
const version = digest.digest("hex").slice(0, 16);
const sw = `/* Generated offline application shell. Workflows and pictures live in IndexedDB. */
const PREFIX = 'workflow-os-shell-' + self.registration.scope;
const CACHE = PREFIX + '${version}';
const ASSETS = ${JSON.stringify(files)}.map(file => new URL(file, self.registration.scope).href);
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.registration.scope)) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    if (event.request.mode === 'navigate') return (await cache.match(new URL('index.html', self.registration.scope).href)) || fetch(event.request);
    return (await cache.match(event.request)) || fetch(event.request);
  }));
});
`;
await writeFile(path.join(output, "sw.js"), sw);
console.log(
  `Standalone application built: ${files.length} offline assets, version ${version}`,
);
