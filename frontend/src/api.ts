import { LOCAL_APP } from "./localMode";
import { requestLocal, uploadLocal, resolveLocalMedia } from "./local";

let csrf: { token: string; headerName: string } | null = null;
let personalMode = false;
let recovery: Promise<void> | null = null;
export function configurePersonalMode(enabled: boolean) {
  personalMode = enabled;
}
async function getCsrf() {
  const response = await fetch("/api/csrf", { credentials: "same-origin" });
  if (!response.ok) throw new Error("暂时连不上，请过一会儿再试。");
  csrf = await response.json();
}
function send(path: string, body: unknown, method: string) {
  return fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(method !== "GET" && csrf ? { [csrf.headerName]: csrf.token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function recoverPersonalSession() {
  if (!recovery)
    recovery = (async () => {
      await getCsrf();
      const response = await send("/personal/bootstrap", {}, "POST");
      if (!response.ok) throw new Error("工作页面没能打开，请再试一次。");
    })().finally(() => {
      recovery = null;
    });
  return recovery;
}
async function withRecovery(
  perform: () => Promise<Response>,
  mutating: boolean,
  path: string,
) {
  let refreshed = false,
    recovered = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await perform();
    if (
      response.status === 401 &&
      personalMode &&
      path !== "/personal/bootstrap" &&
      !recovered
    ) {
      await recoverPersonalSession();
      recovered = true;
      continue;
    }
    if (response.status === 403 && mutating && !refreshed) {
      await getCsrf();
      refreshed = true;
      continue;
    }
    return response;
  }
  throw new Error("还是没能连上，请再试一次。");
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  if (LOCAL_APP) return requestLocal<T>(path, body, method);
  if (method !== "GET" && !csrf) await getCsrf();
  const response = await withRecovery(
    () => send(path, body, method),
    method !== "GET",
    path,
  );
  if (!response.ok) {
    let message = "这次操作没成功，请再试一次";
    try {
      message = (await response.json()).message || message;
    } catch {}
    throw new Error(message);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
export function businessDate(timezone = "Asia/Tokyo") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return ["year", "month", "day"]
    .map((key) => parts.find((value) => value.type === key)?.value)
    .join("-");
}
export async function upload(org: string, file: File): Promise<string> {
  if (LOCAL_APP) return uploadLocal(org, file);
  if (!csrf) await getCsrf();
  const body = new FormData();
  body.append("file", file);
  const perform = () =>
    fetch(`/api/orgs/${org}/files`, {
      method: "POST",
      credentials: "same-origin",
      headers: csrf ? { [csrf.headerName]: csrf.token } : {},
      body,
    });
  const response = await withRecovery(perform, true, `/orgs/${org}/files`);
  if (!response.ok)
    throw new Error((await response.json()).message || "图片上传失败");
  return (await response.json()).url;
}
export function mediaUrl(path: string): string {
  return LOCAL_APP ? resolveLocalMedia(path) : path;
}
