import type { TextDiagram } from "./textDiagram";

type Line = { raw: string; start: number; indent: number; text: string };
type Item = { style: string; content: string };
type Block = { source: string; name?: string };

const MAX_TEXT = 16000;
const MAX_NODES = 60;
const CHINESE_NUMBER = "一二三四五六七八九十百零〇两";
const DETAIL_LABELS = new Set([
  "做法",
  "具体做法",
  "详细做法",
  "步骤",
  "详细步骤",
  "操作",
  "说明",
  "注意",
  "注意事项",
  "备注",
  "要求",
  "材料",
  "工具",
  "时间",
  "用时",
  "开始时间",
  "结束时间",
  "优先级",
  "负责人",
  "输入",
  "输出",
  "详情",
]);
const CONNECTOR =
  /^(?:首先|接下来|然后|接着|随后|其次|最后|先|再)(?!生|现|版|天|进|兆|锋|例|驱|知|见|烈|祖|秦|民)/u;
const COMPLEX =
  /如果|否则|如遇|若(?!干)|当.+时|与此同时|同时|并行|返工|循环|重复|反复|直到|不然|或者|返回|回到|退回|重新|重做|不合格|不通过|未通过|(?:否则|若|如)(?:不|未|已|有|无|需|能)|(?:通过|失败|合格)[，,：:]/u;

function listItem(text: string): Item | null {
  const enclosed = text.match(
    new RegExp(`^[（(]([0-9]+|[${CHINESE_NUMBER}]+)[）)]\\s*(.+)$`, "u"),
  );
  if (enclosed)
    return {
      style: /\d/u.test(enclosed[1]) ? "arabic-enclosed" : "chinese-enclosed",
      content: enclosed[2],
    };
  const step = text.match(
    new RegExp(
      `^第[0-9${CHINESE_NUMBER}]+步(?:[：:、.．)）]\\s*|\\s+)?(.+)$`,
      "u",
    ),
  );
  if (step) return { style: "step", content: step[1] };
  const numbered = text.match(
    new RegExp(
      `^([0-9]+|[${CHINESE_NUMBER}]+)([、)）]|[.．](?![0-9]))\\s*(.+)$`,
      "u",
    ),
  );
  if (numbered)
    return {
      style: /\d/u.test(numbered[1]) ? "arabic" : "chinese",
      content: numbered[3],
    };
  const bullet = text.match(/^[-*•·]\s+(.+)$/u);
  return bullet ? { style: "bullet", content: bullet[1] } : null;
}

function linesOf(source: string): Line[] {
  const lines: Line[] = [];
  const expression = /[^\r\n]+(?:\r?\n|\r|$)|(?:\r?\n|\r)/gu;
  for (const match of source.matchAll(expression)) {
    const raw = match[0].replace(/[\r\n]+$/u, "");
    const indentation = raw.match(/^[\t \u3000]*/u)![0];
    lines.push({
      raw,
      start: match.index,
      indent: [...indentation].reduce(
        (sum, c) => sum + (c === "\t" ? 4 : c === "\u3000" ? 2 : 1),
        0,
      ),
      text: raw.trim(),
    });
  }
  return lines;
}

