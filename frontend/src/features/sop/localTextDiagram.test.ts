import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLocalTextDiagram } from "./localTextDiagram";
import { createTextDiagramDraft } from "./textDiagram";

afterEach(() => vi.unstubAllGlobals());

const names = (text: string) =>
  parseLocalTextDiagram(text).diagram.nodes.map((node) => node.name);
const details = (text: string) =>
  parseLocalTextDiagram(text).diagram.nodes.flatMap((node) => node.details);

describe("free local text diagram", () => {
  it("turns the user's Chinese prose into connected actions without writing new instructions", () => {
    const text = "先洗菜，再切菜，然后放入锅中炒熟，最后装盘。";
    const { diagram } = parseLocalTextDiagram(text);
    expect(diagram.nodes.map((node) => node.name)).toEqual([
      "洗菜",
      "切菜",
      "放入锅中炒熟",
      "装盘",
    ]);
    expect(diagram.nodes.map((node) => node.nextIds)).toEqual([
      ["local-2"],
      ["local-3"],
      ["local-4"],
      [],
    ]);
    expect(diagram.nodes.flatMap((node) => node.details).join("")).toBe(text);
    expect(parseLocalTextDiagram(text)).toEqual(parseLocalTextDiagram(text));
  });

  it("supports a title and multiple heading/detail blocks, including multiline prose", () => {
    const text =
      "流程名称：午餐准备\n洗菜：把青菜冲洗干净。\n清除坏叶，沥干水分。\n切菜：切成小块。\n炒菜：放入锅中炒熟。";
    const { diagram } = parseLocalTextDiagram(text);
    expect(diagram.title).toBe("午餐准备");
    expect(diagram.nodes.map((node) => node.name)).toEqual([
      "洗菜",
      "切菜",
      "炒菜",
    ]);
    expect(diagram.nodes[0].details).toEqual([
      "洗菜：把青菜冲洗干净。\n清除坏叶，沥干水分。",
    ]);
    expect(diagram.nodes[0].nextIds).toEqual(["local-2"]);
    expect(details(text).join("\n")).toBe(text.slice(text.indexOf("\n") + 1));
  });

  it("keeps numbered and indented substeps inside their parent work", () => {
    const text =
      "1. 洗菜：清洗青菜\n  1. 浸泡 5 分钟。\n  2. 用水冲洗。\n2. 切菜：去根切段\n  - 切成 3cm 长。\n3. 炒菜\n  做法：热锅后放菜。";
    const { diagram } = parseLocalTextDiagram(text);
    expect(diagram.nodes.map((node) => node.name)).toEqual([
      "洗菜",
      "切菜",
      "炒菜",
    ]);
    expect(diagram.nodes[0].details[0]).toContain("  2. 用水冲洗。");
    expect(diagram.nodes[2].details[0]).toContain("做法：热锅后放菜。");
    expect(details(text).join("\n")).toBe(text);
  });

  it("recognizes Chinese top-level numbers and unindented parenthesized substeps", () => {
    const text =
      "一、清洗\n（1）冷水浸泡\n（2）冲洗干净\n二、切菜\n（1）切成细丝\n三、炒菜";
    expect(names(text)).toEqual(["清洗", "切菜", "炒菜"]);
    expect(details(text).join("\n")).toBe(text);
  });

  it("keeps numbered details under a named work instead of promoting them to work", () => {
    const text =
      "洗菜：\n1. 去掉坏叶。\n2. 清水冲洗。\n切菜：\n1. 切成小块。\n2. 放入盘中。";
    expect(names(text)).toEqual(["洗菜", "切菜"]);
    expect(details(text).join("\n")).toBe(text);
  });

  it("keeps detail labels and a preface rather than silently dropping them", () => {
    const text =
      "今天使用新鲜青菜。\n洗菜：冲洗干净。\n注意：不要用热水。\n切菜：切成小块。\n具体做法：从根部开始切。";
    expect(names(text)).toEqual(["洗菜", "切菜"]);
    expect(details(text).join("\n")).toBe(text);
  });

  it("splits sentence paragraphs while preserving decimal amounts, clock times, URLs and punctuation", () => {
    const text =
      "09:30 准备 1.5kg 青菜，查看 https://example.com/a.b?x=1.5。10:00 将青菜冲洗干净；10:10 切成 2.5cm 的小段。";
    const result = parseLocalTextDiagram(text);
    expect(result.diagram.nodes).toHaveLength(3);
    expect(result.diagram.nodes[0].details[0]).toBe(
      "09:30 准备 1.5kg 青菜，查看 https://example.com/a.b?x=1.5。",
    );
    expect(details(text).join("")).toBe(text);
  });

  it("does not split quoted connectors, arrows or punctuation", () => {
    const text = "先阅读“先检查，再操作；最后结束→归档”的说明，再开机。";
    const { diagram } = parseLocalTextDiagram(text);
    expect(diagram.nodes).toHaveLength(2);
    expect(diagram.nodes[0].details[0]).toBe(
      "先阅读“先检查，再操作；最后结束→归档”的说明，",
    );
    expect(details(text).join("")).toBe(text);
    expect(
      parseLocalTextDiagram("记录‘如果、否则’这两个词。再保存。 ").diagram
        .nodes[0].nextIds,
    ).toEqual(["local-2"]);
    expect(
      parseLocalTextDiagram("😀 记录‘如果、否则’这两个词。再保存。 ").diagram
        .nodes[0].nextIds,
    ).toEqual(["local-2"]);
  });

  it("finds heading separators after clock times and preserves their nested prose", () => {
    const text = "09:30 洗菜：先冲洗，再沥干。\n10:00 切菜：切成小块。";
    expect(names(text)).toEqual(["09:30 洗菜", "10:00 切菜"]);
    expect(details(text).join("\n")).toBe(text);
    const ratios =
      "准备 1:2 的配料。查看 https://example.com:8080/help。09:30 开始。";
    expect(parseLocalTextDiagram(ratios).diagram.nodes).toHaveLength(3);
    expect(details(ratios).join("")).toBe(ratios);
  });

  it("supports arrow notation and retains the exact source pieces", () => {
    for (const arrow of ["→", "->", "=>", "⇒"]) {
      const text = `洗菜${arrow}切菜${arrow}炒菜`;
      expect(names(text)).toEqual(["洗菜", "切菜", "炒菜"]);
      expect(details(text).join("")).toBe(text);
    }
  });

  it("keeps ambiguous conditions and parallel instructions without fabricating branches or links", () => {
    for (const text of [
      "如果温度不足，先加热，再放菜，否则直接放菜。",
      "1. 烧水\n2. 同时洗菜\n3. 摆盘",
      "检查后返工，再次检查，循环直到合格。",
      "😀 如果需要，先等待，再继续。",
    ]) {
      const { diagram, notices } = parseLocalTextDiagram(text);
      expect(diagram.nodes.every((node) => node.nextIds.length === 0)).toBe(
        true,
      );
      expect(notices.join("")).toContain("未推断分支和连线");
      for (const detail of diagram.nodes.flatMap((node) => node.details))
        expect(text).toContain(detail);
      expect(details(text).join("\n")).toBe(text);
    }
  });

  it("does not turn an explicit return for unqualified work into a straight chain", () => {
    const text = "1. 检查原料\n2. 不合格后返回清洗\n3. 装盘";
    const { diagram, notices } = parseLocalTextDiagram(text);
    expect(diagram.nodes).toHaveLength(3);
    expect(diagram.nodes.every((node) => node.nextIds.length === 0)).toBe(true);
    expect(notices.join("")).toContain("未推断分支和连线");
    expect(details(text).join("\n")).toBe(text);
  });

  it("keeps a failed check and retry together and asks for connections to be reviewed", () => {
    const text = "先清洗，然后检查，未通过就重新检查，最后装盘。";
    const { diagram, notices } = parseLocalTextDiagram(text);
    expect(diagram.nodes.every((node) => node.nextIds.length === 0)).toBe(true);
    expect(notices.join("")).toContain("未推断分支和连线");
    expect(details(text)).toEqual([text]);
    expect(
      parseLocalTextDiagram("阅读‘未通过就重新检查’的提示。再保存。").diagram
        .nodes[0].nextIds,
    ).toEqual(["local-2"]);
  });

  it("gives duplicate names deterministic unique suffixes without changing their original details", () => {
    const text =
      "洗菜：清洗白菜。\n洗菜：清洗青菜。\n洗菜（2）：清洗生菜。\n洗菜：清洗菠菜。";
    const { diagram } = parseLocalTextDiagram(text);
    expect(diagram.nodes.map((node) => node.name)).toEqual([
      "洗菜",
      "洗菜（2）",
      "洗菜（2）（2）",
      "洗菜（3）",
    ]);
    expect(details(text).join("\n")).toBe(text);
  });

  it("limits work names while keeping all of a long original sentence", () => {
    const text = "检查".repeat(200) + "。";
    const { diagram } = parseLocalTextDiagram(text);
    expect(diagram.nodes[0].name.length).toBeLessThanOrEqual(120);
    expect(diagram.nodes[0].details).toEqual([text]);
    expect(() => createTextDiagramDraft(diagram)).not.toThrow();
  });

  it("rejects empty, punctuation-only, title-only and overlong text with actionable messages", () => {
    expect(() => parseLocalTextDiagram(" \n ")).toThrow("粘贴流程文字");
    expect(() => parseLocalTextDiagram("→ → ...")).toThrow(
      "不能只有标点和箭头",
    );
    expect(() => parseLocalTextDiagram("标题：测试流程")).toThrow(
      "还没有工作内容",
    );
    expect(() => parseLocalTextDiagram("菜".repeat(16001))).toThrow(
      "原文不会被截断",
    );
    expect(() =>
      parseLocalTextDiagram(`标题：${"菜".repeat(121)}\n洗菜`),
    ).toThrow("名称超过 120 字");
  });

  it("rejects more than 60 work items rather than truncating", () => {
    const sixty = Array.from(
      { length: 60 },
      (_, index) => `${index + 1}. 工作${index + 1}`,
    ).join("\n");
    expect(parseLocalTextDiagram(sixty).diagram.nodes).toHaveLength(60);
    expect(() => parseLocalTextDiagram(`${sixty}\n61. 最后工作`)).toThrow(
      "分出了 61 项工作",
    );
  });

  it("runs without network, DOM, storage, credentials or a provider", () => {
    const fetch = vi.fn(() => {
      throw new Error("no network");
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("localStorage", undefined);
    const result = parseLocalTextDiagram("洗菜→切菜→炒菜");
    expect(result.diagram.nodes).toHaveLength(3);
    expect(fetch).not.toHaveBeenCalled();
  });
});
