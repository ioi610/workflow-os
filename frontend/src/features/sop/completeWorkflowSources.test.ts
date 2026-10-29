import { describe, expect, it } from "vitest";
import type { Workflow, WorkflowDetailDocument } from "../../types";
import { completeWorkflowSources } from "./completeWorkflowSources";
import { generateWorkflow } from "./generatedWorkflow";
import { readWorkflow } from "./workflows";

const detail = (
  id: string,
  title: string,
  text: string,
): WorkflowDetailDocument => ({
  kind: "DETAIL",
  id,
  title,
  items: [{ id: `${id}-step`, text }],
});
const record = (
  id = "flow",
  details: WorkflowDetailDocument[] = [],
): Workflow => ({
  id,
  title: "流程",
  category: "日常",
  revision: 20,
  boardSettings: '{"saved":"board"}',
  draft: JSON.stringify([
    {
      kind: "MODULE",
      id: "rice",
      title: "蒸米饭",
      frame: { x: 50, y: 90, width: 80, height: 70 },
    },
    ...details,
  ]),
});
const backup = (details: WorkflowDetailDocument[], revision = 20) => ({
  revision,
  draft: {
    title: "旧标题",
    category: "旧分类",
    modules: [],
    details,
    boardSettings: null,
  },
});

describe("complete workflow sources", () => {
  it("includes locally written steps while keeping the newest saved framework unchanged", () => {
    const saved = record();
    const local = backup(
      [
        detail("instructions", "蒸米饭", "洗米后加水。"),
        detail("unfinished", "", ""),
      ],
      18,
    );
    const before = JSON.stringify({ saved, local });
    const result = completeWorkflowSources([saved], () => local);
    const preview = result.workflows[0];
    const generated = generateWorkflow(preview, result.workflows);
    expect(generated.entries[0].detail?.items[0].text).toBe("洗米后加水。");
    expect(readWorkflow(preview.draft).modules).toEqual(
      readWorkflow(saved.draft).modules,
    );
    expect(preview.boardSettings).toBe(saved.boardSettings);
    expect(preview.title).toBe(saved.title);
    expect(result.olderDrafts.has(saved.id)).toBe(true);
    expect(result.conflictingDrafts.size).toBe(0);
    expect(result.draftDetails.get(saved.id)?.has("instructions")).toBe(true);
    expect(result.usingLocalDrafts).toEqual(new Set([saved.id]));
    expect(JSON.stringify({ saved, local })).toBe(before);
  });

  it("defaults to saved instructions and includes partial local edits only when that source is selected", () => {
    const saved = record("flow", [
      detail("rice", "蒸米饭", "原步骤"),
      detail("remote", "洗抹布", "新写的做法"),
    ]);
    const edited = detail("rice", "蒸米饭", "本机修改");
    edited.items.push({ id: "blank", text: "" });
    const local = backup([edited], 19);
    const defaultResult = completeWorkflowSources([saved], () => local);
    expect(defaultResult.workflows[0]).toBe(saved);
    expect(defaultResult.usingLocalDrafts.size).toBe(0);
    const result = completeWorkflowSources(
      [saved],
      () => local,
      new Set([saved.id]),
    );
    const content = readWorkflow(result.workflows[0].draft);
    expect(content.details).toEqual([
      edited,
      detail("remote", "洗抹布", "新写的做法"),
    ]);
    expect(result.conflictingDrafts.has(saved.id)).toBe(true);
    expect(result.usingLocalDrafts).toEqual(new Set([saved.id]));
    expect(
      generateWorkflow(result.workflows[0], []).entries[0].contentStatus,
    ).toBe("INCOMPLETE");
  });

  it("includes shared-source drafts and preserves ambiguity rather than guessing a same-name match", () => {
    const saved = record();
    const source = { ...record("shared"), draft: "[]" };
    const result = completeWorkflowSources([saved, source], (id) =>
      id === "shared"
        ? backup([detail("shared-detail", "蒸米饭", "共享做法")])
        : null,
    );
    expect(
      generateWorkflow(result.workflows[0], result.workflows).entries[0].detail
        ?.items[0].text,
    ).toBe("共享做法");
    expect(result.usingLocalDrafts).toEqual(new Set(["shared"]));
    const ambiguous = completeWorkflowSources(
      [record("flow", [detail("remote", "蒸米饭", "已保存")])],
      () => backup([detail("other-id", "蒸米饭", "另一份")], 19),
    );
    expect(
      generateWorkflow(ambiguous.workflows[0], []).entries[0].detail?.items[0]
        .text,
    ).toBe("已保存");
    expect(ambiguous.conflictingDrafts.has("flow")).toBe(true);
    expect(ambiguous.usingLocalDrafts.size).toBe(0);
    const selected = completeWorkflowSources(
      [record("flow", [detail("remote", "蒸米饭", "已保存")])],
      () => backup([detail("other-id", "蒸米饭", "另一份")], 19),
      new Set(["flow"]),
    );
    expect(generateWorkflow(selected.workflows[0], []).entries[0].status).toBe(
      "AMBIGUOUS",
    );
    expect(selected.usingLocalDrafts).toEqual(new Set(["flow"]));
  });

  it("uses saved records as-is without drafts or when instructions are unchanged", () => {
    const saved = record("flow", [detail("rice", "蒸米饭", "已经保存")]);
    expect(completeWorkflowSources([saved], () => null).workflows[0]).toBe(
      saved,
    );
    const result = completeWorkflowSources([saved], () =>
      backup(readWorkflow(saved.draft).details),
    );
    expect(result.workflows[0]).toBe(saved);
    expect(result.draftDetails.size).toBe(0);
    expect(result.usingLocalDrafts.size).toBe(0);
  });

  it("does not replace different saved instructions by default even at the same revision", () => {
    const saved = record("flow", [detail("rice", "蒸米饭", "已保存内容")]);
    const result = completeWorkflowSources([saved], () =>
      backup([detail("rice", "蒸米饭", "本机不同内容")]),
    );
    expect(result.conflictingDrafts.has("flow")).toBe(true);
    expect(
      readWorkflow(result.workflows[0].draft).details[0].items[0].text,
    ).toBe("已保存内容");
    expect(result.workflows[0]).toBe(saved);
    expect(result.usingLocalDrafts.size).toBe(0);
    const selected = completeWorkflowSources(
      [saved],
      () => backup([detail("rice", "蒸米饭", "本机不同内容")]),
      new Set([saved.id]),
    );
    expect(
      readWorkflow(selected.workflows[0].draft).details[0].items[0].text,
    ).toBe("本机不同内容");
    expect(selected.conflictingDrafts.has(saved.id)).toBe(true);
    expect(selected.usingLocalDrafts).toEqual(new Set([saved.id]));
  });

  it("blocks recovery that would replace a shared written instruction with a local empty one", () => {
    const saved = record();
    const shared = {
      ...record("shared"),
      draft: JSON.stringify([detail("shared-rice", "蒸米饭", "共享已有做法")]),
    };
    const result = completeWorkflowSources([saved, shared], (id) =>
      id === "flow" ? backup([detail("local-empty", "蒸米饭", "")]) : null,
    );
    expect(result.conflictingDrafts.has("flow")).toBe(true);
    expect(generateWorkflow(saved, [saved, shared]).entries[0].detail?.id).toBe(
      "shared-rice",
    );
    expect(result.workflows[0]).toBe(saved);
    expect(result.workflows[1]).toBe(shared);
    expect(
      generateWorkflow(result.workflows[0], result.workflows).entries[0].detail
        ?.items[0].text,
    ).toBe("共享已有做法");
    expect(result.usingLocalDrafts.size).toBe(0);
    const selected = completeWorkflowSources(
      [saved, shared],
      (id) =>
        id === "flow" ? backup([detail("local-empty", "蒸米饭", "")]) : null,
      new Set(["flow"]),
    );
    expect(
      generateWorkflow(selected.workflows[0], selected.workflows).entries[0]
        .detail?.id,
    ).toBe("local-empty");
    expect(selected.usingLocalDrafts).toEqual(new Set(["flow"]));
  });

  it("keeps the entire saved source when a conflicting edit is mixed with otherwise safe additions", () => {
    const saved = record("flow", [detail("rice", "蒸米饭", "服务器最新做法")]);
    const local = backup(
      [
        detail("rice", "蒸米饭", "旧版做法"),
        detail("added", "准备餐具", "新写的餐具说明"),
      ],
      18,
    );
    const before = JSON.stringify({ saved, local });
    const result = completeWorkflowSources([saved], () => local);
    expect(result.workflows[0]).toBe(saved);
    expect(readWorkflow(result.workflows[0].draft).details).toEqual(
      readWorkflow(saved.draft).details,
    );
    expect(result.draftDetails.get(saved.id)).toEqual(
      new Set(["rice", "added"]),
    );
    expect(result.olderDrafts).toEqual(new Set([saved.id]));
    expect(result.conflictingDrafts).toEqual(new Set([saved.id]));
    const selected = completeWorkflowSources(
      [saved],
      () => local,
      new Set([saved.id]),
    );
    expect(
      readWorkflow(selected.workflows[0].draft).details.map(
        (entry) => entry.items[0].text,
      ),
    ).toEqual(["旧版做法", "新写的餐具说明"]);
    expect(selected.workflows[0].title).toBe(saved.title);
    expect(selected.workflows[0].boardSettings).toBe(saved.boardSettings);
    expect(readWorkflow(selected.workflows[0].draft).modules).toEqual(
      readWorkflow(saved.draft).modules,
    );
    expect(JSON.stringify({ saved, local })).toBe(before);
  });

  it("uses only explicitly selected conflicting sources and retains every backup and conflict for later choices", () => {
    const current = {
      ...record("current"),
      draft: JSON.stringify([
        {
          kind: "MODULE",
          id: "one",
          title: "蒸米饭",
          detailWorkflowId: "left",
        },
        {
          kind: "MODULE",
          id: "two",
          title: "洗餐具",
          detailWorkflowId: "right",
        },
      ]),
    };
    const left = {
      ...record("left"),
      draft: JSON.stringify([
        detail("left-detail", "蒸米饭", "左侧服务器原文"),
      ]),
    };
    const right = {
      ...record("right"),
      draft: JSON.stringify([
        detail("right-detail", "洗餐具", "右侧服务器原文"),
      ]),
    };
    const records = [current, left, right];
    const drafts = new Map([
      ["left", backup([detail("left-detail", "蒸米饭", "左侧本机原文")], 18)],
      ["right", backup([detail("right-detail", "洗餐具", "右侧本机原文")], 19)],
    ]);
    const preferLocal = new Set(["left"]);
    const before = JSON.stringify({
      records,
      drafts: [...drafts],
      selected: [...preferLocal],
    });
    const result = completeWorkflowSources(
      records,
      (id) => drafts.get(id) ?? null,
      preferLocal,
    );
    expect(result.usingLocalDrafts).toEqual(new Set(["left"]));
    expect(result.conflictingDrafts).toEqual(new Set(["left", "right"]));
    expect(result.olderDrafts).toEqual(new Set(["left", "right"]));
    expect(result.workflows[0]).toBe(current);
    expect(result.workflows[2]).toBe(right);
    expect(
      generateWorkflow(result.workflows[0], result.workflows).entries.map(
        (entry) => entry.detail?.items[0].text,
      ),
    ).toEqual(["左侧本机原文", "右侧服务器原文"]);
    expect(
      JSON.stringify({
        records,
        drafts: [...drafts],
        selected: [...preferLocal],
      }),
    ).toBe(before);
    const original = completeWorkflowSources(records, () => null, preferLocal);
    expect(original.workflows).toEqual(records);
    expect(original.usingLocalDrafts.size).toBe(0);
  });
});
