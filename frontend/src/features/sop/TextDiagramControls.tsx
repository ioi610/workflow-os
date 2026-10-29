import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { WandSparkles, X } from "lucide-react";
import { api } from "../../api";
import type { Context, Workflow, WorkflowStep } from "../../types";
import { LayoutPreview } from "./AutoLayoutControls";
import { createTextDiagramDraft, type TextDiagram } from "./textDiagram";
import { parseLocalTextDiagram } from "./localTextDiagram";
import {
  parseWorkflowTransfer,
  prepareWorkflowTransferImport,
  type WorkflowTransfer,
} from "./workflowTransfer";
import { readWorkflow, resolveModuleLink, workflowKey } from "./workflows";
import { workItemsKey } from "./workItems";
import { attachOriginalWorkflowText } from "./workflowTextOrigin";
import {
  findPlainTextWorkflowMatches,
  readStoredPlainTextWorkflowOrder,
  type PlainTextWorkflowMatch,
  type ReadPlainTextWorkflowOrder,
} from "./plainTextWorkflowRestore";
import { findRecordedWorkflowCopies } from "./workflowCopySnapshots";
import "./TextDiagramControls.css";

type Candidate = {
  source: string;
  diagram: TextDiagram;
  draft: {
    title: string;
    category?: string;
    steps: WorkflowStep[];
    boardSettings: string | null;
  };
  notices: string[];
  createRequestId: string;
  librarySource?: { workflowId: string; signature: string };
};

function restoredDiagram(draft: Candidate["draft"]): TextDiagram {
  const workflow: Workflow = {
    ...draft,
    id: "workflow-transfer-preview",
    category: draft.category ?? "",
    draft: JSON.stringify(draft.steps),
    revision: 0,
  };
  return {
    title: draft.title,
    nodes: readWorkflow(workflow.draft).modules.map((module) => {
      const detail = resolveModuleLink(workflow, module, [workflow]).detail;
      return {
        id: module.id,
        name: module.title,
        details: (detail?.items ?? []).map((item) => {
          const text: unknown = item.text;
          return typeof text === "string"
            ? text
            : Array.isArray(text)
              ? text.filter((line) => typeof line === "string").join("\n")
              : "";
        }),
        nextIds: module.nextModuleIds ?? [],
      };
    }),
  };
}

function restoredPreview(
  source: string,
  restored: WorkflowTransfer,
  notice = "已识别可还原文字，方框位置、连线、时间和具体做法将按原图恢复。",
): Omit<Candidate, "createRequestId"> {
  const prepared = prepareWorkflowTransferImport(restored);
  const draft: Candidate["draft"] = {
    title: prepared.title,
    category: prepared.category,
    steps: prepared.steps,
    boardSettings: prepared.boardSettings,
  };
  draft.steps = attachOriginalWorkflowText(
    draft,
    prepared.prose,
    prepared.order,
  );
  return {
    source,
    diagram: restoredDiagram(draft),
    draft,
    notices: [notice],
  };
}

export type TextPreviewContext = {
  workflows?: Workflow[];
  preferredWorkflowId?: string;
  recordedMatches?: PlainTextWorkflowMatch[];
  readOrder?: ReadPlainTextWorkflowOrder;
  libraryReady?: boolean;
};

export class WorkflowTextAmbiguity extends Error {
  constructor(readonly matches: PlainTextWorkflowMatch[]) {
    super("这段文字对应多张流程图，请选择要还原的原图。");
    this.name = "WorkflowTextAmbiguity";
  }
}

function transferSignature(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return item;
  }
  return JSON.stringify(canonical(value));
}

function matchedPreview(
  source: string,
  match: PlainTextWorkflowMatch,
  fromLibrary = false,
) {
  const preview = restoredPreview(
    source,
    match.transfer,
    `已找到原流程“${match.title}”，将原样还原 ${match.moduleCount} 项工作，保留方框位置、大小、连线、时间和具体做法。`,
  );
  return fromLibrary
    ? {
        ...preview,
        librarySource: {
          workflowId: match.workflowId,
          signature: transferSignature(match.transfer),
        },
      }
    : preview;
}

/** Only library-derived previews depend on a still-current source graph. */
export function isTextPreviewCurrent(
  preview: Pick<Candidate, "source" | "librarySource">,
  context: TextPreviewContext,
): boolean {
  if (!preview.librarySource) return true;
  if (context.libraryReady === false) return false;
  try {
    const match = findPlainTextWorkflowMatches(
      preview.source,
      context.workflows ?? [],
      context.readOrder,
    ).find((match) => match.workflowId === preview.librarySource!.workflowId);
    return (
      !!match &&
      transferSignature(match.transfer) === preview.librarySource.signature
    );
  } catch {
    return false;
  }
}

