import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, Workflow } from "../../types";
import { DEFAULT_BOARD_AXES } from "./boardAxes";
import { completeWorkflowText } from "./completeWorkflowText";
import { generateWorkflow } from "./generatedWorkflow";
import { parseWorkflowTransfer } from "./workflowTransfer";

const harness = vi.hoisted(() => ({
  records: [] as Workflow[],
  refs: [] as { current: unknown }[],
  cursor: 0,
  updates: [] as { index: number; value: unknown }[],
  states: [] as unknown[],
  stateCursor: 0,
  effects: [] as (() => unknown)[],
  remember: vi.fn(),
  request: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = harness.stateCursor++;
    if (!(index in harness.states)) harness.states[index] = initial;
    return [
      harness.states[index],
      (value: unknown) => {
        harness.updates.push({ index, value });
        harness.states[index] = value;
      },
    ];
  },
  useMemo: (calculate: () => unknown) => calculate(),
  useRef: (initial: unknown) => {
    const index = harness.cursor++;
    return (harness.refs[index] ??= { current: initial });
  },
  useEffect: (effect: () => unknown) => harness.effects.push(effect),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: harness.records, isPending: false, isError: false }),
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ id: "copy-flow" }),
  Link: "a",
}));
vi.mock("../../api", () => ({ api: harness.request }));
// The snapshot registry itself has separate persistence and scope tests. Here we
// exercise the real page handlers and inspect the complete snapshot they send.
vi.mock("./workflowCopySnapshots", () => ({
  rememberWorkflowCopySnapshot: harness.remember,
}));
import { CompleteWorkflow } from "./CompleteWorkflow";

const context: Context = {
  org: "copy-org",
  user: { id: "copy-person" },
  role: "OWNER",
  notify: vi.fn(),
};

function flow(): Workflow {
  return {
    id: "copy-flow",
    title: "三十三项工作",
    category: "自己的分类",
    revision: 10,
    boardSettings: JSON.stringify({
      ...DEFAULT_BOARD_AXES,
      canvas: { width: 1200, height: 820 },
      timeline: {
        enabled: true,
        startMinute: 420,
        endMinute: 1140,
        axis: "x",
        segments: [{ startOffset: 60, endOffset: 120, scale: 3 }],
      },
    }),
    draft: JSON.stringify(
      Array.from({ length: 33 }, (_, i) => [
        {
          kind: "MODULE",
          id: `m-${i}`,
          title: `工作 ${i + 1}`,
          frame: {
            x: (i % 7) * 110,
            y: Math.floor(i / 7) * 100,
            width: 80,
            height: 60,
          },
          ...(i < 32
            ? {
                nextModuleIds: [`m-${i + 1}`],
                connectionPorts: {
                  [`m-${i + 1}`]: { source: "bottom", target: "left" },
                },
              }
            : {}),
        },
        {
          kind: "DETAIL",
          id: `d-${i}`,
          title: `工作 ${i + 1}`,
          items: [{ id: `item-${i}`, text: `手写做法 ${i + 1}。` }],
        },
      ]).flat(),
    ),
  };
}

type Element = ReactElement<Record<string, any>>;
function descendants(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (node === null || typeof node !== "object" || !("props" in node))
    return [];
  const element = node as Element;
  return [element, ...descendants(element.props.children)];
}
function label(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(label).join("");
  if (typeof node === "string") return node;
  if (node !== null && typeof node === "object" && "props" in node)
    return label((node as Element).props.children);
  return "";
}
function render() {
  harness.cursor = 0;
  harness.stateCursor = 0;
  return CompleteWorkflow(context);
}
function copyButton(tree: ReactNode) {
  return descendants(tree).find(
    (element) =>
      element.type === "button" &&
      ["复制全文", "已复制"].includes(label(element)),
  )!;
}

