import type { Workflow, WorkflowModule, WorkflowStep } from "../types";
import {
  normalizeName,
  readWorkflow,
  resolveModuleLink,
} from "../features/sop/workflows";
import { validateWorkflowDraft } from "../features/sop/workflowDraft";

type Row = Record<string, unknown>;
export type LocalWorkflow = Workflow & {
  organizationId: string;
  createdAt: string;
  status: string;
};
export type LocalWorkItem = {
  id: string;
  organizationId: string;
  workflowId: string;
  moduleId: string;
  name: string;
  notes: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type LocalState = {
  version: 1;
  user: {
    id: string;
    displayName: string;
    email: string;
    createdAt: string;
    revision: number;
  };
  defaultOrganizationId: string;
  organizations: Array<{
    id: string;
    name: string;
    createdAt: string;
    revision: number;
  }>;
  memberships: Array<{
    id: string;
    organizationId: string;
    userId: string;
    role: string;
    status: string;
    createdAt: string;
    revision: number;
  }>;
  workflows: LocalWorkflow[];
  workItems: LocalWorkItem[];
  versions: Array<
    Row & {
      id: string;
      organizationId: string;
      sopId: string;
      versionNumber: number;
    }
  >;
};
export type LocalEnvironment = { id: () => string; now: () => string };
export const browserEnvironment: LocalEnvironment = {
  id: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
};

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const record = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);
const copy = <T>(value: T): T => structuredClone(value);

export function initialLocalState(
  env: LocalEnvironment = browserEnvironment,
): LocalState {
  const userId = env.id(),
    org = env.id(),
    now = env.now();
  return {
    version: 1,
    user: {
      id: userId,
      displayName: "本机用户",
      email: `${userId}@local.invalid`,
      createdAt: now,
      revision: 0,
    },
    defaultOrganizationId: org,
    organizations: [{ id: org, name: "我的工作", createdAt: now, revision: 0 }],
    memberships: [
      {
        id: env.id(),
        organizationId: org,
        userId,
        role: "OWNER",
        status: "ACTIVE",
        createdAt: now,
        revision: 0,
      },
    ],
    workflows: [],
    workItems: [],
    versions: [],
  };
}

/** Reject an unreadable database instead of quietly replacing the user's work. */
export function assertLocalState(value: unknown): asserts value is LocalState {
  requireValue(
    record(value) &&
      value.version === 1 &&
      record(value.user) &&
      typeof value.user.id === "string" &&
      typeof value.defaultOrganizationId === "string" &&
      Array.isArray(value.organizations) &&
      Array.isArray(value.memberships) &&
      Array.isArray(value.workflows) &&
      Array.isArray(value.workItems) &&
      Array.isArray(value.versions),
    "本机保存的内容暂时无法读取，原数据已保留。请重启软件后再试，切勿清除应用数据。",
  );
  requireValue(
    value.organizations.some(
      (org: Row) => record(org) && org.id === value.defaultOrganizationId,
    ) &&
      value.workflows.every(
        (flow: Row) =>
          record(flow) &&
          typeof flow.id === "string" &&
          typeof flow.draft === "string" &&
          Number.isSafeInteger(flow.revision),
      ),
    "本机保存的内容不完整，原数据已保留。请重启软件后再试。",
  );
}

