import type { PlainTextWorkflowMatch } from "./plainTextWorkflowRestore";
import {
  parseWorkflowTransfer,
  WORKFLOW_TRANSFER_MAX_LENGTH,
} from "./workflowTransfer";
import { readWorkflow } from "./workflows";

type Scope = { userId: string; orgId: string };
type CopyRecord = {
  text: string;
  transferText: string;
  sourceWorkflowId: string;
  copiedAt: number;
};
const MAX_COPIES = 20;
const MAX_CACHE_LENGTH = 2 * 1024 * 1024;
const memory = new Map<string, CopyRecord[]>();
const normalize = (text: string) => text.replace(/\r\n?/g, "\n").trim();

export function workflowCopySnapshotKey(scope: Scope): string {
  return `workflow-os:copied-flow:${JSON.stringify([scope.userId, scope.orgId])}`;
}

function validScope(scope: Scope) {
  return (
    typeof scope.userId === "string" &&
    !!scope.userId &&
    typeof scope.orgId === "string" &&
    !!scope.orgId
  );
}

function record(value: unknown): value is CopyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const copy = value as Partial<CopyRecord>;
  return (
    typeof copy.text === "string" &&
    !!normalize(copy.text) &&
    copy.text.length <= WORKFLOW_TRANSFER_MAX_LENGTH &&
    typeof copy.transferText === "string" &&
    copy.transferText.length <= WORKFLOW_TRANSFER_MAX_LENGTH &&
    typeof copy.sourceWorkflowId === "string" &&
    !!copy.sourceWorkflowId &&
    typeof copy.copiedAt === "number" &&
    Number.isSafeInteger(copy.copiedAt) &&
    copy.copiedAt >= 0
  );
}

function identity(copy: CopyRecord) {
  return JSON.stringify([copy.sourceWorkflowId, normalize(copy.text)]);
}

function deduplicate(copies: CopyRecord[]): CopyRecord[] {
  const seen = new Set<string>();
  return copies
    .sort((left, right) => right.copiedAt - left.copiedAt)
    .filter((copy) => {
      const key = identity(copy);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_COPIES);
}

function load(scope: Scope): CopyRecord[] {
  const key = workflowCopySnapshotKey(scope);
  let stored: CopyRecord[] = [];
  try {
    const raw = localStorage.getItem(key);
    if (raw && raw.length <= MAX_CACHE_LENGTH) {
      const value = JSON.parse(raw);
      if (value?.version === 1 && Array.isArray(value.entries))
        stored = value.entries.slice(0, MAX_COPIES).filter(record);
    }
  } catch {
    // A disabled or full browser store must not affect ordinary clipboard use.
  }
  return deduplicate([...(memory.get(key) || []), ...stored]);
}

function keepInMemory(key: string, copies: CopyRecord[]) {
  const bounded = [...copies];
  while (
    bounded.length > 1 &&
    JSON.stringify(bounded).length > MAX_CACHE_LENGTH
  )
    bounded.pop();
  memory.delete(key);
  memory.set(key, bounded);
  while (memory.size > 8) memory.delete(memory.keys().next().value!);
}

/** Called only by an explicit copy action. Never changes a workflow or its source. */
export function rememberWorkflowCopySnapshot(
  input: Scope & {
    text: string;
    transferText: string;
    sourceWorkflowId: string;
  },
): { remembered: boolean; persisted: boolean } {
  if (!validScope(input)) return { remembered: false, persisted: false };
  try {
    const transfer = parseWorkflowTransfer(input.transferText);
    if (
      !transfer ||
      transfer.sourceWorkflowId !== input.sourceWorkflowId ||
      normalize(transfer.prose) !== normalize(input.text) ||
      !normalize(input.text)
    )
      return { remembered: false, persisted: false };
    const previous = load(input);
    const copy: CopyRecord = {
      text: input.text,
      transferText: input.transferText,
      sourceWorkflowId: input.sourceWorkflowId,
      copiedAt: Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.max(Date.now(), (previous[0]?.copiedAt ?? 0) + 1),
      ),
    };
    const copies = deduplicate([copy, ...previous]);
    const key = workflowCopySnapshotKey(input);
    keepInMemory(key, copies);
    const persisted = [...copies];
    while (
      persisted.length &&
      JSON.stringify({ version: 1, entries: persisted }).length >
        MAX_CACHE_LENGTH
    )
      persisted.pop();
    if (!persisted.some((entry) => entry === copy))
      return { remembered: true, persisted: false };
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ version: 1, entries: persisted }),
      );
      return { remembered: true, persisted: true };
    } catch {
      return { remembered: true, persisted: false };
    }
  } catch {
    return { remembered: false, persisted: false };
  }
}

/** Most recent explicit matching copy is first; unrelated users/workspaces are never read. */
export function findRecordedWorkflowCopies(
  scope: Scope,
  text: string,
): PlainTextWorkflowMatch[] {
  if (!validScope(scope) || !normalize(text)) return [];
  const pasted = normalize(text);
  const matches: PlainTextWorkflowMatch[] = [];
  let damagedMatch = false;
  for (const copy of load(scope)) {
    const body = normalize(copy.text);
    if (pasted !== body && !pasted.endsWith(`\n${body}`)) continue;
    try {
      const transfer = parseWorkflowTransfer(copy.transferText);
      if (
        !transfer ||
        transfer.sourceWorkflowId !== copy.sourceWorkflowId ||
        normalize(copy.text) !== normalize(transfer.prose)
      ) {
        if (pasted === normalize(copy.text)) damagedMatch = true;
        continue;
      }
      if (
        pasted !== body &&
        pasted !== normalize(`${transfer.title}\n${body}`) &&
        pasted !== normalize(`${transfer.title}\n\n${body}`)
      )
        continue;
      matches.push({
        workflowId: copy.sourceWorkflowId,
        title: transfer.title,
        moduleCount: readWorkflow(JSON.stringify(transfer.steps)).modules
          .length,
        transfer,
      });
    } catch {
      if (pasted === normalize(copy.text)) damagedMatch = true;
    }
  }
  if (!matches.length && damagedMatch)
    throw new Error("这份文字对应的原图副本已损坏，请从原流程重新复制全文。");
  return matches;
}
