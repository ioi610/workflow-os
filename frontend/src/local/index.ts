import {
  applyLocalRequest,
  assertLocalState,
  browserEnvironment,
  initialLocalState,
  type LocalEnvironment,
  type LocalState,
} from "./core";

export const LOCAL_DATABASE_NAME = "workflow-os-local-app";
type MediaRecord = {
  id: string;
  organizationId: string;
  blob: Blob;
  contentType: string;
  byteSize: number;
  createdAt: string;
};
type Options = {
  databaseName?: string;
  indexedDB?: IDBFactory;
  environment?: LocalEnvironment;
};

function storageError(error: unknown): Error {
  if (error instanceof Error && !(error instanceof DOMException)) return error;
  const name = error instanceof Error ? error.name : "";
  return new Error(
    name === "QuotaExceededError"
      ? "本机存储空间不足，这次修改没有保存。请腾出空间后重试。"
      : name === "VersionError"
        ? "这份本机数据由更新版本的软件保存，请更新软件后再打开。"
        : "本机存储暂时不可用，这次操作没有保存。请确认未使用隐私模式，并允许软件保存本机数据。",
  );
}

/** Every write reads the latest state inside the same serializable IDB transaction. */
export function createLocalAdapter(options: Options = {}) {
  const env = options.environment ?? browserEnvironment;
  let opening: Promise<IDBDatabase> | undefined;
  const mediaUrls = new Map<string, { blob: Blob; url: string }>();
  function database(): Promise<IDBDatabase> {
    if (opening) return opening;
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = options.indexedDB ?? globalThis.indexedDB;
      if (!factory) {
        reject(
          new Error(
            "此浏览器不支持保存本机数据，请使用最新版 Chrome、Edge、Safari 或安装版。",
          ),
        );
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(options.databaseName ?? LOCAL_DATABASE_NAME, 1);
      } catch (error) {
        reject(storageError(error));
        return;
      }
      let rejected = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("state"))
          db.createObjectStore("state");
        if (!db.objectStoreNames.contains("media"))
          db.createObjectStore("media", { keyPath: "id" });
      };
      request.onerror = () => reject(storageError(request.error));
      request.onblocked = () => {
        rejected = true;
        reject(
          new Error("另一窗口正在使用旧版数据，请关闭其他窗口后重新打开。"),
        );
      };
      request.onsuccess = () => {
        const db = request.result;
        if (rejected) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        resolve(db);
      };
    }).catch((error) => {
      opening = undefined;
      throw error;
    });
    return opening;
  }
  function refreshMedia(rows: MediaRecord[]) {
    const retained = new Set<string>();
    for (const row of rows) {
      const path = `/api/orgs/${row.organizationId}/files/${row.id}`;
      retained.add(path);
      // Media records are immutable: keep a single URL for each persisted image.
      if (!mediaUrls.has(path))
        mediaUrls.set(path, {
          blob: row.blob,
          url: URL.createObjectURL(row.blob),
        });
    }
    for (const [path, item] of mediaUrls)
      if (!retained.has(path)) {
        URL.revokeObjectURL(item.url);
        mediaUrls.delete(path);
      }
  }
  async function transaction<T>(
    operation: (
      state: LocalState,
      media: IDBObjectStore,
    ) => { state: LocalState; result: T },
  ): Promise<T> {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(["state", "media"], "readwrite");
      } catch (error) {
        reject(storageError(error));
        return;
      }
      let failed: unknown;
      let result: T;
      let images: MediaRecord[] = [];
      const store = tx.objectStore("state"),
        media = tx.objectStore("media");
      const request = store.get("workspace");
      request.onsuccess = () => {
        try {
          const state: unknown =
            request.result === undefined
              ? initialLocalState(env)
              : request.result;
          assertLocalState(state);
          const applied = operation(state, media);
          result = applied.result;
          store.put(applied.state, "workspace");
          const allMedia = media.getAll();
          allMedia.onsuccess = () => {
            images = allMedia.result as MediaRecord[];
          };
        } catch (error) {
          failed = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        try {
          refreshMedia(images);
          resolve(structuredClone(result!));
        } catch (error) {
          reject(
            new Error(
              "图片暂时无法显示，保存的数据仍在本机。请重新打开软件。",
              { cause: error },
            ),
          );
        }
      };
      tx.onabort = () => reject(storageError(failed ?? tx.error));
      tx.onerror = () => {
        /* The abort handler rejects only after the rollback finishes. */
      };
    });
  }
  async function requestLocal<T = unknown>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<T> {
    return transaction(
      (state) =>
        applyLocalRequest(state, path, body, method, env) as {
          state: LocalState;
          result: T;
        },
    );
  }
  async function uploadLocal(org: string, file: File): Promise<string> {
    if (!file || !file.size || file.size > 5 * 1024 * 1024)
      throw new Error("图片不能超过 5 MB");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = inspectImage(bytes);
    await validateDecoding(file);
    return transaction((state, media) => {
      if (!state.organizations.some((item) => item.id === org))
        throw new Error("没有找到这份工作内容，请返回首页重新打开。");
      const id = env.id();
      media.add({
        id,
        organizationId: org,
        blob: new Blob([bytes], { type: image.contentType }),
        contentType: image.contentType,
        byteSize: bytes.length,
        createdAt: env.now(),
      } satisfies MediaRecord);
      return { state, result: `/api/orgs/${org}/files/${id}` };
    });
  }
  function resolveLocalMedia(path: string): string {
    if (!/^\/api\/orgs\/[^/]+\/files\/[^/]+$/.test(path)) return path;
    return mediaUrls.get(path)?.url ?? "";
  }
  async function close() {
    if (opening) (await opening).close();
    opening = undefined;
    for (const item of mediaUrls.values()) URL.revokeObjectURL(item.url);
    mediaUrls.clear();
  }
  return { requestLocal, uploadLocal, resolveLocalMedia, close };
}