function rawSteps(workflow: Workflow): WorkflowStep[] {
  let value: unknown;
  try {
    value = JSON.parse(workflow.draft);
  } catch {
    throw new Error("有流程的内容暂时无法读取，请先重新打开检查后再试");
  }
  requireValue(
    Array.isArray(value) && value.every(record),
    "有流程的内容暂时无法读取，请先重新打开检查后再试",
  );
  return value as WorkflowStep[];
}
function moduleId(step: WorkflowStep, index: number) {
  return step.kind === "MODULE"
    ? step.id || `module-${index}`
    : `module-${step.id || `legacy-${index}`}`;
}
function modules(steps: WorkflowStep[]) {
  return steps.flatMap((step, index) =>
    step.kind === "DETAIL" ? [] : [{ id: moduleId(step, index), step }],
  );
}
function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((v, i) => sameJson(v, right[i]))
    );
  return (
    record(left) &&
    record(right) &&
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every(
      (key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]),
    )
  );
}
function bindingSame(left: WorkflowStep, right: WorkflowStep) {
  return (
    left.detailId === right.detailId &&
    left.detailWorkflowId === right.detailWorkflowId
  );
}
function board(value: unknown): Row | null {
  if (value === null || value === undefined) return null;
  requireValue(
    typeof value === "string" && value.length <= 8192,
    "流程图设置有问题，请重新打开后再试",
  );
  let settings: unknown;
  try {
    settings = JSON.parse(value);
  } catch {
    throw new Error("流程图设置有问题，请重新打开后再试");
  }
  requireValue(
    record(settings) &&
      settings.version === 1 &&
      record(settings.timeline) &&
      record(settings.priority),
    "流程图设置有问题，请重新打开后再试",
  );
  const time = settings.timeline,
    priority = settings.priority;
  requireValue(
    typeof time.enabled === "boolean" && typeof priority.enabled === "boolean",
    "流程图设置有问题，请重新打开后再试",
  );
  for (const key of ["startMinute", "endMinute"])
    requireValue(
      Number.isInteger(time[key]) &&
        Number(time[key]) >= 0 &&
        Number(time[key]) <= 1439,
      "开始和结束时间有问题，请重新选一下",
    );
  requireValue(time.startMinute !== time.endMinute, "开始和结束时间不能一样");
  for (const axis of [time, priority])
    if (axis.axis !== undefined)
      requireValue(
        axis.axis === "x" || axis.axis === "y",
        "坐标方向有问题，请重新选一下",
      );
  const timeAxis = time.axis ?? (priority.axis === "x" ? "y" : "x");
  const priorityAxis = priority.axis ?? (timeAxis === "x" ? "y" : "x");
  requireValue(
    !time.enabled || !priority.enabled || timeAxis !== priorityAxis,
    "时间和先后安排不能放在同一个方向，请换一个方向",
  );
  for (const key of ["canvas", "referenceCanvas"])
    if (settings[key] !== undefined) {
      const size = settings[key];
      requireValue(
        record(size) &&
          [size.width, size.height].every(
            (n) => Number.isInteger(n) && Number(n) >= 320 && Number(n) <= 2400,
          ),
        "画板的宽和高请填写 320 到 2400 之间的整数",
      );
    }
  const duration =
    (Number(time.endMinute) - Number(time.startMinute) + 1440) % 1440;
  if (time.focus !== undefined && time.focus !== null) {
    const focus = time.focus;
    requireValue(
      record(focus) && validRange(focus, duration, 1, 10),
      "请重新选择要拉宽的时间段，放大倍数需要在 1 到 10 之间",
    );
  }
  if (time.segments !== undefined && time.segments !== null) {
    requireValue(
      Array.isArray(time.segments) && time.segments.length <= 96,
      "时间段设置有问题，请重新调整每段长度",
    );
    let previous = 0;
    for (const segment of time.segments) {
      requireValue(
        record(segment) &&
          validRange(segment, duration, 1e-6, 10000) &&
          Number(segment.startOffset) >= previous,
        "时间段不能重叠或超出时间范围，长度需要在允许范围内",
      );
      previous = Number(segment.endOffset);
    }
  }
  return settings;
}
function validRange(segment: Row, duration: number, min: number, max: number) {
  return (
    Number.isInteger(segment.startOffset) &&
    Number.isInteger(segment.endOffset) &&
    Number(segment.startOffset) >= 0 &&
    Number(segment.startOffset) < Number(segment.endOffset) &&
    Number(segment.endOffset) <= duration &&
    typeof segment.scale === "number" &&
    Number.isFinite(segment.scale) &&
    segment.scale >= min &&
    segment.scale <= max
  );
}
function preserveBoard(
  requested: string | null | undefined,
  previous: string | null | undefined,
) {
  if (requested === null || requested === undefined) return previous ?? null;
  const next = board(requested)!;
  const old = board(previous);
  if (!old) return requested;
  let changed = false;
  for (const key of ["canvas", "referenceCanvas"])
    if (next[key] === undefined && old[key] !== undefined) {
      next[key] = old[key];
      changed = true;
    }
  const time = next.timeline as Row,
    oldTime = old.timeline as Row;
  if (time.segments === undefined && oldTime.segments !== undefined) {
    time.segments =
      time.startMinute === oldTime.startMinute &&
      time.endMinute === oldTime.endMinute
        ? oldTime.segments
        : null;
    changed = true;
  }
  return changed ? JSON.stringify(next) : requested;
}

