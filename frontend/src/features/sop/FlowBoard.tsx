import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRight,
  GripVertical,
  Move,
  Pencil,
  Plus,
  Trash2,
  Unlink,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import type { Workflow, WorkflowModule, WorkflowStep } from "../../types";
import {
  appendModuleEntries,
  moduleHref,
  readWorkflow,
  resolveModuleLink,
  workflowKey,
} from "./workflows";
import {
  arrowPath,
  availablePosition,
  canvasArrows,
  clampPosition,
  clampSize,
  connectModuleEntries,
  connectionPreviewPath,
  disconnectModuleEntries,
  modulePosition,
  moduleSize,
  moveModuleEntries,
  removeModuleEntries,
  resizeModuleEntries,
  minimumBoardSize,
  MIN_FRAME_SIZE,
  type Position,
  type Size,
  type ConnectionSide,
  type ConnectionPorts,
} from "./canvas";
import { workItemsKey } from "./workItems";
import { ModulePicker } from "./ModulePicker";
import { ModuleRenameDialog } from "./ModuleRenameDialog";
import { renameModuleEntries } from "./renameModule";
import { BoardAxesControls } from "./BoardAxesControls";
import { BoardSizeControls } from "./BoardSizeControls";
import { AutoLayoutControls } from "./AutoLayoutControls";
import { BoardZoomControls } from "./BoardZoomControls";
import { useBoardZoom } from "./useBoardZoom";
import { boardSettingsChange } from "./boardSettingsChange";
import { TimelineAxis, compactTimelineLabels } from "./TimelineAxis";
import {
  moduleAxisLabels,
  priorityTicks,
  readBoardAxes,
  serializeBoardAxes,
  type BoardAxesSettings,
  type BoardAxis,
  boardSize,
} from "./boardAxes";
import "./FlowBoard.css";

const connectionSides: ConnectionSide[] = ["top", "right", "bottom", "left"];
const sideNames: Record<ConnectionSide, string> = {
  top: "上边",
  right: "右边",
  bottom: "下边",
  left: "左边",
};