/** Check file signatures and pixel dimensions before asking the browser to decode. */
export function inspectImage(bytes: Uint8Array): {
  contentType: "image/png" | "image/jpeg";
  width: number;
  height: number;
} {
  let width = 0,
    height = 0;
  let contentType: "image/png" | "image/jpeg";
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    ) &&
    bytes[12] === 73 &&
    bytes[13] === 72 &&
    bytes[14] === 68 &&
    bytes[15] === 82
  ) {
    contentType = "image/png";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (
    bytes.length > 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  ) {
    contentType = "image/jpeg";
    let index = 2;
    while (index + 3 < bytes.length) {
      if (bytes[index++] !== 255) break;
      while (bytes[index] === 255) index++;
      const marker = bytes[index++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = bytes[index] * 256 + bytes[index + 1];
      if (length < 2 || index + length > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 8
      ) {
        height = bytes[index + 3] * 256 + bytes[index + 4];
        width = bytes[index + 5] * 256 + bytes[index + 6];
        break;
      }
      index += length;
    }
  } else throw new Error("请使用 PNG 或 JPG 格式的图片");
  if (!width || !height) throw new Error("这张图片打不开，请换一张再试");
  if (width * height > 40_000_000)
    throw new Error("这张图片太大，请缩小后再上传");
  return { contentType, width, height };
}
async function validateDecoding(file: Blob) {
  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      bitmap.close();
      return;
    }
    if (typeof Image !== "undefined") {
      const url = URL.createObjectURL(file);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
      } finally {
        URL.revokeObjectURL(url);
      }
      return;
    }
    throw new Error("无法读取图片");
  } catch {
    throw new Error("这张图片打不开，请换一张再试");
  }
}

const local = createLocalAdapter();
export const requestLocal = local.requestLocal;
export const uploadLocal = local.uploadLocal;
export const resolveLocalMedia = local.resolveLocalMedia;