function validateSteps(
  steps: unknown,
  org: string,
  title: string,
  category: string,
  settings: string | null,
  draftOnly: boolean,
): asserts steps is WorkflowStep[] {
  requireValue(
    Array.isArray(steps) && steps.length <= 200 && steps.every(record),
    "内容格式有问题，请重新打开后再保存",
  );
  requireValue(
    steps.every(
      (step) =>
        typeof step.title === "string" &&
        (step.kind === undefined ||
          step.kind === "MODULE" ||
          step.kind === "DETAIL"),
    ),
    "内容格式有问题，请重新打开后再保存",
  );
  if (draftOnly)
    for (const step of steps.filter((step) => step.kind === "DETAIL"))
      requireValue(
        typeof step.id === "string" && step.id.trim() && step.id.length <= 255,
        "具体做法的信息不完整，请重新打开后再保存",
      );
  const temporary: Workflow = {
    id: "validation",
    title,
    category,
    revision: 0,
    draft: JSON.stringify(steps),
  };
  const content = readWorkflow(temporary.draft);
  const error = validateWorkflowDraft(
    { ...content, title, category, boardSettings: settings },
    org,
  );
  requireValue(!error, error || "内容格式有问题，请重新打开后再保存");
  if (!draftOnly)
    for (const detail of content.details) {
      requireValue(
        normalizeName(detail.title),
        "请给每项工作或具体做法起个名字",
      );
      requireValue(
        (detail.legacyEmpty === true &&
          !detail.items.length &&
          !detail.description?.trim()) ||
          (detail.items.length > 0 &&
            detail.items.every((item) => item.text.trim())),
        "请把清单里的每一条做法写完整",
      );
    }
  const config = board(settings);
  const canvas = config?.canvas as Row | undefined;
  const width = Number(canvas?.width ?? 820),
    height = Number(canvas?.height ?? 820);
  const entries = modules(steps as WorkflowStep[]);
  const ids = new Set(entries.map((entry) => entry.id));
  requireValue(
    ids.size === entries.length &&
      entries.every((entry) => entry.id.length <= 255),
    "工作信息有重复，请重新打开后再保存",
  );
  for (const { id, step } of entries) {
    if (step.id !== undefined)
      requireValue(
        typeof step.id === "string" && step.id.trim() && step.id.length <= 255,
        "工作信息不完整，请重新打开后再保存",
      );
    if (step.detailId !== undefined)
      requireValue(
        typeof step.detailId === "string" &&
          step.detailId.trim() &&
          step.detailId.length <= 255,
        "对应做法的信息不完整，请重新选择后再保存",
      );
    if (step.frame !== undefined) {
      const frame = step.frame;
      requireValue(
        record(frame) &&
          [frame.x, frame.y, frame.width, frame.height].every(
            (n) => typeof n === "number" && Number.isFinite(n),
          ),
        "方框的位置和大小有问题，请重新打开后再保存",
      );
      requireValue(
        Number(frame.x) >= 0 &&
          Number(frame.y) >= 0 &&
          Number(frame.width) >= 32 &&
          Number(frame.height) >= 32 &&
          Number(frame.width) <= 2400 &&
          Number(frame.height) <= 2400 &&
          Number(frame.x) + Number(frame.width) <= width + 1e-6 &&
          Number(frame.y) + Number(frame.height) <= height + 1e-6,
        "方框太小或超出了流程图，请调整后再保存",
      );
    } else {
      let w = 0.2,
        h = 0.2;
      if (step.size !== undefined) {
        requireValue(
          record(step.size) &&
            [step.size.width, step.size.height].every(
              (n) =>
                typeof n === "number" &&
                Number.isFinite(n) &&
                n >= 0.12 &&
                n <= 1,
            ),
          "方框太小或超出了流程图，请调整后再保存",
        );
        w = Number(step.size.width);
        h = Number(step.size.height);
      }
      if (step.position !== undefined)
        requireValue(
          record(step.position) &&
            typeof step.position.x === "number" &&
            typeof step.position.y === "number" &&
            step.position.x >= 0 &&
            step.position.y >= 0 &&
            step.position.x + w <= 1 &&
            step.position.y + h <= 1,
          "方框太小或超出了流程图，请调整后再保存",
        );
    }
    if (step.nextModuleIds !== undefined)
      requireValue(
        Array.isArray(step.nextModuleIds) &&
          step.nextModuleIds.length <= 100 &&
          new Set(step.nextModuleIds).size === step.nextModuleIds.length &&
          step.nextModuleIds.every(
            (target) =>
              typeof target === "string" && target !== id && ids.has(target),
          ),
        "箭头只能连到这个流程里的另一项工作，同一条箭头不能重复添加",
      );
  }
}

