import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, X } from "lucide-react";
import { useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api } from "../api";
import { Button } from "../components/ui";
import { Auth } from "../features/auth/Auth";
import { Sops } from "../features/sop/Sops";
import { ModuleInstructions } from "../features/sop/ModuleInstructions";
import { WorkflowDetail } from "../features/sop/WorkflowDetail";
import { WorkflowEditor } from "../features/sop/WorkflowEditor";
import { CompleteWorkflow } from "../features/sop/CompleteWorkflow";
import type { Context, Data } from "../types/index";

export function App({
  personalMode = false,
  initialSession,
}: {
  personalMode?: boolean;
  initialSession?: Data;
}) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState(localStorage.getItem("org") || "");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [setupError, setSetupError] = useState("");
  const me = useQuery<Data>({
    queryKey: ["me"],
    queryFn: () => api("/auth/me"),
    initialData: initialSession,
  });
  const selectedOrg =
    me.data?.organizations?.find((o: Data) => o.id === choice) ||
    me.data?.organizations?.[0];
  const org = selectedOrg?.id || "";
  function notify(message: string) {
    setMsg(message);
  }
  if (me.isPending) return <div className="loading">正在打开工作页面…</div>;
  if (!me.data)
    return personalMode ? (
      <div className="startup-error">
        <h1>工作页面暂时打不开</h1>
        <p>{me.error?.message}</p>
        <button className="btn" onClick={() => me.refetch()}>
          重试
        </button>
      </div>
    ) : (
      <Auth onDone={() => qc.invalidateQueries()} />
    );
  const role =
    me.data.memberships.find((m: Data) => m.organizationId === org)?.role ||
    "EMPLOYEE";
  const ctx: Context = { org, role, user: me.data.user, notify, personalMode };

  async function setup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setSetupError("");
    const name = new FormData(e.currentTarget).get("name");
    try {
      const result = await api("/organizations", { name });
      setChoice(result.id);
      localStorage.setItem("org", result.id);
      await qc.invalidateQueries();
    } catch (error) {
      setSetupError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="app handbook-app">
        {!org ? (
          <main>
            <div className="page-title">
              <div>
                <h1>先给这里起个名字</h1>
              </div>
            </div>
            <form className="panel setup" onSubmit={setup}>
              <label>
                名称
                <input
                  name="name"
                  required
                  maxLength={100}
                  placeholder="例如：我的工作、店里的事"
                />
              </label>
              {setupError && (
                <p role="alert" className="error">
                  {setupError}
                </p>
              )}
              <Button type="submit" disabled={busy}>
                {busy ? "正在创建…" : "开始使用"}
                <ArrowRight size={16} />
              </Button>
            </form>
          </main>
        ) : (
          <Routes>
            <Route
              path="/"
              element={
                <Sops
                  {...ctx}
                  key={org}
                  workspaceSelector={
                    me.data.organizations.length > 1 ? (
                      <select
                        className="workspace-switcher"
                        aria-label="切换工作内容"
                        value={org}
                        onChange={(e) => {
                          setChoice(e.target.value);
                          localStorage.setItem("org", e.target.value);
                        }}
                      >
                        {me.data.organizations.map((o: Data) => (
                          <option value={o.id} key={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    ) : undefined
                  }
                />
              }
            />
            <Route path="/manager" element={<Navigate to="/" replace />} />
            <Route
              path="/workflows/new"
              element={<WorkflowEditor {...ctx} key={org + "-new"} />}
            />
            <Route
              path="/workflows/:id/edit"
              element={<WorkflowEditor {...ctx} key={org} />}
            />
            <Route
              path="/workflows/:id/steps"
              element={<ModuleInstructions {...ctx} key={org} />}
            />
            <Route
              path="/workflows/:id/complete"
              element={<CompleteWorkflow {...ctx} key={org} />}
            />
            <Route
              path="/workflows/:id"
              element={<WorkflowDetail {...ctx} key={org} />}
            />
            <Route path="/me" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </div>
      {msg && (
        <div role="status" className="toast">
          {msg}
          <button aria-label="关闭提示" onClick={() => setMsg("")}>
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}
