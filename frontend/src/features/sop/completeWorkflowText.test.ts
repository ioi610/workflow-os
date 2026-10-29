import { describe, expect, it } from "vitest";
import type { Workflow, WorkflowDetailDocument } from "../../types";
import type {
  GeneratedWorkflow,
  GeneratedWorkflowEntry,
} from "./generatedWorkflow";
import {
  completeEntryNotice,
  completeTextValue,
  completeWorkflowParagraphs,
  completeWorkflowText,
} from "./completeWorkflowText";
import { connectProcedure } from "./connectedProcedure";

const workflow: Workflow = {
  id: "board",
  title: "晨间准备",
  category: "日常工作",
  revision: 5,
  draft: "[]",
};
const detail = (
  patch: Partial<WorkflowDetailDocument> = {},
): WorkflowDetailDocument => ({
  kind: "DETAIL",
  id: "instructions",
  title: "检查做法",
  items: [{ id: "step", text: "检查电源" }],
  ...patch,
});
const entry = (
  id: string,
  name: string,
  patch: Partial<GeneratedWorkflowEntry> = {},
): GeneratedWorkflowEntry => ({
  id,
  name,
  module: { kind: "MODULE", id, title: name },
  sourceIndex: 0,
  from: [],
  to: [],
  isolated: true,
  status: "MATCHED",
  sourceMissing: false,
  detail: detail({ title: name }),
  ...patch,
});
const generated = (
  entries: GeneratedWorkflowEntry[],
  patch: Partial<GeneratedWorkflow> = {},
): GeneratedWorkflow => ({
  mode: "source",
  entries,
  groups: [
    {
      id: "group",
      label: "已安排的工作",
      kind: "source",
      entryIds: entries.map((item) => item.id),
      cycleIds: [],
    },
  ],
  edges: [],
  cycles: [],
  warnings: [],
  ...patch,
});

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