function synchronize(
  state: LocalState,
  workflow: LocalWorkflow,
  env: LocalEnvironment,
) {
  const retained = new Set<string>();
  for (const { id, step } of modules(rawSteps(workflow))) {
    retained.add(id);
    const found = state.workItems.find(
      (item) => item.workflowId === workflow.id && item.moduleId === id,
    );
    const name = normalizeName(step.title);
    if (found) {
      if (found.name !== name) {
        found.name = name;
        found.updatedAt = env.now();
        found.revision++;
      }
    } else
      state.workItems.push({
        id: env.id(),
        organizationId: workflow.organizationId,
        workflowId: workflow.id,
        moduleId: id,
        name,
        notes: "",
        revision: 0,
        createdAt: env.now(),
        updatedAt: env.now(),
      });
  }
  state.workItems = state.workItems.filter(
    (item) => item.workflowId !== workflow.id || retained.has(item.moduleId),
  );
}
function getWorkflow(state: LocalState, org: string, id: unknown) {
  const found = state.workflows.find(
    (flow) => flow.id === id && flow.organizationId === org,
  );
  requireValue(found, "没有找到这项内容");
  return found;
}
function revision(flow: LocalWorkflow, expected: unknown) {
  requireValue(Number.isSafeInteger(expected), "页面信息不完整，请刷新后重试");
  requireValue(flow.revision === expected, "内容已经更新，请刷新后再试");
}
function documentEntries(steps: WorkflowStep[]) {
  return steps.flatMap((step, index) =>
    step.kind === "MODULE"
      ? []
      : [
          {
            step,
            index,
            id:
              step.kind === "DETAIL"
                ? step.id || `detail-${index}`
                : `detail-${step.id || `legacy-${index}`}`,
            name: normalizeName(step.title),
          },
        ],
  );
}
function materialize(steps: WorkflowStep[], wanted: Set<string>) {
  for (const doc of documentEntries(steps))
    if (!doc.step.id && wanted.has(doc.id))
      doc.step.id = doc.step.kind === "DETAIL" ? doc.id : `legacy-${doc.index}`;
}
function preserveLinks(
  state: LocalState,
  source: LocalWorkflow,
  incoming: WorkflowStep[],
  library: LocalWorkflow[],
  env: LocalEnvironment,
) {
  const beforeModules = new Map(
    modules(rawSteps(source)).map((entry) => [entry.id, entry.step]),
  );
  for (const { id, step } of modules(incoming)) {
    if (
      typeof step.detailId !== "string" &&
      typeof step.detailWorkflowId !== "string"
    )
      continue;
    const before = beforeModules.get(id);
    if (before && bindingSame(before, step)) continue;
    const owner =
      step.detailWorkflowId === undefined || step.detailWorkflowId === source.id
        ? source
        : library.find((flow) => flow.id === step.detailWorkflowId);
    requireValue(
      owner,
      "这份做法的来源已经不存在或不在当前工作内容中，请重新选择",
    );
    const steps = owner.id === source.id ? incoming : rawSteps(owner);
    if (typeof step.detailId === "string") {
      requireValue(
        documentEntries(steps).filter((doc) => doc.id === step.detailId)
          .length === 1,
        "这份具体做法已经不存在，请重新选择",
      );
      materialize(steps, new Set([step.detailId]));
      if (owner.id !== source.id && !sameJson(rawSteps(owner), steps)) {
        owner.draft = JSON.stringify(steps);
        owner.revision++;
        synchronize(state, owner, env);
      }
    }
  }
  const previous = documentEntries(rawSteps(source));
  const next = new Map(documentEntries(incoming).map((doc) => [doc.id, doc]));
  const removed = new Set(
    previous.filter((doc) => !next.has(doc.id)).map((doc) => doc.id),
  );
  const renamed = new Set(
    previous
      .filter((doc) => next.has(doc.id) && doc.name !== next.get(doc.id)!.name)
      .map((doc) => doc.id),
  );
  for (const owner of library) {
    const ownerSteps = owner.id === source.id ? incoming : rawSteps(owner);
    const updated = new Map(
      modules(ownerSteps).map((entry) => [entry.id, entry.step]),
    );
    let changed = false;
    for (const old of readWorkflow(owner.draft).modules) {
      const current = updated.get(old.id);
      if (!current) continue;
      const match = resolveModuleLink(owner, old, library);
      if (
        match.status !== "MATCHED" ||
        match.targetWorkflow?.id !== source.id ||
        !match.detail
      )
        continue;
      if (removed.has(match.detail.id)) {
        // Rebinding the surviving module in the same save may release its old document.
        const proposedOwner =
          owner.id === source.id
            ? { ...owner, draft: JSON.stringify(incoming) }
            : owner;
        const proposed = resolveModuleLink(
          proposedOwner,
          { ...current, kind: "MODULE", id: old.id } as WorkflowModule,
          library.map((flow) =>
            flow.id === source.id
              ? { ...source, draft: JSON.stringify(incoming) }
              : flow,
          ),
        );
        requireValue(
          proposed.status === "MATCHED" &&
            (proposed.targetWorkflow?.id !== source.id ||
              !removed.has(proposed.detail!.id)),
          `这些工作还在使用要移除的做法，暂时不能删除：「${owner.title}（${old.title}）」。请先更换或移除对应工作`,
        );
      }
      if (
        !renamed.has(match.detail.id) ||
        typeof old.detailId === "string" ||
        typeof current.detailId === "string" ||
        !bindingSame(old, current)
      )
        continue;
      const requestedName = normalizeName(
        typeof current.detailName === "string" && current.detailName.trim()
          ? current.detailName
          : current.title,
      );
      if (
        requestedName !== normalizeName(match.detail.title) &&
        requestedName !== next.get(match.detail.id)!.name
      )
        continue;
      current.detailWorkflowId = source.id;
      current.detailId = match.detail.id;
      changed = true;
    }
    if (changed && owner.id !== source.id) {
      owner.draft = JSON.stringify(ownerSteps);
      owner.revision++;
      synchronize(state, owner, env);
    }
  }
  materialize(incoming, renamed);
}