/** Match a complete original before interpreting ordinary text as new work. */
export function generateLocalTextPreview(
  text: string,
  context: TextPreviewContext = {},
): Omit<Candidate, "createRequestId"> {
  const source = text;
  const restored = parseWorkflowTransfer(text);
  if (restored) return restoredPreview(source, restored);
  // A recorded copy is the graph actually copied, including its then-current
  // layout. The most recently copied match takes precedence over current data.
  const recorded = context.recordedMatches?.[0];
  if (recorded) return matchedPreview(source, recorded);
  if (context.libraryReady === false)
    throw new Error(
      "还没有读到已有流程，请先重新读取，避免把原图拆成少量工作。",
    );
  const matches = findPlainTextWorkflowMatches(
    source,
    context.workflows ?? [],
    context.readOrder,
  );
  const preferred = matches.find(
    (match) => match.workflowId === context.preferredWorkflowId,
  );
  if (preferred) return matchedPreview(source, preferred, true);
  if (matches.length === 1) return matchedPreview(source, matches[0], true);
  if (matches.length > 1) throw new WorkflowTextAmbiguity(matches);
  const { diagram, notices } = parseLocalTextDiagram(source);
  const draft = createTextDiagramDraft(diagram);
  draft.steps = attachOriginalWorkflowText(draft, text);
  return { source, diagram, notices, draft };
}