describe("complete workflow prose", () => {
  it("connects neighboring work and unfinished clause fragments into one paragraph using punctuation only", () => {
    const summary = generated([
      entry("rice", "蒸米饭", {
        detail: detail({
          items: [
            { id: "one", text: "把米倒进锅里" },
            { id: "two", text: "倒入水" },
            { id: "three", text: "开火蒸米饭" },
          ],
        }),
      }),
      entry("eggs", "煮鸡蛋", {
        detail: detail({
          items: [
            { id: "one", text: "拿出锅" },
            { id: "two", text: "加水" },
            { id: "three", text: "煮8分50秒" },
          ],
        }),
      }),
    ]);
    const expected =
      "蒸米饭：把米倒进锅里，倒入水，开火蒸米饭。煮鸡蛋：拿出锅，加水，煮8分50秒。";

    expect(completeWorkflowParagraphs(workflow, summary)).toEqual([expected]);
    expect(completeWorkflowText(workflow, summary)).toBe(expected);
  });

  it("preserves complete sentences, conditions, negation, quoted punctuation, numbers and the user's step order", () => {
    const summary = generated([
      entry("heat", "加热", {
        detail: detail({
          items: [
            { id: "one", text: "不要关电源，等 30 分钟。" },
            { id: "two", text: "若水温低于 60℃，继续加热；否则停止。" },
            { id: "three", text: "确认“第2次测试通过！”" },
            { id: "four", text: "加入1.5 L水" },
            { id: "five", text: "读数是3.14吗？" },
          ],
        }),
      }),
    ]);
    expect(completeWorkflowText(workflow, summary)).toBe(
      "加热：不要关电源，等 30 分钟。若水温低于 60℃，继续加热；否则停止。确认“第2次测试通过！”加入1.5 L水，读数是3.14吗？",
    );
  });

  it("includes each scheduled clock time, including the next day, without inventing durations or changing the original text", () => {
    const summary = generated([
      entry("night", "准备材料", {
        minute: 1430,
        time: "23:50",
        detail: detail({ items: [{ id: "one", text: "量取200克原料" }] }),
      }),
      entry("next-day", "加热", {
        minute: 1455,
        time: "次日 00:15",
        detail: detail({
          items: [{ id: "one", text: "加热30分钟，不要关电源" }],
        }),
      }),
      entry("untimed", "收拾工具", {
        detail: detail({ items: [{ id: "one", text: "擦干后收好" }] }),
      }),
    ]);
    const before = JSON.stringify(summary);
    const expected =
      "23:50 准备材料：量取200克原料。次日 00:15 加热：加热30分钟，不要关电源。收拾工具：擦干后收好。";
    expect(completeWorkflowParagraphs(workflow, freeze(summary))).toEqual([
      expected,
    ]);
    expect(completeWorkflowText(workflow, summary)).toBe(expected);
    expect(JSON.stringify(summary)).toBe(before);
  });

  it("keeps a scheduled time with an unfilled work name without adding a missing-content message", () => {
    const summary = generated([
      entry("blank", "检查设备", { time: "09:05", status: "MISSING" }),
      entry("untimed", "整理工具", {
        status: "MISSING",
      }),
    ]);
    expect(completeWorkflowText(workflow, summary)).toBe(
      "09:05 检查设备。整理工具。",
    );
  });

  it.each(["，", ",", "；", ";", "：", ":", "、"])(
    "closes a work unit ending in %s before starting the next work",
    (punctuation) => {
      const summary = generated([
        entry("rice", "蒸米饭", {
          detail: detail({
            items: [{ id: "one", text: `开火蒸米饭${punctuation}` }],
          }),
        }),
        entry("eggs", "煮鸡蛋", {
          detail: detail({ items: [{ id: "one", text: "煮8分50秒" }] }),
        }),
      ]);
      expect(completeWorkflowText(workflow, summary)).toBe(
        "蒸米饭：开火蒸米饭。煮鸡蛋：煮8分50秒。",
      );
    },
  );

  it("closes trailing clause punctuation inside quotes without changing inner clauses or existing sentence endings", () => {
    const summary = generated([
      entry("first", "检查", {
        detail: detail({
          items: [
            { id: "one", text: "若水温低于60℃，继续加热；否则停止。" },
            { id: "two", text: "读数是3.14吗？" },
            { id: "three", text: "确认“不要关电源，”" },
          ],
        }),
      }),
      entry("second", "确认", {
        detail: detail({ items: [{ id: "one", text: "确认“第2次通过！”" }] }),
      }),
      entry("third", "收尾", {
        detail: detail({ items: [{ id: "one", text: "完成。；" }] }),
      }),
    ]);
    expect(completeWorkflowText(workflow, summary)).toBe(
      "检查：若水温低于60℃，继续加热；否则停止。读数是3.14吗？确认“不要关电源。”确认：确认“第2次通过！”收尾：完成。",
    );
  });

  it("joins line-separated instructions as clauses rather than a whitespace-only word sequence", () => {
    const summary = generated([
      entry("rice", "蒸米饭", {
        detail: detail({
          items: [
            {
              id: "one",
              text: "淘米\n\n放入锅中\r\n加入1.5 L水，\n不要关电源，等30分钟。\n确认“第2次通过！”\n检查压力？",
            },
          ],
        }),
      }),
    ]);
    expect(completeWorkflowText(workflow, summary)).toBe(
      "蒸米饭：淘米，放入锅中，加入1.5 L水，不要关电源，等30分钟。确认“第2次通过！”检查压力？",
    );
  });

  it("uses an English full stop for English clauses and preserves decimal quantities", () => {
    const summary = generated([
      entry("mix", "Mix", {
        detail: detail({
          items: [{ id: "one", text: "Add 1.5 L,\nDo not stop;" }],
        }),
      }),
      entry("heat", "Heat", {
        detail: detail({ items: [{ id: "one", text: 'Confirm "Ready!"' }] }),
      }),
    ]);
    expect(completeWorkflowText(workflow, summary)).toBe(
      'Mix：Add 1.5 L, Do not stop. Heat：Confirm "Ready!"',
    );
  });

  it("omits retired preparation and safety fields while retaining descriptions and every written step", () => {
    const summary = generated(
      [
        entry("clean", "清洁", {
          time: "09:00",
          priority: "优先做",
          detail: detail({
            materials: ["软布", "清洁剂"] as unknown as string,
            description: "保持操作台干燥",
            items: [
              { id: "one", text: "清洁台面" },
              { id: "two", text: "等待10分钟。" },
              { id: "three", text: "不要与酸性清洁剂混合！" },
            ],
            safetyNotice: "旧注意字段不再显示",
            imageUrl: "https://example.com/image.png",
            videoUrl: "https://example.com/video.mp4",
          }),
        }),
      ],
      { warnings: ["自动生成的提醒，不应进入正文。"] },
    );
    const before = JSON.stringify(summary);
    const text = completeWorkflowText(workflow, summary);
    expect(text).toBe(
      "09:00 清洁：保持操作台干燥，清洁台面，等待10分钟。不要与酸性清洁剂混合！",
    );
    for (const excluded of [
      workflow.title,
      "完整流程",
      "需要准备",
      "注意事项",
      "优先做",
      "自动生成",
      "https://",
      "软布",
      "旧注意字段不再显示",
    ])
      expect(text).not.toContain(excluded);
    expect(JSON.stringify(summary)).toBe(before);
  });

  it("retains every shared occurrence under its own module name and only removes an exactly duplicated description", () => {
    const shared = detail({
      title: "原做法名",
      description: "清洁台面",
      items: [
        { id: "one", text: "清洁台面" },
        { id: "two", text: "清洁台面后检查水槽" },
        { id: "three", text: "清洁台面" },
      ],
    });
    const source = { ...workflow, id: "source", title: "来源名称" };
    const summary = generated(
      ["初次检查", "再次检查"].map((name, index) =>
        entry(`work-${index}`, name, {
          module: {
            kind: "MODULE",
            id: `work-${index}`,
            title: name,
            detailWorkflowId: source.id,
            detailName: shared.title,
          },
          detail: shared,
          targetWorkflow: source,
        }),
      ),
    );
    const original = structuredClone(summary);
    const text = completeWorkflowText(freeze(workflow), freeze(summary));
    expect(text).toBe(
      "初次检查：清洁台面，清洁台面后检查水槽，清洁台面。再次检查：清洁台面，清洁台面后检查水槽，清洁台面。",
    );
    expect(text).not.toContain(shared.title);
    expect(text).not.toContain(source.title);
    expect(summary).toEqual(original);

    const distinct = generated([
      entry("distinct", "补充检查", {
        detail: detail({
          description: "清洁台面",
          items: [{ id: "one", text: "清洁台面后检查水槽" }],
        }),
      }),
    ]);
    expect(completeWorkflowText(workflow, distinct)).toBe(
      "补充检查：清洁台面，清洁台面后检查水槽。",
    );
  });

  it("uses the supplied reading order while omitting diagram metadata and inferred branch or cycle instructions", () => {
    const entries = ["A", "B"].map((name) =>
      entry(name, name, {
        minute: 540,
        time: "09:00",
        cycleId: "loop",
        isolated: false,
        from: [name === "A" ? "B" : "A"],
        to: [name === "A" ? "B" : "A"],
        detail: detail({ items: [{ id: "one", text: `${name}原文` }] }),
      }),
    );
    const summary = generated(entries, {
      mode: "timeline",
      groups: [
        {
          id: "same-time",
          label: "09:00",
          kind: "timeline",
          entryIds: ["A", "B"],
          cycleIds: ["loop"],
        },
      ],
      cycles: [{ id: "loop", entryIds: ["A", "B"] }],
      warnings: ["回路提醒"],
    });
    const selected = connectProcedure(summary, ["B", "A"]);
    expect(completeWorkflowText(workflow, summary, selected)).toBe(
      "09:00 B：B原文。09:00 A：A原文。",
    );
    expect(summary.entries.map((item) => item.id)).toEqual(["A", "B"]);
  });

  it("keeps written portions of incomplete documents but never inserts placeholders or chooses unavailable source content", () => {
    const summary = generated([
      entry("partial", "部分填写", {
        contentStatus: "INCOMPLETE",
        detail: detail({
          items: [
            { id: "blank", text: " \n " },
            { id: "written", text: "原有说明" },
          ],
        }),
      }),
      entry("missing", "未写做法", { status: "MISSING" }),
      entry("ambiguous", "同名工作", {
        status: "AMBIGUOUS",
        detail: detail({ items: [{ id: "wrong", text: "不能任意选用" }] }),
      }),
      entry("external", "外部工作", {
        sourceMissing: true,
        detail: detail({ items: [{ id: "wrong", text: "不能改用旧来源" }] }),
      }),
      entry("empty", "空白工作", { detail: detail({ items: [] }) }),
    ]);
    expect(completeWorkflowText(workflow, summary)).toBe(
      "部分填写：原有说明。未写做法。同名工作。外部工作。空白工作。",
    );
    expect(
      completeWorkflowParagraphs(
        workflow,
        generated([], { groups: [], warnings: ["不能输出的提醒"] }),
      ),
    ).toEqual([]);
    expect(completeWorkflowText(workflow, generated([]))).toBe("");
  });

  it("wraps long prose only between work units and copies exactly the rendered paragraphs", () => {
    const first = "保留这段操作原文".repeat(35),
      second = "保留另一段操作原文".repeat(35);
    const summary = generated([
      entry("first", "第一项", {
        detail: detail({ items: [{ id: "one", text: first }] }),
      }),
      entry("second", "第二项", {
        detail: detail({ items: [{ id: "one", text: second }] }),
      }),
    ]);
    const paragraphs = completeWorkflowParagraphs(workflow, summary);
    expect(paragraphs).toEqual([`第一项：${first}。`, `第二项：${second}。`]);
    expect(completeWorkflowText(workflow, summary)).toBe(
      paragraphs.join("\n\n"),
    );
  });

  it("accepts legacy string arrays without stringifying unrelated values or removing user-entered URLs from text", () => {
    const summary = generated([
      entry("legacy", "旧工作", {
        detail: detail({
          items: [
            {
              id: "one",
              text: ["打开电源", "检查指示灯"] as unknown as string,
            },
          ],
          description: "手写链接 https://example.com/manual 保留",
          materials: [
            "软布",
            null,
            3,
            { text: "不能生成的文字" },
            "工具",
          ] as unknown as string,
        }),
      }),
    ]);
    expect(completeWorkflowText(workflow, summary)).toBe(
      "旧工作：手写链接 https://example.com/manual 保留，打开电源，检查指示灯。",
    );
  });
});

describe("legacy text and notice compatibility", () => {
  it("retains the shared text conversion and notice exports without inserting their messages into prose", () => {
    expect(completeTextValue(" 原文\n下一行 ")).toBe(" 原文\n下一行 ");
    expect(
      completeTextValue(["保留", null, 3, { text: "不能转成文字" }, "原文"]),
    ).toBe("保留\n原文");
    for (const value of [null, undefined, false, 1, { text: "不是文本字段" }])
      expect(completeTextValue(value)).toBe("");
    const missing = entry("missing", "未写做法", { status: "MISSING" });
    expect(completeEntryNotice(missing)).toBe(
      "还没有找到这项工作对应的具体做法。",
    );
    expect(completeWorkflowText(workflow, generated([missing]))).toBe(
      "未写做法。",
    );
  });
});