function profile(state: LocalState) {
  return {
    user: state.user,
    organizations: state.organizations,
    memberships: state.memberships,
    personalMode: true,
    defaultOrganizationId: state.defaultOrganizationId,
  };
}

/** Pure state transition, committed with its work-item changes in one IDB transaction. */
export function applyLocalRequest(
  original: LocalState,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  env: LocalEnvironment = browserEnvironment,
): { state: LocalState; result: unknown } {
  const state = copy(original);
  const input: Row =
    body === undefined
      ? {}
      : record(body)
        ? body
        : (() => {
            throw new Error("内容格式有问题，请重新打开后再保存");
          })();
  const verb = method.toUpperCase();
  if (path === "/mode" && verb === "GET")
    return { state, result: { personalMode: true, localApp: true } };
  if (path === "/csrf" && verb === "GET")
    return {
      state,
      result: { token: "local-only", headerName: "X-Local-Only" },
    };
  if (
    (path === "/personal/bootstrap" && verb === "POST") ||
    (path === "/auth/me" && verb === "GET")
  )
    return { state, result: profile(state) };
  if (path === "/organizations" && verb === "POST") {
    requireValue(
      typeof input.name === "string" &&
        input.name.trim() &&
        input.name.length <= 100,
      "请输入 1 至 100 字的工作内容名称",
    );
    const org = {
      id: env.id(),
      name: input.name,
      createdAt: env.now(),
      revision: 0,
    };
    state.organizations.push(org);
    state.memberships.push({
      id: env.id(),
      organizationId: org.id,
      userId: state.user.id,
      role: "OWNER",
      status: "ACTIVE",
      createdAt: env.now(),
      revision: 0,
    });
    return { state, result: org };
  }
  const route = /^\/orgs\/([^/]+)\/(.+)$/.exec(path);
  requireValue(route, "此功能尚未提供离线版支持，请使用当前页面中的流程功能。");
  const [, org, action] = route;
  requireValue(
    state.organizations.some((item) => item.id === org),
    "没有找到这份工作内容，请返回首页重新打开。",
  );
  const library = state.workflows.filter((flow) => flow.organizationId === org);
  if (action === "sops" && verb === "GET") return { state, result: library };
  if (action === "work-items" && verb === "GET") {
    for (const flow of library.filter((flow) => flow.status !== "ARCHIVED"))
      synchronize(state, flow, env);
    const active = new Set(
      library
        .filter((flow) => flow.status !== "ARCHIVED")
        .map((flow) => flow.id),
    );
    return {
      state,
      result: state.workItems
        .filter(
          (item) => item.organizationId === org && active.has(item.workflowId),
        )
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    };
  }
  if (action === "sops/save" && verb === "POST") {
    requireValue(
      typeof input.title === "string" &&
        input.title.trim() &&
        input.title.trim().length <= 200,
      "请填写 1 至 200 字的流程名称",
    );
    requireValue(
      input.category === undefined ||
        input.category === null ||
        (typeof input.category === "string" && input.category.length <= 100),
      "分类不能超过 100 个字",
    );
    requireValue(
      input.id == null || input.createRequestId == null,
      "添加流程和修改流程的信息不能混用",
    );
    requireValue(
      input.createRequestId == null ||
        (typeof input.createRequestId === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            input.createRequestId,
          )),
      "这次添加的信息不完整，请重新生成后再试",
    );
    if (input.id == null && input.createRequestId != null) {
      const receipt = state.workflows.find(
        (flow) => flow.id === input.createRequestId,
      );
      if (receipt) {
        requireValue(
          receipt.organizationId === org,
          "这次添加的信息已被使用，请重新生成后再试",
        );
        return { state, result: receipt };
      }
    }
    const existing =
      input.id == null ? undefined : getWorkflow(state, org, input.id);
    if (existing) revision(existing, input.expectedRevision);
    const boardSettings = preserveBoard(
      input.boardSettings as string | null | undefined,
      existing?.boardSettings,
    );
    const category = typeof input.category === "string" ? input.category : "";
    validateSteps(
      input.steps,
      org,
      input.title,
      category,
      boardSettings,
      input.draftOnly === true,
    );
    const steps = copy(input.steps);
    const flow: LocalWorkflow = existing ?? {
      id:
        typeof input.createRequestId === "string"
          ? input.createRequestId
          : env.id(),
      organizationId: org,
      title: "",
      category: "",
      draft: "[]",
      revision: 0,
      status: "DRAFT",
      createdAt: env.now(),
      boardSettings: null,
    };
    preserveLinks(state, flow, steps, library, env);
    const changed =
      flow.title !== input.title ||
      flow.category !== category ||
      !sameJson(rawSteps(flow), steps) ||
      !sameJson(board(flow.boardSettings), board(boardSettings));
    flow.title = input.title;
    flow.category = category;
    flow.draft = JSON.stringify(steps);
    flow.boardSettings = boardSettings;
    if (existing && changed) flow.revision++;
    if (!existing) state.workflows.push(flow);
    synchronize(state, flow, env);
    if (input.draftOnly !== true && (changed || flow.status !== "PUBLISHED")) {
      const version = {
        id: env.id(),
        organizationId: org,
        sopId: flow.id,
        versionNumber:
          state.versions.filter((v) => v.sopId === flow.id).length + 1,
        title: flow.title,
        steps: flow.draft,
        boardSettings,
        publishedAt: env.now(),
        publishedBy: state.user.id,
        createdAt: env.now(),
        revision: 0,
      };
      state.versions.push(version);
      flow.currentVersionId = version.id;
      flow.status = "PUBLISHED";
      if (existing && !changed) flow.revision++;
    }
    return { state, result: flow };
  }
  const flowRoute = /^sops\/([^/]+)(?:\/(versions|archive))?$/.exec(action);
  if (flowRoute) {
    const flow = getWorkflow(state, org, flowRoute[1]);
    if (flowRoute[2] === "versions" && verb === "GET")
      return {
        state,
        result: state.versions
          .filter(
            (version) =>
              version.organizationId === org && version.sopId === flow.id,
          )
          .sort((a, b) => b.versionNumber - a.versionNumber),
      };
    if (flowRoute[2] === "archive" && verb === "POST") {
      flow.status = "ARCHIVED";
      flow.revision++;
      return { state, result: flow };
    }
    if (!flowRoute[2] && verb === "DELETE") {
      revision(flow, input.expectedRevision);
      const dependents = library
        .filter((owner) => owner.id !== flow.id)
        .flatMap((owner) => {
          rawSteps(owner);
          const used = readWorkflow(owner.draft).modules.filter(
            (module) =>
              module.detailWorkflowId === flow.id ||
              resolveModuleLink(owner, module, library).targetWorkflow?.id ===
                flow.id,
          );
          return used.length
            ? [
                `${owner.title}（${used.map((module) => module.title).join("、")}）`,
              ]
            : [];
        });
      requireValue(
        !dependents.length,
        `这些流程还在使用这里的做法，暂时不能删除：「${dependents.join("」、「")}」。请先更换或移除对应工作`,
      );
      state.workflows = state.workflows.filter((item) => item.id !== flow.id);
      state.workItems = state.workItems.filter(
        (item) => item.workflowId !== flow.id,
      );
      state.versions = state.versions.filter((item) => item.sopId !== flow.id);
      return { state, result: null };
    }
  }
  const workRoute = /^work-items\/([^/]+)$/.exec(action);
  if (workRoute && verb === "PUT") {
    const item = state.workItems.find(
      (value) => value.organizationId === org && value.id === workRoute[1],
    );
    requireValue(item, "没有找到这项工作");
    requireValue(
      getWorkflow(state, org, item.workflowId).status !== "ARCHIVED",
      "这项工作所在的流程暂时不能修改",
    );
    requireValue(
      typeof input.notes === "string" && input.notes.length <= 20000,
      "工作备注最多能写 20000 个字",
    );
    if (item.notes !== input.notes) {
      item.notes = input.notes;
      item.updatedAt = env.now();
      item.revision++;
    }
    return { state, result: item };
  }
  throw new Error("此功能尚未提供离线版支持，请使用当前页面中的流程功能。");
}
