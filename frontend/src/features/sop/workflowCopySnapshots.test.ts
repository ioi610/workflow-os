import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workflow, WorkflowStep } from "../../types";
import { DEFAULT_BOARD_AXES } from "./boardAxes";
import { completeWorkflowText } from "./completeWorkflowText";
import { generateWorkflow } from "./generatedWorkflow";
import {
  findRecordedWorkflowCopies,
  rememberWorkflowCopySnapshot,
  workflowCopySnapshotKey,
} from "./workflowCopySnapshots";
import { serializeWorkflowTransfer } from "./workflowTransfer";

let sequence = 0;
let store: Map<string, string>;
const scope = () => ({ userId: `copy-user-${++sequence}`, orgId: "personal" });

function workflow(count = 33, id = "source"): Workflow {
  const steps: WorkflowStep[] = [];
  for (let i = 0; i < count; i++) {
    steps.push(
      {
        kind: "MODULE",
        id: `work-${i}`,
        title: `工作${i + 1}`,
        detailId: `detail-${i}`,
        frame: {
          x: (i % 6) * 125,
          y: Math.floor(i / 6) * 100,
          width: 100,
          height: 72,
        },
        ...(i < count - 1
          ? {
              nextModuleIds: [`work-${i + 1}`],
              connectionPorts: {
                [`work-${i + 1}`]: { source: "bottom", target: "left" },
              },
            }
          : {}),
      },
      {
        kind: "DETAIL",
        id: `detail-${i}`,
        title: `工作${i + 1}`,
        items: [{ id: `step-${i}`, text: `这项工作的完整做法${i + 1}。` }],
      },
    );
  }
  return {
    id,
    title: "原来的流程",
    category: "自用",
    revision: 7,
    draft: JSON.stringify(steps),
    boardSettings: JSON.stringify({
      ...DEFAULT_BOARD_AXES,
      canvas: { width: 1400, height: 900 },
      timeline: {
        enabled: true,
        axis: "x",
        startMinute: 480,
        endMinute: 1140,
        segments: [{ startOffset: 60, endOffset: 120, scale: 4 }],
      },
      priority: { enabled: true, axis: "y" },
    }),
  };
}

