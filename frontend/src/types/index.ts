export type Data = Record<string, any>;
export type Context = {
  personalMode?: boolean;
  org: string;
  role: string;
  user: Data;
  notify: (message: string) => void;
};
export type WorkflowStep = {
  id?: string;
  title: string;
  description?: string;
  materials?: string;
  safetyNotice?: string;
  imageUrl?: string;
  videoUrl?: string;
  [key: string]: unknown;
};
export type ConnectionSide = "top" | "right" | "bottom" | "left";
export type ConnectionPorts = {
  source: ConnectionSide;
  target?: ConnectionSide;
};
export type ModuleFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type WorkflowModule = {
  kind: "MODULE";
  id: string;
  title: string;
  detailId?: string;
  detailWorkflowId?: string;
  detailName?: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  frame?: ModuleFrame;
  nextModuleIds?: string[];
  connectionPorts?: Record<string, ConnectionPorts>;
  [key: string]: unknown;
};
export type InstructionItem = { id: string; text: string };
export type WorkflowDetailDocument = {
  kind: "DETAIL";
  id: string;
  title: string;
  items: InstructionItem[];
  description?: string;
  materials?: string;
  safetyNotice?: string;
  imageUrl?: string;
  videoUrl?: string;
  [key: string]: unknown;
};
export type WorkflowContent = {
  modules: WorkflowModule[];
  details: WorkflowDetailDocument[];
};
export type Workflow = {
  id: string;
  title: string;
  category: string;
  draft: string;
  revision: number;
  currentVersionId?: string;
  boardSettings?: string | null;
};