beforeEach(() => {
  harness.records = [flow()];
  harness.refs = [];
  harness.cursor = 0;
  harness.updates = [];
  harness.states = [];
  harness.stateCursor = 0;
  harness.effects = [];
  harness.remember
    .mockReset()
    .mockReturnValue({ remembered: true, persisted: true });
  harness.request.mockReset();
  vi.stubGlobal("localStorage", {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: vi.fn(),
  });
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("one complete workflow copy includes portable diagram restoration", () => {
  it("does not remember a diagram merely by opening the complete prose page", () => {
    render();
    expect(harness.remember).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("copies readable prose and all 33 boxes, details, geometry, arrows and axes together", async () => {
    const original = structuredClone(harness.records[0]);
    const tree = render();
    copyButton(tree).props.onClick();
    await vi.waitFor(() => expect(harness.remember).toHaveBeenCalledOnce());
    const text = completeWorkflowText(
      original,
      generateWorkflow(original, [original]),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledOnce();
    expect(text).not.toContain("WORKFLOW OS RESTORE");
    const copiedText = vi.mocked(navigator.clipboard.writeText).mock
      .calls[0][0];
    expect(
      copiedText.startsWith(`${text}\n\n-----BEGIN WORKFLOW OS RESTORE-----`),
    ).toBe(true);
    const snapshot = harness.remember.mock.calls[0]?.[0];
    expect(snapshot).toMatchObject({
      text,
      sourceWorkflowId: original.id,
      userId: context.user.id,
      orgId: context.org,
    });
    expect(snapshot.transferText).toBe(copiedText);
    const transfer = parseWorkflowTransfer(copiedText)!;
    expect(transfer.prose).toBe(text);
    expect(transfer.boardSettings).toBe(original.boardSettings);
    expect(
      transfer.steps.filter((step) => step.kind === "MODULE"),
    ).toHaveLength(33);
    expect(transfer.steps).toEqual(JSON.parse(original.draft));
    expect(transfer.referencedDetails).toHaveLength(33);
    expect(harness.records[0]).toEqual(original);
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("remembers manual prose copies without changing clipboard content or requesting data", () => {
    const tree = render();
    const paper = descendants(tree).find(
      (element) => element.props.className === "complete-paper",
    )!;
    expect(paper.props.onCopy).toBeTypeOf("function");
    paper.props.onCopy();
    expect(harness.remember).toHaveBeenCalledOnce();
    expect(
      parseWorkflowTransfer(
        harness.remember.mock.calls[0][0].transferText,
      )?.steps.filter((step) => step.kind === "MODULE"),
    ).toHaveLength(33);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("offers the same complete portable text when automatic clipboard access fails", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(
      Error("clipboard blocked"),
    );
    copyButton(render()).props.onClick();
    const copiedText = vi.mocked(navigator.clipboard.writeText).mock
      .calls[0][0];
    await vi.waitFor(() =>
      expect(harness.updates).toContainEqual({ index: 2, value: copiedText }),
    );
    expect(harness.remember).not.toHaveBeenCalled();
    const fallback = descendants(render()).find(
      (element) =>
        element.type === "textarea" &&
        element.props["aria-label"] === "完整流程文本",
    )!;
    expect(fallback.props.value).toBe(copiedText);
    expect(parseWorkflowTransfer(fallback.props.value)?.prose).toBe(
      completeWorkflowText(
        harness.records[0],
        generateWorkflow(harness.records[0], harness.records),
      ),
    );
    expect(
      parseWorkflowTransfer(fallback.props.value)?.steps.filter(
        (step) => step.kind === "MODULE",
      ),
    ).toHaveLength(33);
    // This fallback travels with its diagram and does not depend on a local
    // provenance write when the user selects and copies it manually.
    expect(fallback.props.onCopy).toBeUndefined();
    expect(harness.remember).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("a storage failure cannot prevent the portable complete workflow from being copied", async () => {
    harness.remember.mockImplementation(() => {
      throw Error("storage unavailable");
    });
    copyButton(render()).props.onClick();
    await vi.waitFor(() =>
      expect(harness.updates).toContainEqual({ index: 1, value: true }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledOnce();
    expect(
      parseWorkflowTransfer(
        vi.mocked(navigator.clipboard.writeText).mock.calls[0][0],
      )?.steps.filter((step) => step.kind === "MODULE"),
    ).toHaveLength(33);
    expect(harness.updates).toContainEqual({ index: 1, value: true });
    expect(
      harness.updates.some((update) => update.index === 2 && update.value),
    ).toBe(false);
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("captures the copied layout before asynchronous clipboard work and ignores stale completion", async () => {
    let finish!: () => void;
    vi.mocked(navigator.clipboard.writeText).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const original = structuredClone(harness.records[0]);
    const first = render();
    copyButton(first).props.onClick();
    copyButton(first).props.onClick();
    expect(harness.remember).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).toHaveBeenCalledOnce();
    const changed = JSON.parse(original.draft);
    changed[0].frame.x = 12;
    harness.records = [
      { ...original, revision: 11, draft: JSON.stringify(changed) },
    ];
    render();
    finish();
    await vi.waitFor(() =>
      expect(harness.updates).toContainEqual({ index: 0, value: false }),
    );
    expect(harness.remember).toHaveBeenCalledOnce();
    expect(
      parseWorkflowTransfer(harness.remember.mock.calls[0][0].transferText)
        ?.steps,
    ).toEqual(JSON.parse(original.draft));
    expect(harness.remember.mock.calls[0][0].transferText).toBe(
      vi.mocked(navigator.clipboard.writeText).mock.calls[0][0],
    );
    expect(harness.updates).not.toContainEqual({ index: 1, value: true });
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("does not replace successful clipboard provenance when copying a changed layout with identical prose fails", async () => {
    const original = structuredClone(harness.records[0]);
    copyButton(render()).props.onClick();
    await vi.waitFor(() => expect(harness.remember).toHaveBeenCalledOnce());
    const firstText = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    const changed = JSON.parse(original.draft);
    // Move perpendicular to the time axis so the prose stays identical while
    // its portable layout snapshot changes.
    changed[0].frame.y = 12;
    harness.records = [
      { ...original, revision: 11, draft: JSON.stringify(changed) },
    ];
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(
      Error("clipboard blocked"),
    );
    copyButton(render()).props.onClick();
    await vi.waitFor(() =>
      expect(
        harness.updates.some((update) => update.index === 2 && update.value),
      ).toBe(true),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2);
    const failedText = vi.mocked(navigator.clipboard.writeText).mock
      .calls[1][0];
    expect(failedText).not.toBe(firstText);
    expect(parseWorkflowTransfer(failedText)?.prose).toBe(
      parseWorkflowTransfer(firstText)?.prose,
    );
    expect(parseWorkflowTransfer(failedText)?.steps).toEqual(changed);
    expect(harness.updates).toContainEqual({ index: 2, value: failedText });
    expect(harness.remember).toHaveBeenCalledOnce();
    expect(
      parseWorkflowTransfer(harness.remember.mock.calls[0][0].transferText)
        ?.steps,
    ).toEqual(JSON.parse(original.draft));
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("copies an empty framework with its settings even when there is no prose", async () => {
    harness.records = [{ ...flow(), draft: "[]" }];
    const button = copyButton(render());
    expect(button.props.disabled).toBeFalsy();
    button.props.onClick();
    await vi.waitFor(() =>
      expect(harness.updates).toContainEqual({ index: 1, value: true }),
    );
    const transfer = parseWorkflowTransfer(
      vi.mocked(navigator.clipboard.writeText).mock.calls[0][0],
    );
    expect(transfer?.steps).toEqual([]);
    expect(transfer?.boardSettings).toBe(harness.records[0].boardSettings);
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("reports an unrestorable diagram instead of copying incomplete plain prose", async () => {
    harness.records = [{ ...flow(), boardSettings: "{broken" }];
    copyButton(render()).props.onClick();
    await vi.waitFor(() =>
      expect(harness.updates).toContainEqual({
        index: 3,
        value: "还原文字中的流程图设置已损坏。",
      }),
    );
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(harness.remember).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
  });
});
