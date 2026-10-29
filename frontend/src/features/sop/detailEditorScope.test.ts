import { describe, expect, it } from "vitest";
import type { WorkflowDetailDocument } from "../../types";
import { prepareDetailEditorScope } from "./detailEditorScope";

const detail = (id: string, title: string): WorkflowDetailDocument => ({
  kind: "DETAIL",
  id,
  title,
  items: [{ id: `step-${id}`, text: `original ${id}` }],
  materials: "retained",
});

describe("single-work instruction selection", () => {
  it("selects only the requested document without replacing or mutating the full collection", () => {
    const details = [detail("a", "准备"), detail("b", "发货")];
    const before = structuredClone(details);
    const selected = prepareDetailEditorScope(details, " 发货 ");
    expect(selected).toEqual({
      status: "MATCHED",
      detail: details[1],
      pending: false,
    });
    expect(selected.detail).toBe(details[1]);
    expect(details).toEqual(before);
  });

  it("prepares a missing document separately so opening it cannot contaminate the saved draft", () => {
    const details = [detail("a", "准备")];
    const selected = prepareDetailEditorScope(details, " 新工作 ");
    expect(selected.status).toBe("MATCHED");
    expect(selected.pending).toBe(true);
    expect(selected.detail?.title).toBe("新工作");
    expect(selected.detail?.items).toEqual([
      { id: expect.any(String), text: "" },
    ]);
    expect(details).toHaveLength(1);
    expect(details[0].title).toBe("准备");
  });

  it("uses the selected stable id while its title is blank, changed, or temporarily duplicated", () => {
    const details = [detail("a", "原名称"), detail("b", "改后的名称")];
    for (const title of ["", "改后的名称", "另一个名字"]) {
      details[0].title = title;
      const selected = prepareDetailEditorScope(details, "原名称", "a");
      expect(selected.detail).toBe(details[0]);
      expect(selected.pending).toBe(false);
    }
  });

  it("does not pick one duplicate or create a third document when the initial name is ambiguous", () => {
    const details = [detail("a", "café"), detail("b", "cafe\u0301")];
    const selected = prepareDetailEditorScope(details, " café ");
    expect(selected).toEqual({
      status: "AMBIGUOUS",
      detail: undefined,
      pending: false,
    });
    expect(details).toHaveLength(2);
  });

  it("does not replace a missing stable id with another same-name document or prepare a new one", () => {
    const details = [detail("a", "准备"), detail("b", "发货")];
    const before = structuredClone(details);
    for (const name of ["发货", "没有做法的新工作", ""]) {
      expect(prepareDetailEditorScope(details, name, "deleted")).toEqual({
        status: "INVALID",
        detail: undefined,
        pending: false,
      });
    }
    expect(prepareDetailEditorScope(details, "发货", "")).toEqual({
      status: "INVALID",
      detail: undefined,
      pending: false,
    });
    expect(details).toEqual(before);
  });

  it("does not arbitrarily select a duplicated stable id", () => {
    const details = [detail("same", "准备"), detail("same", "发货")];
    expect(prepareDetailEditorScope(details, "准备", "same")).toEqual({
      status: "AMBIGUOUS",
      detail: undefined,
      pending: false,
    });
  });

  it("rejects an unspecified empty name while allowing a valid stable id with a blank title", () => {
    const details = [detail("a", "准备"), detail("b", "发货")];
    expect(prepareDetailEditorScope(details, "  ")).toEqual({
      status: "INVALID",
      detail: undefined,
      pending: false,
    });
    expect(prepareDetailEditorScope(details, "", "a").detail).toBe(details[0]);
  });
});