function CoordinateAxis({
  axis,
  settings,
}: {
  axis: BoardAxis;
  settings: BoardAxesSettings;
}) {
  const ticks = priorityTicks(settings);
  return (
    <div
      className={`flow-board-axis flow-priority-axis is-${axis === "x" ? "horizontal" : "vertical"}`}
      role="region"
      aria-label="优先级"
      data-axis={axis}
    >
      <span className="flow-axis-title">优先级 {axis === "x" ? "→" : "↓"}</span>
      {ticks.map((tick) => (
        <span
          key={tick.position}
          className={`flow-axis-tick flow-priority-tick${tick.position === 0 ? " is-start" : ""}${tick.position === 1 ? " is-end" : ""}`}
          style={
            axis === "x"
              ? { left: `${tick.position * 100}%` }
              : { top: `${tick.position * 100}%` }
          }
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}

function ModuleTile({
  module,
  position,
  size,
  axes,
  dimensions,
  scale,
  minimumSize,
  workflow,
  workflows,
  canDrag,
  busy,
  connecting,
  resizing,
  resizeSelected,
  selected,
  selectedSide,
  targeted,
  focused,
  onChoose,
  onStartConnection,
  onMoveConnection,
  onEndConnection,
  onCancelConnection,
  onPortClick,
  onStartResize,
  onMoveResize,
  onEndResize,
  onCancelResize,
  onResizeKeyDown,
  onRemove,
  onRename,
  onAuthorDetail,
}: {
  module: WorkflowModule;
  position: Position;
  size: Size;
  axes: BoardAxesSettings;
  dimensions: { width: number; height: number };
  scale: number;
  minimumSize: Size;
  workflow: Workflow;
  workflows: Workflow[];
  canDrag: boolean;
  busy: boolean;
  connecting: boolean;
  resizing: boolean;
  resizeSelected: boolean;
  selected: boolean;
  selectedSide: ConnectionSide;
  targeted: boolean;
  focused: boolean;
  onChoose: () => void;
  onStartConnection: (
    id: string,
    side: ConnectionSide,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onMoveConnection: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onEndConnection: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onCancelConnection: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPortClick: (
    id: string,
    side: ConnectionSide,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  onStartResize: (
    id: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onMoveResize: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onEndResize: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onCancelResize: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onResizeKeyDown: (
    id: string,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  onRemove?: () => void;
  onRename?: () => void;
  onAuthorDetail?: (title: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: module.id,
    disabled: !canDrag || busy || connecting || resizing,
  });
  const visiblePosition = transform
    ? clampPosition(
        {
          x: position.x + transform.x / ((dimensions.width || 1) * scale),
          y: position.y + transform.y / ((dimensions.height || 1) * scale),
        },
        size,
        minimumSize,
      )
    : position;
  const match = resolveModuleLink(workflow, module, workflows);
  const axisLabels = moduleAxisLabels(visiblePosition, size, axes);
  const hasAxisLabels = !!(axisLabels.time || axisLabels.priority);
  const priorityShort =
    axisLabels.priority === "优先做"
      ? "优先"
      : axisLabels.priority === "正常安排"
        ? "正常"
        : "稍后";
  const external =
    (typeof module.detailWorkflowId === "string" &&
      module.detailWorkflowId !== workflow.id) ||
    (!!match.targetWorkflow && match.targetWorkflow.id !== workflow.id);
  const compactControls =
    size.width * dimensions.width < 80 || size.height * dimensions.height < 80;
  return (
    <div
      ref={setNodeRef}
      id={`canvas-module-${module.id}`}
      data-module-id={module.id}
      className={`flow-tile${compactControls ? " has-compact-controls" : ""}${hasAxisLabels ? " has-axis-labels" : ""}${isDragging ? " is-dragging" : ""}${resizeSelected ? " is-resizing" : ""}${selected ? " is-connection-source" : ""}${targeted ? " is-connection-target" : ""}${focused ? " is-focused" : ""}`}
      style={{
        left: `${visiblePosition.x * 100}%`,
        top: `${visiblePosition.y * 100}%`,
        width: `${size.width * 100}%`,
        height: `${size.height * 100}%`,
      }}
    >
      <div className="flow-tile-top">
        {canDrag && (
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            className="flow-tile-handle"
            aria-label={`拖动工作 ${module.title}`}
            disabled={busy || connecting || resizing}
            title="按住这里拖动；也可以用空格键选中，再用方向键移动"
          >
            <GripVertical size={16} aria-hidden="true" />
          </button>
        )}
        <span className="flow-tile-spacer" />
        {onRename && (
          <button
            type="button"
            className="flow-tile-rename"
            aria-label={`给 ${module.title} 改名`}
            title="改名"
            disabled={busy || connecting || resizing || isDragging}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRename();
            }}
          >
            <Pencil size={13} aria-hidden="true" />
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            className="flow-tile-remove"
            aria-label={`删除工作 ${module.title}`}
            title="删除这项工作，也会从工作清单中移除"
            disabled={busy || connecting || resizing}
            onClick={onRemove}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      {connecting ? (
        <button
          type="button"
          className="flow-tile-link flow-connect-target"
          aria-label={`连接工作 ${module.title}`}
          aria-pressed={selected}
          disabled={busy}
          onClick={onChoose}
        >
          <span>{module.title}</span>
          <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      ) : (
        <Link
          className="flow-tile-link"
          to={moduleHref(workflow, module, workflows)}
          aria-label={module.title}
          title={module.title}
          target={onAuthorDetail && external ? "_blank" : undefined}
          rel={onAuthorDetail && external ? "noreferrer" : undefined}
          onClick={(event) => {
            if (busy || isDragging || resizing) event.preventDefault();
            else if (onAuthorDetail && !external) {
              event.preventDefault();
              onAuthorDetail(
                match.detail?.title ||
                  (typeof module.detailName === "string" &&
                  module.detailName.trim()
                    ? module.detailName
                    : module.title),
              );
            }
          }}
        >
          <span>{module.title}</span>
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      )}
      {hasAxisLabels && (
        <span
          className="flow-tile-axis-info"
          aria-label={`${module.title} 的时间和优先级`}
          data-axis-time={axisLabels.time}
          data-axis-priority={axisLabels.priority}
          title={[axisLabels.time, axisLabels.priority]
            .filter(Boolean)
            .join(" · ")}
        >
          {axisLabels.time && (
            <span className="flow-tile-axis-time">{axisLabels.time}</span>
          )}
          {axisLabels.priority && (
            <span className="flow-tile-axis-priority">{priorityShort}</span>
          )}
        </span>
      )}
      {canDrag &&
        connectionSides.map((side) => (
          <button
            key={side}
            type="button"
            className={`flow-tile-port is-${side}`}
            data-side={side}
            aria-label={
              side === "right"
                ? `从 ${module.title} 画箭头`
                : `从 ${module.title} 的${sideNames[side]}画箭头`
            }
            title={`从${sideNames[side]}画箭头`}
            aria-pressed={selected && selectedSide === side}
            disabled={busy || resizing}
            onPointerDown={(event) => onStartConnection(module.id, side, event)}
            onPointerMove={onMoveConnection}
            onPointerUp={onEndConnection}
            onPointerCancel={onCancelConnection}
            onLostPointerCapture={onCancelConnection}
            onClick={(event) => onPortClick(module.id, side, event)}
          />
        ))}
      {canDrag && (
        <button
          type="button"
          className="flow-tile-resize"
          aria-label={`调整 ${module.title} 的大小`}
          title="拖动这里改变宽高，也可以用方向键微调"
          disabled={busy}
          onPointerDown={(event) => onStartResize(module.id, event)}
          onPointerMove={onMoveResize}
          onPointerUp={onEndResize}
          onPointerCancel={onCancelResize}
          onLostPointerCapture={onCancelResize}
          onKeyDown={(event) => onResizeKeyDown(module.id, event)}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <svg
            viewBox="0 0 12 12"
            width="12"
            height="12"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M3 9 9 3M6 9 9 6M9 9h.01"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

export function WorkflowCanvas({
  workflow,
  workflows,
  canEdit,
  busy = false,
  onMove,
  onResize,
  onBoardSettingsChange,
  onArrange,
  onConnect,
  onDisconnect,
  onAdd,
  onRemove,
  onRename,
  onAuthorDetail,
  onDragStart,
  feedback,
  error,
}: {
  workflow: Workflow;
  workflows: Workflow[];
  canEdit: boolean;
  busy?: boolean;
  onMove: (id: string, position: Position) => void | Promise<void>;
  onResize: (id: string, size: Size) => void | Promise<void>;
  onBoardSettingsChange: (value: string) => void | Promise<void>;
  onArrange: (
    snapshot: Workflow,
    steps: WorkflowStep[],
  ) => void | Promise<void>;
  onConnect: (
    sourceId: string,
    targetId: string,
    ports: ConnectionPorts,
  ) => void | Promise<void>;
  onDisconnect: (sourceId: string, targetId: string) => void | Promise<void>;
  onAdd: (module: WorkflowModule) => void | Promise<void>;
  onRemove?: (id: string) => void | Promise<void>;
  onRename: (id: string, name: string) => void | Promise<void>;
  onAuthorDetail?: (title: string) => void;
  onDragStart?: () => void;
  feedback?: string;
  error?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<WorkflowModule | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const sourceIdRef = useRef<string | null>(null);
  const [sourceSide, setSourceSide] = useState<ConnectionSide>("right");
  const sourceSideRef = useRef<ConnectionSide>("right");
  const connecting = sourceId !== null;
  const connectionSaving = useRef(false);
  const suppressPortClick = useRef(false);
  const connectionGesture = useRef<{
    pointerId: number;
    sourceId: string;
    sourceSide: ConnectionSide;
    element: HTMLButtonElement;
    startX: number;
    startY: number;
    moved: boolean;
    alreadySelected: boolean;
  } | null>(null);
  const [connectionPreview, setConnectionPreview] = useState<{
    point: Position;
    targetId: string | null;
    targetSide?: ConnectionSide;
  } | null>(null);
  const [localError, setLocalError] = useState("");
  const [timelinePreview, setTimelinePreview] = useState<{
    steps: WorkflowStep[];
    boardSettings: string;
  } | null>(null);
  const [preview, setPreview] = useState<{
    id: string;
    position: Position;
  } | null>(null);
  const [resizePreview, setResizePreview] = useState<{
    id: string;
    size: Size;
  } | null>(null);
  const resizeGesture = useRef<{
    id: string;
    pointerId: number;
    element: HTMLButtonElement;
    startX: number;
    startY: number;
    position: Position;
    size: Size;
    width: number;
    height: number;
  } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const plane = useRef<HTMLDivElement>(null);
  const [axisGutter, setAxisGutter] = useState(0);
  const [dimensions, setDimensions] = useState({ width: 1, height: 1 });
  const drag = useRef<{
    id: string;
    position: Position;
    size: Size;
    width: number;
    height: number;
  } | null>(null);
  const markerId = useId().replaceAll(":", "");
  const [params] = useSearchParams();
  const storedModules = readWorkflow(
    timelinePreview ? JSON.stringify(timelinePreview.steps) : workflow.draft,
  ).modules;
  const axes = readBoardAxes(
    timelinePreview?.boardSettings || workflow.boardSettings,
  );
  const timeAxis = axes.timeline.axis || "x";
  const priorityAxis = axes.priority.axis || "y";
  const hasHorizontalAxis =
    (axes.timeline.enabled && timeAxis === "x") ||
    (axes.priority.enabled && priorityAxis === "x");
  const hasVerticalAxis =
    (axes.timeline.enabled && timeAxis === "y") ||
    (axes.priority.enabled && priorityAxis === "y");
  const logicalSize = boardSize(axes);
  const referenceSize = axes.referenceCanvas || logicalSize;
  const shownSize = logicalSize;
  const modules = storedModules;
  const horizontalAxisHeight =
    axes.timeline.enabled && timeAxis === "x" && compactTimelineLabels(axes)
      ? 96
      : 52;
  const planeSize = {
    width: logicalSize.width + axisGutter + 2,
    height:
      logicalSize.height +
      2 +
      (hasHorizontalAxis ? horizontalAxisHeight : hasVerticalAxis ? 30 : 0),
  };
  const zoomDisabled =
    busy || connecting || !!resizePreview || !!preview || !!timelinePreview;
  const boardZoom = useBoardZoom({
    workflowId: workflow.id,
    logicalSize: planeSize,
    disabled: zoomDisabled,
  });
  const scale = boardZoom.scale;
  const minimumSize = {
    width: MIN_FRAME_SIZE / shownSize.width,
    height: MIN_FRAME_SIZE / shownSize.height,
  };
  const addSize = {
    width: Math.min(
      1,
      Math.max(MIN_FRAME_SIZE, referenceSize.width * 0.2) / shownSize.width,
    ),
    height: Math.min(
      1,
      Math.max(MIN_FRAME_SIZE, referenceSize.height * 0.2) / shownSize.height,
    ),
  };
  const arrows = canvasArrows(modules);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 6 },
    }),
    useSensor(KeyboardSensor),
  );
  const addPosition = availablePosition(modules, shownSize, addSize);
  useLayoutEffect(() => {
    const element = plane.current;
    if (!element) return;
    const update = () => {
      const gutter = hasVerticalAxis
        ? parseFloat(
            getComputedStyle(element).getPropertyValue("--flow-axis-gutter"),
          ) || 64
        : 0;
      setAxisGutter(gutter);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [hasVerticalAxis, timeAxis]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const update = () =>
      setDimensions({
        width: element.clientWidth,
        height: element.clientHeight,
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const id = params.get("module");
    if (id)
      document
        .getElementById(`canvas-module-${id}`)
        ?.scrollIntoView({ block: "center" });
  }, [params, workflow.id, modules.length]);

  async function perform(action: () => void | Promise<void>) {
    setLocalError("");
    try {
      await action();
    } catch (failure) {
      setLocalError((failure as Error).message);
    }
  }
  function begin(event: DragStartEvent) {
    const index = modules.findIndex((module) => module.id === event.active.id);
    if (index < 0 || busy || resizeGesture.current || boardZoom.isActive())
      return;
    drag.current = {
      id: modules[index].id,
      position: modulePosition(modules[index], index, shownSize),
      size: moduleSize(modules[index], shownSize),
      width: (canvas.current?.clientWidth || 1) * scale,
      height: (canvas.current?.clientHeight || 1) * scale,
    };
    setPreview({ id: drag.current.id, position: drag.current.position });
    setLocalError("");
    onDragStart?.();
  }
  function draggedPosition(event: DragMoveEvent | DragEndEvent) {
    const snapshot = drag.current;
    return (
      snapshot &&
      clampPosition(
        {
          x: snapshot.position.x + event.delta.x / snapshot.width,
          y: snapshot.position.y + event.delta.y / snapshot.height,
        },
        snapshot.size,
        minimumSize,
      )
    );
  }
  function end(event: DragEndEvent) {
    const snapshot = drag.current,
      position = draggedPosition(event);
    drag.current = null;
    setPreview(null);
    if (
      snapshot &&
      position &&
      canEdit &&
      !busy &&
      (Math.abs(position.x - snapshot.position.x) > 0.0001 ||
        Math.abs(position.y - snapshot.position.y) > 0.0001)
    )
      void perform(() => onMove(snapshot.id, position));
  }
  function selectSource(id: string | null, side: ConnectionSide = "right") {
    sourceIdRef.current = id;
    setSourceId(id);
    sourceSideRef.current = side;
    setSourceSide(side);
  }
  function clearConnection() {
    const gesture = connectionGesture.current;
    connectionGesture.current = null;
    if (gesture) {
      suppressPortClick.current = true;
      if (gesture.element.hasPointerCapture(gesture.pointerId))
        gesture.element.releasePointerCapture(gesture.pointerId);
    }
    selectSource(null);
    setConnectionPreview(null);
  }
  function clearResize() {
    const gesture = resizeGesture.current;
    resizeGesture.current = null;
    if (gesture?.element.hasPointerCapture(gesture.pointerId))
      gesture.element.releasePointerCapture(gesture.pointerId);
    setResizePreview(null);
  }
  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        (sourceIdRef.current || resizeGesture.current)
      ) {
        event.preventDefault();
        clearConnection();
        clearResize();
      }
    };
    const cancelOnBlur = () => {
      clearConnection();
      clearResize();
    };
    window.addEventListener("keydown", cancelOnEscape);
    window.addEventListener("blur", cancelOnBlur);
    return () => {
      window.removeEventListener("keydown", cancelOnEscape);
      window.removeEventListener("blur", cancelOnBlur);
    };
  }, []);
  useEffect(() => {
    if (
      busy ||
      !canEdit ||
      (sourceIdRef.current &&
        !modules.some((module) => module.id === sourceIdRef.current))
    )
      clearConnection();
    if (
      busy ||
      !canEdit ||
      (resizeGesture.current &&
        !modules.some((module) => module.id === resizeGesture.current?.id))
    )
      clearResize();
  }, [busy, canEdit, workflow.draft]);
  function connectionTarget(clientX: number, clientY: number) {
    const hit = document.elementFromPoint(clientX, clientY);
    const element = hit?.closest<HTMLElement>(".flow-tile[data-module-id]");
    if (!element?.dataset.moduleId || !canvas.current?.contains(element))
      return null;
    const side = hit?.closest<HTMLElement>(".flow-tile-port")?.dataset.side as
      ConnectionSide | undefined;
    return {
      id: element.dataset.moduleId,
      side: side && connectionSides.includes(side) ? side : undefined,
    };
  }
  function connectionPoint(clientX: number, clientY: number): Position {
    const element = canvas.current!;
    const bounds = element.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          1,
          (clientX - bounds.left - element.clientLeft * scale) /
            (element.clientWidth * scale),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          1,
          (clientY - bounds.top - element.clientTop * scale) /
            (element.clientHeight * scale),
        ),
      ),
    };
  }
  async function createConnection(
    from: string,
    to: string,
    ports: ConnectionPorts,
  ) {
    if (!canEdit || busy || connectionSaving.current || from === to) return;
    connectionSaving.current = true;
    clearConnection();
    try {
      setLocalError("");
      const source = modules.find((module) => module.id === from);
      if (!source || !modules.some((module) => module.id === to))
        throw new Error("要连接的工作已经不在这里了。");
      if (source.nextModuleIds?.includes(to))
        throw new Error("这条箭头已经存在。");
      await onConnect(from, to, ports);
    } catch (failure) {
      setLocalError((failure as Error).message);
    } finally {
      connectionSaving.current = false;
    }
  }
  function choose(id: string, side?: ConnectionSide) {
    if (!canEdit || busy || connectionSaving.current) return;
    const source = sourceIdRef.current;
    if (!source) {
      selectSource(id, side);
      onDragStart?.();
      setLocalError("");
    } else if (source === id) {
      if (!side || sourceSideRef.current === side) clearConnection();
      else {
        selectSource(id, side);
        setConnectionPreview(null);
      }
    } else
      void createConnection(source, id, {
        source: sourceSideRef.current,
        ...(side ? { target: side } : {}),
      });
  }
  function startConnection(
    id: string,
    side: ConnectionSide,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      busy ||
      !canEdit ||
      connectionSaving.current ||
      drag.current ||
      resizeGesture.current ||
      boardZoom.isActive()
    )
      return;
    event.stopPropagation();
    suppressPortClick.current = false;
    // A second port can also be clicked as the destination of a selected source.
    if (sourceIdRef.current && sourceIdRef.current !== id) return;
    event.preventDefault();
    const alreadySelected =
      sourceIdRef.current === id && sourceSideRef.current === side;
    connectionGesture.current = {
      pointerId: event.pointerId,
      sourceId: id,
      sourceSide: side,
      element: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      alreadySelected,
    };
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!sourceIdRef.current) onDragStart?.();
    selectSource(id, side);
    setLocalError("");
    setConnectionPreview(null);
  }
  function moveConnection(event: ReactPointerEvent<HTMLButtonElement>) {
    const gesture = connectionGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (
      Math.hypot(
        event.clientX - gesture.startX,
        event.clientY - gesture.startY,
      ) >= 5
    )
      gesture.moved = true;
    if (!gesture.moved) return;
    const target = connectionTarget(event.clientX, event.clientY);
    setConnectionPreview({
      point: connectionPoint(event.clientX, event.clientY),
      targetId: target?.id === gesture.sourceId ? null : target?.id || null,
      targetSide: target?.side,
    });
  }
  function endConnection(event: ReactPointerEvent<HTMLButtonElement>) {
    const gesture = connectionGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (busy || !canEdit) {
      clearConnection();
      return;
    }
    connectionGesture.current = null;
    suppressPortClick.current = true;
    if (gesture.element.hasPointerCapture(gesture.pointerId))
      gesture.element.releasePointerCapture(gesture.pointerId);
    setConnectionPreview(null);
    if (gesture.moved) {
      const target = connectionTarget(event.clientX, event.clientY);
      clearConnection();
      if (target && target.id !== gesture.sourceId)
        void createConnection(gesture.sourceId, target.id, {
          source: gesture.sourceSide,
          ...(target.side ? { target: target.side } : {}),
        });
    } else if (gesture.alreadySelected) clearConnection();
  }
  function cancelConnection(event: ReactPointerEvent<HTMLButtonElement>) {
    if (connectionGesture.current?.pointerId === event.pointerId)
      clearConnection();
  }
  function clickPort(
    id: string,
    side: ConnectionSide,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (event.detail > 0 && suppressPortClick.current) {
      suppressPortClick.current = false;
      return;
    }
    choose(id, side);
  }
  function boundedResize(
    requested: Size,
    initial: Size,
    position: Position,
    width: number,
    height: number,
  ): Size {
    return clampSize(
      {
        width: Math.max(
          minimumSize.width,
          Math.min(initial.width, 64 / width),
          requested.width,
        ),
        height: Math.max(
          minimumSize.height,
          Math.min(initial.height, 64 / height),
          requested.height,
        ),
      },
      position,
      minimumSize,
    );
  }
  function resizedSize(
    event: ReactPointerEvent<HTMLButtonElement>,
    gesture: NonNullable<typeof resizeGesture.current>,
  ) {
    return boundedResize(
      {
        width:
          gesture.size.width + (event.clientX - gesture.startX) / gesture.width,
        height:
          gesture.size.height +
          (event.clientY - gesture.startY) / gesture.height,
      },
      gesture.size,
      gesture.position,
      gesture.width,
      gesture.height,
    );
  }
  function startResize(
    id: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      !canEdit ||
      busy ||
      connectionSaving.current ||
      connectionGesture.current ||
      drag.current ||
      resizeGesture.current ||
      boardZoom.isActive()
    )
      return;
    const index = modules.findIndex((module) => module.id === id);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    clearConnection();
    const size = moduleSize(modules[index], shownSize);
    resizeGesture.current = {
      id,
      pointerId: event.pointerId,
      element: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      position: modulePosition(modules[index], index, shownSize),
      size,
      width: (canvas.current?.clientWidth || 1) * scale,
      height: (canvas.current?.clientHeight || 1) * scale,
    };
    setResizePreview({ id, size });
    setLocalError("");
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    onDragStart?.();
  }
  function moveResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const gesture = resizeGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    setResizePreview({ id: gesture.id, size: resizedSize(event, gesture) });
  }
  function endResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const gesture = resizeGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const size = resizedSize(event, gesture);
    resizeGesture.current = null;
    if (gesture.element.hasPointerCapture(gesture.pointerId))
      gesture.element.releasePointerCapture(gesture.pointerId);
    setResizePreview(null);
    if (
      Math.abs(size.width - gesture.size.width) > 0.0001 ||
      Math.abs(size.height - gesture.size.height) > 0.0001
    )
      void perform(() => onResize(gesture.id, size));
  }
  function cancelResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (resizeGesture.current?.pointerId === event.pointerId) clearResize();
  }
  function resizeWithKeyboard(
    id: string,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    if (
      !canEdit ||
      busy ||
      resizeGesture.current ||
      drag.current ||
      connectionGesture.current ||
      connectionSaving.current ||
      boardZoom.isActive()
    )
      return;
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    )
      return;
    const index = modules.findIndex((module) => module.id === id);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    clearConnection();
    const initial = moduleSize(modules[index], shownSize);
    const step = event.shiftKey ? 0.05 : 0.02;
    const size = boundedResize(
      {
        width:
          initial.width +
          (event.key === "ArrowRight"
            ? step
            : event.key === "ArrowLeft"
              ? -step
              : 0),
        height:
          initial.height +
          (event.key === "ArrowDown"
            ? step
            : event.key === "ArrowUp"
              ? -step
              : 0),
      },
      initial,
      modulePosition(modules[index], index, shownSize),
      (canvas.current?.clientWidth || 1) * scale,
      (canvas.current?.clientHeight || 1) * scale,
    );
    if (
      Math.abs(size.width - initial.width) > 0.0001 ||
      Math.abs(size.height - initial.height) > 0.0001
    ) {
      onDragStart?.();
      void perform(() => onResize(id, size));
    }
  }
  const positionFor = (id: string) => {
    const index = modules.findIndex((module) => module.id === id);
    return preview?.id === id
      ? preview.position
      : modulePosition(modules[index], index, shownSize);
  };
  const sizeFor = (id: string) => {
    const module = modules.find((module) => module.id === id);
    return resizePreview?.id === id
      ? resizePreview.size
      : module
        ? moduleSize(module, shownSize)
        : { width: 0.2, height: 0.2 };
  };
  const connectionPath = (() => {
    if (
      !sourceId ||
      !connectionPreview ||
      !modules.some((module) => module.id === sourceId)
    )
      return null;
    const start = positionFor(sourceId);
    if (
      connectionPreview.targetId &&
      modules.some((module) => module.id === connectionPreview.targetId)
    )
      return arrowPath(
        start,
        positionFor(connectionPreview.targetId),
        sizeFor(sourceId),
        sizeFor(connectionPreview.targetId),
        dimensions,
        {
          source: sourceSide,
          ...(connectionPreview.targetSide
            ? { target: connectionPreview.targetSide }
            : {}),
        },
      );
    return connectionPreviewPath(
      start,
      sizeFor(sourceId),
      connectionPreview.point,
      sourceSide,
      dimensions,
    );
  })();
  return (
    <section
      className={`flow-board${drag.current ? " is-moving-work" : ""}`}
      aria-label="流程图"
      aria-busy={busy}
    >
      <div className="flow-board-heading">
        <div>
          <Move size={17} aria-hidden="true" />
          <h2>流程图</h2>
        </div>
        <div className="flow-board-tools">
          <span>
            {modules.length} 项工作 · {arrows.length} 条箭头
          </span>
          <BoardZoomControls
            key={workflow.id}
            scale={scale}
            disabled={zoomDisabled || boardZoom.resizing}
            onScaleChange={boardZoom.setScale}
          />
          {canEdit && (
            <AutoLayoutControls
              workflow={workflow}
              workflows={workflows}
              disabled={zoomDisabled || boardZoom.resizing}
              onBegin={onDragStart}
              onApply={onArrange}
            />
          )}
          {canEdit && (
            <BoardSizeControls
              value={workflow.boardSettings}
              minimum={minimumBoardSize(modules, logicalSize)}
              disabled={zoomDisabled || boardZoom.resizing}
              onBegin={onDragStart}
              onChange={onBoardSettingsChange}
            />
          )}
          {canEdit && (
            <BoardAxesControls
              value={workflow.boardSettings}
              disabled={zoomDisabled || boardZoom.resizing}
              onBegin={onDragStart}
              onChange={onBoardSettingsChange}
            />
          )}
        </div>
      </div>
      <div className="flow-board-viewport">
        <div
          className="flow-board-stage"
          style={{
            width: planeSize.width * scale,
            height: planeSize.height * scale,
          }}
        >
          <div
            ref={plane}
            className={`flow-board-plane${hasHorizontalAxis ? " has-horizontal-axis" : ""}${hasVerticalAxis ? " has-vertical-axis" : ""}${axes.timeline.enabled && timeAxis === "y" ? " has-vertical-time-axis" : ""}`}
            style={{
              width: planeSize.width,
              height: planeSize.height,
              transform: `scale(${scale})`,
              maxWidth: "none",
              ...(hasHorizontalAxis
                ? { gridTemplateRows: `${horizontalAxisHeight}px auto` }
                : {}),
            }}
          >
            {axes.timeline.enabled && (
              <TimelineAxis
                key={workflow.id}
                settings={axes}
                disabled={
                  !canEdit ||
                  busy ||
                  connecting ||
                  !!resizePreview ||
                  !!preview ||
                  boardZoom.resizing
                }
                onBegin={() => {
                  onDragStart?.();
                  setLocalError("");
                  setTimelinePreview({
                    steps: JSON.parse(workflow.draft),
                    boardSettings: serializeBoardAxes(axes),
                  });
                }}
                onPreview={(value) => {
                  setTimelinePreview(
                    value === null
                      ? null
                      : boardSettingsChange(
                          workflow.draft,
                          workflow.boardSettings,
                          value,
                        ),
                  );
                }}
                onCommit={onBoardSettingsChange}
                onError={setLocalError}
              />
            )}
            {axes.priority.enabled && (
              <CoordinateAxis axis={priorityAxis} settings={axes} />
            )}
            <DndContext
              sensors={sensors}
              autoScroll={false}
              onDragStart={begin}
              onDragMove={(event) => {
                const position = draggedPosition(event);
                if (drag.current && position)
                  setPreview({ id: drag.current.id, position });
              }}
              onDragEnd={end}
              onDragCancel={() => {
                drag.current = null;
                setPreview(null);
              }}
              accessibility={{
                screenReaderInstructions: {
                  draggable:
                    "按空格键选中工作，用方向键移动，再按空格键放下。按 Esc 键取消。",
                },
                announcements: {
                  onDragStart: ({ active }) =>
                    `已选中工作 ${modules.find((module) => module.id === active.id)?.title || ""}。`,
                  onDragMove: () => "正在移动这项工作。",
                  onDragOver: () => undefined,
                  onDragEnd: () => "这项工作已放好。",
                  onDragCancel: () => "已取消移动。",
                },
              }}
            >
              <div
                ref={canvas}
                className={`flow-board-canvas${connecting ? " is-connecting" : ""}${boardZoom.resizing ? " is-board-resizing" : ""}`}
                style={{
                  width: logicalSize.width,
                  height: logicalSize.height,
                  aspectRatio: "auto",
                }}
                data-board-width={shownSize.width}
                data-board-height={shownSize.height}
                role="region"
                aria-label="各项工作"
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) clearConnection();
                }}
              >
                <svg
                  className="flow-arrows"
                  viewBox="0 0 1000 1000"
                  preserveAspectRatio="none"
                  aria-label="流程箭头"
                >
                  <defs>
                    <marker
                      id={`arrow-${markerId}`}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="8"
                      markerHeight="8"
                      orient="auto"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="#78965f" />
                    </marker>
                  </defs>
                  {arrows.map(({ sourceId, targetId, ports }) => (
                    <path
                      key={`${sourceId}-${targetId}`}
                      data-source={sourceId}
                      data-target={targetId}
                      data-source-side={ports?.source}
                      data-target-side={ports?.target}
                      d={arrowPath(
                        positionFor(sourceId),
                        positionFor(targetId),
                        sizeFor(sourceId),
                        sizeFor(targetId),
                        dimensions,
                        ports,
                      )}
                      fill="none"
                      stroke="#78965f"
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                      markerEnd={`url(#arrow-${markerId})`}
                    >
                      <title>
                        {
                          modules.find((module) => module.id === sourceId)
                            ?.title
                        }{" "}
                        到{" "}
                        {
                          modules.find((module) => module.id === targetId)
                            ?.title
                        }
                      </title>
                    </path>
                  ))}
                  {connectionPath && (
                    <path
                      className="flow-arrow-preview"
                      data-connection-preview="true"
                      d={connectionPath}
                      fill="none"
                      stroke="#719363"
                      strokeWidth="2"
                      strokeDasharray="5 4"
                      vectorEffect="non-scaling-stroke"
                      markerEnd={`url(#arrow-${markerId})`}
                      aria-hidden="true"
                    />
                  )}
                </svg>
                {modules.map((module, index) => (
                  <ModuleTile
                    key={module.id}
                    module={module}
                    position={modulePosition(module, index, shownSize)}
                    size={sizeFor(module.id)}
                    axes={axes}
                    dimensions={dimensions}
                    scale={scale}
                    minimumSize={minimumSize}
                    workflow={workflow}
                    workflows={workflows}
                    canDrag={canEdit}
                    busy={busy || boardZoom.resizing || !!timelinePreview}
                    connecting={connecting}
                    resizing={!!resizePreview}
                    resizeSelected={resizePreview?.id === module.id}
                    selected={sourceId === module.id}
                    selectedSide={sourceSide}
                    targeted={connectionPreview?.targetId === module.id}
                    focused={params.get("module") === module.id}
                    onChoose={() => choose(module.id)}
                    onStartConnection={startConnection}
                    onMoveConnection={moveConnection}
                    onEndConnection={endConnection}
                    onCancelConnection={cancelConnection}
                    onPortClick={clickPort}
                    onStartResize={startResize}
                    onMoveResize={moveResize}
                    onEndResize={endResize}
                    onCancelResize={cancelResize}
                    onResizeKeyDown={resizeWithKeyboard}
                    onRemove={
                      onRemove
                        ? () => void perform(() => onRemove(module.id))
                        : undefined
                    }
                    onRename={
                      canEdit
                        ? () => {
                            clearConnection();
                            setLocalError("");
                            onDragStart?.();
                            setRenaming(module);
                          }
                        : undefined
                    }
                    onAuthorDetail={onAuthorDetail}
                  />
                ))}
                {canEdit && modules.length < 100 && !connecting && (
                  <div
                    className="flow-add-cell"
                    style={{
                      left: `${addPosition.x * 100}%`,
                      top: `${addPosition.y * 100}%`,
                      width: `${addSize.width * 100}%`,
                      height: `${addSize.height * 100}%`,
                    }}
                  >
                    <button
                      type="button"
                      className="flow-add-button"
                      aria-label="添加工作"
                      title="添加新工作，或选择已有的工作"
                      disabled={
                        busy ||
                        !!resizePreview ||
                        boardZoom.resizing ||
                        !!timelinePreview
                      }
                      onClick={() => setAdding(true)}
                    >
                      <Plus size={30} strokeWidth={1.4} aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>
            </DndContext>
          </div>
          <button
            type="button"
            className="flow-board-resize"
            aria-label="缩放流程图"
            aria-disabled={zoomDisabled}
            {...boardZoom.handleProps}
          >
            <svg
              viewBox="0 0 12 12"
              width="14"
              height="14"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M3 9 9 3M6 9 9 6M9 9h.01"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>
      {(sourceId || localError || error || feedback) && (
        <div className="flow-board-feedback">
          {localError || error ? (
            <p role="alert" className="error">
              {localError || error}
            </p>
          ) : sourceId ? (
            <span role="status">
              拖到下一项工作，或点一下要连接的工作；按 Esc 键取消。
            </span>
          ) : (
            <span role="status">{feedback}</span>
          )}
        </div>
      )}
      {arrows.length > 0 && (
        <div className="flow-connections" aria-label="已添加的箭头">
          {arrows.map(({ sourceId, targetId }) => {
            const source = modules.find((module) => module.id === sourceId)!,
              target = modules.find((module) => module.id === targetId)!;
            return (
              <div key={`${sourceId}-${targetId}`}>
                <span>{source.title}</span>
                <ArrowRight size={13} />
                <span>{target.title}</span>
                {canEdit && (
                  <button
                    type="button"
                    aria-label={`删除箭头 ${source.title} 到 ${target.title}`}
                    disabled={busy || boardZoom.resizing}
                    onClick={() =>
                      void perform(() => onDisconnect(sourceId, targetId))
                    }
                  >
                    <Unlink size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {adding && (
        <ModulePicker
          workflow={workflow}
          workflows={workflows}
          onAdd={(module) =>
            onAdd({
              ...module,
              frame: {
                x: addPosition.x * logicalSize.width,
                y: addPosition.y * logicalSize.height,
                width: addSize.width * logicalSize.width,
                height: addSize.height * logicalSize.height,
              },
              nextModuleIds: [],
            })
          }
          onClose={() => setAdding(false)}
        />
      )}
      {renaming && (
        <ModuleRenameDialog
          module={renaming}
          workflow={workflow}
          workflows={workflows}
          onRename={onRename}
          onClose={() => setRenaming(null)}
        />
      )}
    </section>
  );
}

export function FlowBoard({
  workflow,
  org,
  canEdit,
}: {
  workflow: Workflow;
  org: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const q = useQuery<Workflow[]>({
    queryKey: workflowKey(org),
    queryFn: () => api(`/orgs/${org}/sops`),
  });
  const [optimistic, setOptimistic] = useState<Workflow | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const saving = useRef(false),
    source = useRef(workflow);
  async function persist(
    snapshot: Workflow,
    steps: WorkflowStep[],
    success: string,
    boardSettings = snapshot.boardSettings,
  ) {
    if (!canEdit || saving.current) throw new Error("正在保存，请稍后再试。");
    saving.current = true;
    setOptimistic({ ...snapshot, draft: JSON.stringify(steps), boardSettings });
    setBusy(true);
    setError("");
    setMessage("正在保存…");
    try {
      const saved = await api<Workflow>(`/orgs/${org}/sops/save`, {
        draftOnly: true,
        id: snapshot.id,
        expectedRevision: snapshot.revision,
        title: snapshot.title,
        category: snapshot.category,
        steps,
        boardSettings,
      });
      qc.setQueryData<Workflow[]>(workflowKey(org), (records) =>
        records?.map((record) => (record.id === saved.id ? saved : record)),
      );
      setMessage(success);
    } catch (failure) {
      setMessage("");
      setError(`保存失败：${(failure as Error).message}`);
      throw failure;
    } finally {
      setOptimistic(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: workflowKey(org) }),
        qc.invalidateQueries({ queryKey: workItemsKey(org) }),
      ]);
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <WorkflowCanvas
      workflow={optimistic || workflow}
      workflows={q.data || []}
      canEdit={canEdit}
      busy={busy}
      onDragStart={() => {
        source.current = workflow;
        setMessage("");
      }}
      onMove={(id, position) =>
        persist(
          source.current,
          moveModuleEntries(
            source.current.draft,
            id,
            position,
            boardSize(readBoardAxes(source.current.boardSettings)),
          ),
          "工作的新位置已保存",
        )
      }
      onArrange={(snapshot, steps) =>
        persist(snapshot, steps, "工作位置已整理")
      }
      onResize={(id, size) =>
        persist(
          source.current,
          resizeModuleEntries(
            source.current.draft,
            id,
            size,
            boardSize(readBoardAxes(source.current.boardSettings)),
          ),
          "方框大小已保存",
        )
      }
      onBoardSettingsChange={(boardSettings) => {
        const before = boardSize(readBoardAxes(source.current.boardSettings));
        const after = boardSize(readBoardAxes(boardSettings));
        const change = boardSettingsChange(
          source.current.draft,
          source.current.boardSettings,
          boardSettings,
        );
        return persist(
          source.current,
          change.steps,
          before.width !== after.width || before.height !== after.height
            ? "模版大小已保存"
            : "时间和优先级已保存",
          change.boardSettings,
        );
      }}
      onConnect={(sourceId, targetId, ports) =>
        persist(
          source.current,
          connectModuleEntries(source.current.draft, sourceId, targetId, ports),
          "箭头已保存",
        )
      }
      onDisconnect={(sourceId, targetId) =>
        persist(
          workflow,
          disconnectModuleEntries(workflow.draft, sourceId, targetId),
          "箭头已移除",
        )
      }
      onRemove={
        canEdit
          ? (id) =>
              persist(
                workflow,
                removeModuleEntries(workflow.draft, id),
                "这项工作已从流程和清单中删除，具体做法保留",
              )
          : undefined
      }
      onRename={(id, name) =>
        persist(
          source.current,
          renameModuleEntries(source.current, id, name, q.data || []),
          "工作名称已更新",
        )
      }
      onAdd={(module) =>
        persist(
          workflow,
          appendModuleEntries(workflow.draft, module),
          "工作已添加，也已放进工作清单",
        )
      }
      feedback={message}
      error={error}
    />
  );
}