function copy(
  source: Workflow,
  text = completeWorkflowText(source, generateWorkflow(source, [source])),
) {
  return {
    text,
    transferText: serializeWorkflowTransfer(source, [source], text),
    sourceWorkflowId: source.id,
  };
}

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => store.set(key, value)),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ordinary copied prose remembers its exact original diagram", () => {
  it("recovers all 33 original boxes, arrows, axes and instructions from plain paragraphs without network or business writes", () => {
    const source = workflow(),
      owner = scope(),
      copied = copy(source);
    const before = JSON.stringify(source);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("must stay local");
      }),
    );
    expect(copied.text).not.toContain("WORKFLOW OS RESTORE");
    expect(rememberWorkflowCopySnapshot({ ...owner, ...copied })).toEqual({
      remembered: true,
      persisted: true,
    });
    const [match] = findRecordedWorkflowCopies(owner, copied.text);
    expect(match.moduleCount).toBe(33);
    expect(match.transfer.steps).toEqual(JSON.parse(source.draft));
    expect(match.transfer.boardSettings).toBe(source.boardSettings);
    expect(match.transfer.prose).toBe(copied.text);
    expect(JSON.stringify(source)).toBe(before);
    expect(fetch).not.toHaveBeenCalled();
    expect([...store.keys()]).toEqual([workflowCopySnapshotKey(owner)]);
  });

  it("keeps the layout at copy time when the source later changes, including after a page reload", async () => {
    const source = workflow(2),
      owner = scope(),
      copied = copy(source);
    const original = JSON.parse(source.draft);
    rememberWorkflowCopySnapshot({ ...owner, ...copied });
    const changed = JSON.parse(source.draft);
    changed[0].frame.x = 400;
    source.draft = JSON.stringify(changed);
    vi.resetModules();
    const reloaded = await import("./workflowCopySnapshots");
    expect(
      reloaded.findRecordedWorkflowCopies(owner, copied.text)[0].transfer.steps,
    ).toEqual(original);
  });

  it("isolates copies by user and workspace and leaves existing local editor backups intact", () => {
    const owner = scope(),
      copied = copy(workflow(2));
    store.set("workflow-editor-backup", "keep this unsaved work");
    rememberWorkflowCopySnapshot({ ...owner, ...copied });
    expect(
      findRecordedWorkflowCopies(
        { ...owner, userId: "other-user" },
        copied.text,
      ),
    ).toEqual([]);
    expect(
      findRecordedWorkflowCopies(
        { ...owner, orgId: "other-workspace" },
        copied.text,
      ),
    ).toEqual([]);
    expect(
      findRecordedWorkflowCopies({ ...owner, userId: "" }, copied.text),
    ).toEqual([]);
    expect(store.get("workflow-editor-backup")).toBe("keep this unsaved work");
  });

  it("uses the most recent explicit copy even when prose is identical and the clock moves backwards", () => {
    const owner = scope(),
      first = workflow(2, "first"),
      second = workflow(2, "second"),
      text = "完全相同的正文。";
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(2000);
    rememberWorkflowCopySnapshot({ ...owner, ...copy(first, text) });
    now.mockReturnValue(1000);
    rememberWorkflowCopySnapshot({ ...owner, ...copy(second, text) });
    expect(
      findRecordedWorkflowCopies(owner, text).map((m) => m.workflowId),
    ).toEqual(["second", "first"]);
    const steps = JSON.parse(second.draft);
    steps[0].frame.x = 450;
    second.draft = JSON.stringify(steps);
    rememberWorkflowCopySnapshot({ ...owner, ...copy(second, text) });
    const matches = findRecordedWorkflowCopies(owner, text);
    expect(matches).toHaveLength(2);
    expect(matches[0].transfer.steps).toEqual(steps);
    now.mockRestore();
  });

  it("accepts exact body or whole-paper title with clipboard line endings, and never matches altered or partial prose", () => {
    const owner = scope(),
      source = workflow(2),
      copied = copy(source);
    rememberWorkflowCopySnapshot({ ...owner, ...copied });
    for (const text of [
      copied.text,
      ` \r\n${copied.text}\r\n `,
      `${source.title}\n${copied.text}`,
      `${source.title}\r\n\r\n${copied.text.replace(/\n/g, "\r\n")}`,
    ])
      expect(findRecordedWorkflowCopies(owner, text)[0].moduleCount).toBe(2);
    for (const text of [
      "",
      copied.text.slice(0, 10),
      copied.text + "添加文字",
      copied.text.replace("。", "！"),
    ])
      expect(findRecordedWorkflowCopies(owner, text)).toEqual([]);
  });

  it("restores within the open page even if browser storage is unavailable", () => {
    const owner = scope(),
      copied = copy(workflow(2));
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("disabled");
      },
      setItem() {
        throw new Error("quota");
      },
    });
    expect(rememberWorkflowCopySnapshot({ ...owner, ...copied })).toEqual({
      remembered: true,
      persisted: false,
    });
    expect(findRecordedWorkflowCopies(owner, copied.text)[0].moduleCount).toBe(
      2,
    );
  });

  it("rejects mismatched snapshots rather than associating prose with an unrelated graph", () => {
    const owner = scope(),
      copied = copy(workflow(2));
    for (const change of [
      { text: "别的正文" },
      { sourceWorkflowId: "unrelated" },
      { transferText: "broken" },
    ])
      expect(
        rememberWorkflowCopySnapshot({ ...owner, ...copied, ...change }),
      ).toEqual({ remembered: false, persisted: false });
    expect(findRecordedWorkflowCopies(owner, copied.text)).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("blocks guessing for a known damaged copy while still accepting a valid matching snapshot", () => {
    const owner = scope(),
      text = "完整正文。",
      valid = copy(workflow(2), text);
    const damaged = {
      ...valid,
      copiedAt: 100,
      transferText: "-----BEGIN WORKFLOW OS RESTORE-----\nbroken",
    };
    store.set(
      workflowCopySnapshotKey(owner),
      JSON.stringify({ version: 1, entries: [damaged] }),
    );
    expect(() => findRecordedWorkflowCopies(owner, text)).toThrow(
      "原图副本已损坏",
    );
    expect(findRecordedWorkflowCopies(owner, "新写的其他正文")).toEqual([]);
    rememberWorkflowCopySnapshot({
      ...owner,
      ...valid,
      sourceWorkflowId: valid.sourceWorkflowId,
    });
    expect(findRecordedWorkflowCopies(owner, text)[0].moduleCount).toBe(2);
  });

  it("evicts older copies after 20 explicit copies without changing any workflow", () => {
    const owner = scope();
    for (let i = 0; i < 23; i++)
      expect(
        rememberWorkflowCopySnapshot({
          ...owner,
          ...copy(workflow(1, `diagram-${i}`), `正文${i}。`),
        }).remembered,
      ).toBe(true);
    expect(findRecordedWorkflowCopies(owner, "正文0。")).toEqual([]);
    expect(findRecordedWorkflowCopies(owner, "正文22。")[0].workflowId).toBe(
      "diagram-22",
    );
    expect(
      JSON.parse(store.get(workflowCopySnapshotKey(owner))!).entries,
    ).toHaveLength(20);
  });

  it("bounds large copies in memory and storage while retaining the latest complete diagram", () => {
    const owner = scope();
    for (let i = 0; i < 3; i++) {
      const source = workflow(1, `large-${i}`);
      const steps = JSON.parse(source.draft);
      steps[0].description = "长说明".repeat(240_000);
      source.draft = JSON.stringify(steps);
      expect(
        rememberWorkflowCopySnapshot({
          ...owner,
          ...copy(source, `大型正文${i}`),
        }),
      ).toEqual({ remembered: true, persisted: true });
    }
    expect(findRecordedWorkflowCopies(owner, "大型正文0")).toEqual([]);
    const [latest] = findRecordedWorkflowCopies(owner, "大型正文2");
    expect(latest.workflowId).toBe("large-2");
    expect(latest.transfer.steps[0].description).toHaveLength(720_000);
    const raw = store.get(workflowCopySnapshotKey(owner))!;
    expect(raw.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(JSON.parse(raw).entries).toHaveLength(2);
  });
});