export function WorkflowTextMatchChoices({
  matches,
  disabled = false,
  onChoose,
}: {
  matches: PlainTextWorkflowMatch[];
  disabled?: boolean;
  onChoose: (match: PlainTextWorkflowMatch) => void;
}) {
  return (
    <section className="text-diagram-matches" aria-label="选择要还原的原图">
      <p role="status">这段文字对应多张流程图，请选择要还原的原图：</p>
      <div>
        {matches.map((match, index) => (
          <button
            key={`${match.workflowId}:${index}`}
            type="button"
            disabled={disabled}
            onClick={() => onChoose(match)}
          >
            <strong>{match.title}</strong>
            <span>{match.moduleCount} 项工作 · 保留原图的位置和连线</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function TextDiagramPreview({
  diagram,
  workflow,
}: {
  diagram: TextDiagram;
  workflow: Workflow;
}) {
  return (
    <section className="text-diagram-preview" aria-label="生成结果预览">
      <LayoutPreview workflow={workflow} />
      <div className="text-diagram-details">
        {diagram.nodes.map((node) => (
          <article key={node.id}>
            <h3>{node.name}</h3>
            {node.details.length ? (
              <ul>
                {node.details.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">原文没有写具体做法。</p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function TextDiagramDialog({
  context,
  preferredWorkflowId,
  onClose,
}: {
  context: Context;
  preferredWorkflowId?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient(),
    navigate = useNavigate();
  const library = useQuery<Workflow[]>({
    queryKey: workflowKey(context.org),
    queryFn: () => api(`/orgs/${context.org}/sops`),
  });
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true),
    generating = useRef(false),
    creating = useRef(false);
  const sourceText = useRef("");
  const inputVersion = useRef(0);
  const savedWorkflow = useRef<Workflow | null>(null);
  const attemptedTitle = useRef<string | null>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [matchChoice, setMatchChoice] = useState<{
    source: string;
    matches: PlainTextWorkflowMatch[];
  } | null>(null);
  const [generationBusy, setGenerationBusy] = useState(false);
  const [creationBusy, setCreationBusy] = useState(false);
  const [createAttempted, setCreateAttempted] = useState(false);
  const [error, setError] = useState("");
  const heading = useId(),
    help = useId(),
    textInput = useId(),
    titleInput = useId();
  const currentSource = text;
  const stale = !!candidate && candidate.source !== currentSource;
  function libraryContext(
    workflows = library.data,
    ready = !library.isPending && !library.isError && !library.isFetching,
  ): TextPreviewContext {
    return {
      workflows,
      preferredWorkflowId,
      libraryReady: ready,
      readOrder: (workflowId, generatedWorkflow) =>
        readStoredPlainTextWorkflowOrder(
          context.user.id,
          context.org,
          workflowId,
          generatedWorkflow,
        ),
    };
  }
  const libraryStale = useMemo(
    () =>
      !!candidate &&
      !createAttempted &&
      !isTextPreviewCurrent(candidate, libraryContext()),
    [
      candidate,
      createAttempted,
      library.data,
      library.isPending,
      library.isError,
      library.isFetching,
      context.user.id,
      context.org,
    ],
  );

  useEffect(() => {
    alive.current = true;
    const element = dialog.current;
    element?.showModal();
    return () => {
      alive.current = false;
      element?.close();
    };
  }, []);

  function acceptPreview(generated: Omit<Candidate, "createRequestId">) {
    setCandidate({ ...generated, createRequestId: crypto.randomUUID() });
    setTitle(generated.draft.title);
    setMatchChoice(null);
    attemptedTitle.current = null;
    savedWorkflow.current = null;
    setCreateAttempted(false);
  }

  function generate() {
    const source = sourceText.current;
    if (!source.trim() || generating.current || creating.current) return;
    const version = inputVersion.current;
    generating.current = true;
    setGenerationBusy(true);
    setError("");
    setCandidate(null);
    setMatchChoice(null);
    try {
      const generated = generateLocalTextPreview(source, {
        ...libraryContext(),
        recordedMatches: findRecordedWorkflowCopies(
          {
            userId: typeof context.user.id === "string" ? context.user.id : "",
            orgId: context.org,
          },
          source,
        ),
      });
      if (!alive.current || inputVersion.current !== version) return;
      acceptPreview(generated);
    } catch (failure) {
      if (alive.current && inputVersion.current === version) {
        if (failure instanceof WorkflowTextAmbiguity)
          setMatchChoice({ source, matches: failure.matches });
        else
          setError((failure as Error).message || "这次没有生成成功，请重试。");
      }
    } finally {
      generating.current = false;
      if (alive.current) setGenerationBusy(false);
    }
  }

  function chooseMatch(match: PlainTextWorkflowMatch) {
    if (
      creating.current ||
      generating.current ||
      !matchChoice ||
      matchChoice.source !== sourceText.current ||
      !matchChoice.matches.includes(match)
    )
      return;
    setError("");
    try {
      acceptPreview(matchedPreview(matchChoice.source, match, true));
    } catch (failure) {
      setError(
        (failure as Error).message || "这张原图暂时无法还原，请重新读取。",
      );
    }
  }

  async function create() {
    if (
      creating.current ||
      generating.current ||
      !candidate ||
      candidate.source !== sourceText.current ||
      libraryStale ||
      !title.trim()
    )
      return;
    creating.current = true;
    setCreationBusy(true);
    setError("");
    try {
      // Once a save has been attempted, retries must retain the same request ID
      // even if the source changes while recovering an uncertain response.
      if (candidate.librarySource && attemptedTitle.current === null) {
        const current = await qc.fetchQuery<Workflow[]>({
          queryKey: workflowKey(context.org),
          queryFn: () => api(`/orgs/${context.org}/sops`),
          staleTime: 0,
        });
        if (!isTextPreviewCurrent(candidate, libraryContext(current, true)))
          throw new Error(
            "原流程刚有变化，请重新生成预览后再添加，避免还原旧的位置或做法。",
          );
      }
      attemptedTitle.current ??= title;
      setCreateAttempted(true);
      const saved =
        savedWorkflow.current ??
        (await api<Workflow>(`/orgs/${context.org}/sops/save`, {
          title: attemptedTitle.current,
          category: candidate.draft.category ?? "",
          steps: candidate.draft.steps,
          boardSettings: candidate.draft.boardSettings,
          draftOnly: true,
          createRequestId: candidate.createRequestId,
        }));
      savedWorkflow.current = saved;
      qc.setQueryData<Workflow[]>(workflowKey(context.org), (previous) => [
        ...(previous || []).filter((workflow) => workflow.id !== saved.id),
        saved,
      ]);
      // Refreshes are independent of creation: a refresh failure must not offer
      // a second create operation after the server has saved this new flow.
      void Promise.allSettled([
        qc.invalidateQueries({ queryKey: workflowKey(context.org) }),
        qc.invalidateQueries({ queryKey: workItemsKey(context.org) }),
      ]);
      if (alive.current) {
        context.notify("新流程已添加。点击工作方框，就能查看具体做法。");
        onClose();
        navigate(`/workflows/${saved.id}`);
      }
    } catch (failure) {
      if (alive.current)
        setError(
          (failure as Error).message ||
            "添加没有确认成功，请重试；重试不会重复添加。",
        );
    } finally {
      creating.current = false;
      if (alive.current) setCreationBusy(false);
    }
  }

  const preview: Workflow | null = candidate
    ? {
        id: "text-diagram-preview",
        title: title || candidate.draft.title,
        category: candidate.draft.category ?? "",
        draft: JSON.stringify(candidate.draft.steps),
        boardSettings: candidate.draft.boardSettings,
        revision: 0,
      }
    : null;

  return createPortal(
    <dialog
      ref={dialog}
      className="text-diagram-dialog"
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();
        if (!creating.current) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void create();
        }}
      >
        <div className="text-diagram-heading">
          <h2 id={heading}>文字生成流程图</h2>
          <button
            type="button"
            aria-label="关闭文字生成"
            disabled={creationBusy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="text-diagram-body">
          <label htmlFor={textInput}>粘贴完整流程文字</label>
          <textarea
            id={textInput}
            value={text}
            rows={8}
            disabled={creationBusy}
            aria-describedby={help}
            placeholder={
              "流程：做饭\n1. 洗菜：用清水洗净。\n2. 切菜：切成小块。\n3. 炒菜：炒熟后装盘。"
            }
            onChange={(event) => {
              inputVersion.current += 1;
              sourceText.current = event.target.value;
              setText(event.target.value);
              setMatchChoice(null);
              setError("");
            }}
          />
          <div className="text-diagram-input-meta">
            <p id={help}>本机生成，不用密钥，不产生 API 费用。</p>
            <span>{text.length} 字</span>
          </div>
          <p className="text-diagram-instructions">
            推荐每行写“工作名称：具体做法”，也可以用编号或“先…再…最后…”。生成后请核对划分和顺序。
            在完整流程里点“复制全文”，再把复制的整段内容粘贴到这里，即可保留原图；跨设备也能使用。
            手动复制的普通完整文字会先查找已有原图。 普通文字最多 16000
            字，还原文字最多 2 MB。
          </p>
          <div className="text-diagram-generate">
            <button
              type="button"
              className="btn secondary"
              disabled={generationBusy || creationBusy || !currentSource.trim()}
              onClick={generate}
            >
              <WandSparkles size={15} aria-hidden="true" />
              {generationBusy
                ? "正在生成…"
                : candidate
                  ? "免费重新生成"
                  : "免费生成预览"}
            </button>
            <p>先核对预览，确认后再添加为新流程。</p>
          </div>
          {(library.isPending || library.isFetching) && (
            <p className="muted" role="status">
              正在读取已有流程，避免把原图重新拆分…
            </p>
          )}
          {library.isError && (
            <p className="text-diagram-notice" role="alert">
              已有流程暂时没有读到，请重新读取后生成。
              <button
                type="button"
                className="text-button"
                disabled={library.isFetching || creationBusy}
                onClick={() => void library.refetch()}
              >
                重新读取
              </button>
            </p>
          )}
          {matchChoice && matchChoice.source === currentSource && (
            <WorkflowTextMatchChoices
              matches={matchChoice.matches}
              disabled={generationBusy || creationBusy}
              onChoose={chooseMatch}
            />
          )}
          {generationBusy && (
            <p className="muted" role="status">
              正在根据文字整理工作和先后顺序…
            </p>
          )}
          {candidate && preview && (
            <>
              {stale && (
                <p className="text-diagram-notice" role="status">
                  文字已修改，请重新生成预览。
                </p>
              )}
              {libraryStale && (
                <p className="text-diagram-notice" role="status">
                  {library.isFetching
                    ? "正在核对原流程，请稍后添加。"
                    : "原流程已更新或暂时无法读取，请重新生成预览。"}
                </p>
              )}
              <label htmlFor={titleInput}>新流程名称</label>
              <input
                id={titleInput}
                value={title}
                maxLength={200}
                disabled={creationBusy || generationBusy || createAttempted}
                onChange={(event) => setTitle(event.target.value)}
              />
              <p className="text-diagram-preview-meta">
                已整理 {candidate.diagram.nodes.length} 项工作，确认后再添加。
              </p>
              {candidate.notices.length > 0 && (
                <div className="text-diagram-notice" aria-label="生成提示">
                  <ul>
                    {candidate.notices.map((notice, index) => (
                      <li key={index}>{notice}</li>
                    ))}
                  </ul>
                </div>
              )}
              <TextDiagramPreview
                diagram={candidate.diagram}
                workflow={preview}
              />
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {error && createAttempted && (
            <p className="text-diagram-notice">
              可以重试添加同一份预览，不会重复创建。
            </p>
          )}
        </div>
        <div className="text-diagram-actions">
          <button
            type="button"
            className="btn secondary"
            disabled={creationBusy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="btn"
            disabled={
              creationBusy ||
              generationBusy ||
              !candidate ||
              stale ||
              libraryStale ||
              !title.trim()
            }
          >
            {creationBusy ? "正在添加…" : "添加为新流程"}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}

export function TextDiagramControls({
  disabled = false,
  className = "btn secondary",
  preferredWorkflowId,
  ...context
}: Context & {
  disabled?: boolean;
  className?: string;
  preferredWorkflowId?: string;
}) {
  const [open, setOpen] = useState(false);
  if (context.role === "EMPLOYEE" || !context.org) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <WandSparkles size={15} aria-hidden="true" />
        文字生成流程图
      </button>
      {open && (
        <TextDiagramDialog
          context={context}
          preferredWorkflowId={preferredWorkflowId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
