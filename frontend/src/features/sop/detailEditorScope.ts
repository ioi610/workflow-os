import type { WorkflowDetailDocument } from "../../types";
import { matchDetail, newDetail, normalizeName } from "./workflows";

export function prepareDetailEditorScope(
  details: WorkflowDetailDocument[],
  name: string,
  detailId?: string | null,
) {
  if (detailId !== undefined && detailId !== null) {
    const matches = details.filter((detail) => detail.id === detailId);
    if (matches.length === 1 && normalizeName(detailId))
      return { status: "MATCHED" as const, detail: matches[0], pending: false };
    return {
      status:
        matches.length > 1 ? ("AMBIGUOUS" as const) : ("INVALID" as const),
      detail: undefined,
      pending: false as const,
    };
  }
  const title = normalizeName(name);
  if (!title)
    return {
      status: "INVALID" as const,
      detail: undefined,
      pending: false as const,
    };
  const match = matchDetail(title, details);
  if (match.status === "AMBIGUOUS")
    return {
      status: "AMBIGUOUS" as const,
      detail: undefined,
      pending: false as const,
    };
  return {
    status: "MATCHED" as const,
    detail: match.detail || newDetail(title),
    pending: match.status === "MISSING",
  };
}
