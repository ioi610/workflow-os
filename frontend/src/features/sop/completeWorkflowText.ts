import type { Workflow, WorkflowDetailDocument } from "../../types";
import type {
  GeneratedWorkflow,
  GeneratedWorkflowEntry,
} from "./generatedWorkflow";
import {
  connectProcedure,
  type ConnectedProcedure,
} from "./connectedProcedure";
import { originalWorkflowText } from "./workflowTextOrigin";

export function completeTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .join("\n")
    : "";
}

export function completeEntryNotice(
  entry: GeneratedWorkflowEntry,
): string | undefined {
  if (entry.sourceMissing)
    return "这项工作引用的做法来源暂时无法打开，没有改用其他来源。";
  if (entry.status === "AMBIGUOUS")
    return "找到多份同名做法，暂时无法确定这一项，没有自动选择其中一份。";
  if (entry.status === "MISSING" || !entry.detail)
    return "还没有找到这项工作对应的具体做法。";
  const texts = entry.detail.items.map((item) => completeTextValue(item?.text));
  const status =
    entry.contentStatus ??
    (!texts.some((text) => text.trim())
      ? "EMPTY"
      : texts.some((text) => !text.trim())
        ? "INCOMPLETE"
        : "READY");
  if (status === "EMPTY") return "这项工作的具体步骤还没有填写。";
  if (status === "INCOMPLETE")
    return "这项工作的具体步骤还没写完整，已保留现有内容。";
  return undefined;
}

const closingQuotes = `["'”’」』）)】\\]]*`;
const existingBoundary = new RegExp(`[，,、：:。.!?！？；;…]${closingQuotes}$`);
const sentenceEnding = new RegExp(`[。.!?！？…]${closingQuotes}$`);
const unfinishedEnding = new RegExp(`[，,、：:；;]+(${closingQuotes})$`);
const chineseText = /[\u3400-\u9fff]/;

function inlineText(text: string): string {
  return text.trim().replace(/\s*[\r\n]+\s*/g, " ");
}

function textFragments(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    return typeof item === "string"
      ? item
          .split(/\r\n?|\n|\u2028|\u2029/)
          .map((text) => text.trim())
          .filter(Boolean)
      : [];
  });
}

// Join clauses with punctuation only. Do not infer actions, conditions, or
// connecting words from the diagram, and never rewrite a user's sentence.
function joinFragments(fragments: string[]): string {
  return fragments.reduce((text, fragment) => {
    if (!text) return fragment;
    if (existingBoundary.test(text))
      return text + (!chineseText.test(text + fragment) ? " " : "") + fragment;
    return text + (chineseText.test(text + fragment) ? "，" : "; ") + fragment;
  }, "");
}

function finishSentence(text: string): string {
  if (!text || sentenceEnding.test(text)) return text;
  const period = chineseText.test(text) ? "。" : ".";
  const unfinished = unfinishedEnding.exec(text);
  if (unfinished) {
    const sentence = text.slice(0, unfinished.index);
    return (
      sentence + (sentenceEnding.test(sentence) ? "" : period) + unfinished[1]
    );
  }
  return text + period;
}

function detailFragments(detail: WorkflowDetailDocument): string[] {
  const items = detail.items.map((item) => completeTextValue(item?.text));
  const description = completeTextValue(detail.description);
  return [
    ...(!items.some((text) => text.trim() === description.trim())
      ? textFragments(detail.description)
      : []),
    ...detail.items.flatMap((item) => textFragments(item?.text)),
  ];
}

export function completeWorkflowParagraphs(
  workflow: Workflow,
  generated: GeneratedWorkflow,
  procedure: ConnectedProcedure = connectProcedure(generated),
): string[] {
  const original = originalWorkflowText(
    workflow,
    generated,
    procedure.entryOrder,
  );
  if (original !== null) return original ? [original] : [];
  const entries = new Map(generated.entries.map((entry) => [entry.id, entry]));
  const paragraphs: string[] = [];
  let paragraph = "";
  for (const id of procedure.entryOrder) {
    const entry = entries.get(id);
    if (!entry) continue;
    const name = [entry.time?.trim(), inlineText(entry.name)]
      .filter(Boolean)
      .join(" ");
    const fragments =
      entry.status === "MATCHED" && !entry.sourceMissing && entry.detail
        ? detailFragments(entry.detail)
        : [];
    const body = joinFragments(fragments);
    const text = finishSentence(
      name && body ? `${name}：${body}` : name || body,
    );
    if (!text) continue;
    // Keep neighboring work in one narrative; wrap only at a work boundary.
    if (paragraph && paragraph.length + text.length > 420) {
      paragraphs.push(paragraph);
      paragraph = "";
    }
    paragraph +=
      paragraph && !chineseText.test(paragraph + text) ? ` ${text}` : text;
  }
  if (paragraph) paragraphs.push(paragraph);
  return paragraphs;
}

export function completeWorkflowText(
  workflow: Workflow,
  generated: GeneratedWorkflow,
  procedure: ConnectedProcedure = connectProcedure(generated),
): string {
  return completeWorkflowParagraphs(workflow, generated, procedure).join(
    "\n\n",
  );
}