/** Locations inside quotes, parentheses and URLs are never split into work. */
function protectedCharacters(source: string): boolean[] {
  const protectedAt = Array<boolean>(source.length).fill(false);
  const stack: string[] = [];
  const closing = new Map([
    ["“", "”"],
    ["‘", "’"],
    ["「", "」"],
    ["『", "』"],
    ["（", "）"],
    ["(", ")"],
    ["[", "]"],
    ["【", "】"],
    ["{", "}"],
  ]);
  const urls = /(?:https?:\/\/|www\.)[^\s<>"'“”‘’「」。，；！？、（）]+/giu;
  for (const match of source.matchAll(urls))
    for (
      let index = match.index;
      index < match.index + match[0].length;
      index++
    )
      protectedAt[index] = true;
  for (let index = 0; index < source.length; index++) {
    if (protectedAt[index]) continue;
    const character = source[index];
    if (stack.length) protectedAt[index] = true;
    if (stack.at(-1) === character) stack.pop();
    else if (closing.has(character)) {
      stack.push(closing.get(character)!);
      protectedAt[index] = true;
    } else if (
      (character === '"' || character === "'") &&
      !(
        character === "'" &&
        /[\p{L}\p{N}]/u.test(source[index - 1] || "") &&
        /[\p{L}\p{N}]/u.test(source[index + 1] || "")
      )
    ) {
      stack.push(character);
      protectedAt[index] = true;
    }
  }
  return protectedAt;
}

function containsComplex(source: string): boolean {
  const mask = protectedCharacters(source);
  // Quoted examples such as “如果、否则” describe text, not branches.
  const unquoted = source
    .split("")
    .map((character, index) => (mask[index] ? " " : character))
    .join("");
  return COMPLEX.test(unquoted);
}

function heading(line: Line): string | null {
  if (listItem(line.text)) return null;
  const protectedAt = protectedCharacters(line.text);
  for (let index = 0; index < line.text.length; index++) {
    if (!/[：:]/u.test(line.text[index]) || protectedAt[index]) continue;
    // A clock, ratio or URL may precede the actual heading separator.
    if (
      /\d/u.test(line.text[index - 1] || "") &&
      /\d/u.test(line.text[index + 1] || "")
    )
      continue;
    if (line.text.slice(index + 1).startsWith("//")) continue;
    const name = line.text.slice(0, index).trim();
    if (
      !name ||
      name.length > 120 ||
      DETAIL_LABELS.has(name) ||
      /[\r\n，,。；;！？!?]/u.test(name) ||
      /^\d{1,2}$/u.test(name) ||
      /^(?:https?|ftp)$/iu.test(name) ||
      name.includes("//") ||
      containsComplex(name)
    )
      return null;
    return name;
  }
  return null;
}

function blocksAt(
  source: string,
  boundaries: { start: number; name?: string }[],
): Block[] {
  return boundaries.map((boundary, index) => ({
    // An introduction belongs to the first work instead of disappearing.
    source: source
      .slice(index === 0 ? 0 : boundary.start, boundaries[index + 1]?.start)
      .trim(),
    name: boundary.name,
  }));
}

function structuralBlocks(source: string): Block[] | null {
  const lines = linesOf(source).filter((line) => line.text);
  const numbered = lines.filter((line) => listItem(line.text));
  const named = lines.filter((line) => heading(line));
  const firstNumber = numbered[0];
  const firstHeading = named[0];
  // A named work may contain its own numbered detailed instructions.
  if (
    firstHeading &&
    (!firstNumber || firstHeading.start < firstNumber.start)
  ) {
    const depth = Math.min(...named.map((line) => line.indent));
    return blocksAt(
      source,
      named
        .filter((line) => line.indent === depth)
        .map((line) => ({
          start: line.start,
          name: heading(line)!,
        })),
    );
  }
  if (firstNumber) {
    const depth = Math.min(...numbered.map((line) => line.indent));
    const first = numbered.find((line) => line.indent === depth)!;
    const style = listItem(first.text)!.style;
    const topLevel = numbered.filter(
      (line) => line.indent === depth && listItem(line.text)!.style === style,
    );
    return blocksAt(
      source,
      topLevel.map((line) => ({
        start: line.start,
        name: nameFromSource(listItem(line.text)!.content),
      })),
    );
  }
  return null;
}

/** Split only observable writing boundaries; no semantic rewriting or model calls. */
function proseBlocks(source: string): Block[] {
  const mask = protectedCharacters(source);
  const boundaries = new Set<number>([0]);
  for (let index = 0; index < source.length; index++) {
    if (mask[index]) continue;
    const character = source[index];
    if (
      character === "\n" ||
      character === "\r" ||
      /[。！？；!?;]/u.test(character) ||
      (character === "." &&
        !/\d/u.test(source[index - 1] || "") &&
        (index + 1 === source.length || /\s/u.test(source[index + 1])))
    )
      boundaries.add(index + 1);
  }
  const paragraphs = blocksAt(
    source,
    [...boundaries].sort((a, b) => a - b).map((start) => ({ start })),
  ).filter((block) => block.source);
  return paragraphs.flatMap((block) => {
    if (containsComplex(block.source)) return [block];
    const text = block.source;
    const protectedAt = protectedCharacters(text);
    const starts = new Set<number>([0]);
    for (let index = 0; index < text.length; index++) {
      if (protectedAt[index]) continue;
      // Keep the transition words and punctuation in the original details.
      if (
        (index === 0 || /[\s，,、；;。]/u.test(text[index - 1])) &&
        CONNECTOR.test(text.slice(index))
      )
        starts.add(index);
      if (
        text.startsWith("→", index) ||
        text.startsWith("->", index) ||
        text.startsWith("=>", index) ||
        text.startsWith("⇒", index)
      ) {
        const length =
          text.startsWith("->", index) || text.startsWith("=>", index) ? 2 : 1;
        starts.add(index + length);
        index += length - 1;
      }
    }
    return blocksAt(
      text,
      [...starts].sort((a, b) => a - b).map((start) => ({ start })),
    ).filter((piece) => piece.source && !/^[→⇒\s-]*$/u.test(piece.source));
  });
}

function limitName(name: string, limit = 120): string {
  if (name.length <= limit) return name;
  let prefix = name.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

function nameFromSource(source: string): string {
  let name = source.trim();
  const item = listItem(name.split(/[\r\n]/u)[0]);
  if (item) name = item.content;
  name = name.replace(CONNECTOR, "").replace(/^[\s，,：:]+/u, "");
  name = heading({ raw: name, text: name, start: 0, indent: 0 }) || name;
  name = name.split(/[\r\n，,。；;！？!?]/u)[0].trim();
  // An inline arrow belongs to the source details, not to the work name.
  name = name.replace(/(?:->|=>|[→⇒])\s*$/u, "").trim();
  return limitName(name || source.trim());
}

/** A fully local, source-preserving draft generator; caller decides whether to save. */
export function parseLocalTextDiagram(text: string): {
  diagram: TextDiagram;
  notices: string[];
} {
  if (!text.trim())
    throw new Error("请先粘贴流程文字，例如：先洗菜，再切菜，最后炒菜。");
  if (text.length > MAX_TEXT)
    throw new Error(
      "文字超过 16000 字，请分成几份流程后分别生成，原文不会被截断。",
    );
  if (!/[\p{L}\p{N}]/u.test(text))
    throw new Error("请写出至少一项工作的名称或具体做法，不能只有标点和箭头。");
  let source = text.trim();
  let title = "";
  const titleLine = source.match(
    /^(?:#{1,6}\s*)?(?:流程名称|流程名|标题|流程)\s*[：:]\s*([^\r\n]+)(?:\r?\n|\r|$)/u,
  );
  if (titleLine) {
    title = titleLine[1].trim();
    source = source.slice(titleLine[0].length).trim();
    if (!source)
      throw new Error(
        "流程名称下面还没有工作内容，请补充工作和具体做法后再生成。",
      );
    if (title.length > 120)
      throw new Error(
        "流程名称超过 120 字，请缩短名称；具体内容可以写在下面。",
      );
  }
  const blocks = structuralBlocks(source) ?? proseBlocks(source);
  if (!blocks.length)
    throw new Error(
      "没有找到工作内容，请写出至少一项工作，例如：洗菜：把青菜冲洗干净。",
    );
  if (blocks.length > MAX_NODES)
    throw new Error(
      `这段文字分出了 ${blocks.length} 项工作，单个流程最多 60 项。请按阶段分开生成，原文不会被截断。`,
    );
  const used = new Set<string>();
  const nodes = blocks.map((block, index) => {
    const base = limitName((block.name || nameFromSource(block.source)).trim());
    let name = base;
    let occurrence = 1;
    while (used.has(name.normalize("NFC"))) {
      const suffix = `（${++occurrence}）`;
      name = `${limitName(base, 120 - suffix.length)}${suffix}`;
    }
    used.add(name.normalize("NFC"));
    return {
      id: `local-${index + 1}`,
      name,
      details: [block.source],
      nextIds: [] as string[],
    };
  });
  const complex = containsComplex(source);
  if (!complex)
    nodes.forEach((node, index) => {
      if (index + 1 < nodes.length) node.nextIds = [nodes[index + 1].id];
    });
  return {
    diagram: { title: title || nodes[0].name, nodes },
    notices: complex
      ? [
          "原文包含条件、同时进行或重复操作，已保留文字并生成工作方框，未推断分支和连线。请检查后手动连接。",
        ]
      : ["已按原文的阅读顺序连线，请在预览中检查工作划分和先后顺序。"],
  };
}
