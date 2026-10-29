import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { api, configurePersonalMode } from "../api";
import type { Data } from "../types";
import { App } from "./App";

export function Join() {
  const mode = useQuery<{ personalMode: boolean }>({
    queryKey: ["app-mode"],
    queryFn: async () => {
      const result = await api<{ personalMode: boolean }>("/mode");
      configurePersonalMode(result.personalMode);
      return result;
    },
    staleTime: Infinity,
  });
  if (mode.isPending) return <div className="loading">正在打开工作页面…</div>;
  if (mode.isError)
    return (
      <div className="startup-error">
        <h1>工作页面暂时打不开</h1>
        <p>{mode.error.message}</p>
        <button className="btn" onClick={() => mode.refetch()}>
          重新打开
        </button>
      </div>
    );
  configurePersonalMode(mode.data.personalMode);
  return mode.data.personalMode ? <PersonalEntry /> : <AuthenticatedEntry />;
}
function PersonalEntry() {
  const bootstrap = useQuery<Data>({
    queryKey: ["personal-workspace"],
    queryFn: async () => {
      const hint = localStorage.getItem("org");
      const result = await api<Data>(
        "/personal/bootstrap",
        hint && /^[0-9a-f-]{36}$/i.test(hint) ? { organizationId: hint } : {},
      );
      const selected =
        result.organizations.find(
          (organization: Data) => organization.id === hint,
        )?.id || result.defaultOrganizationId;
      if (selected) localStorage.setItem("org", selected);
      return result;
    },
    staleTime: Infinity,
  });
  if (bootstrap.isPending)
    return <div className="loading">正在打开工作页面…</div>;
  if (bootstrap.isError)
    return (
      <div className="startup-error">
        <h1>工作页面暂时打不开</h1>
        <p>{bootstrap.error.message}</p>
        <button className="btn" onClick={() => bootstrap.refetch()}>
          重新打开
        </button>
      </div>
    );
  return <App personalMode initialSession={bootstrap.data} />;
}
function AuthenticatedEntry() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api("/auth/me") });
  const joining = React.useRef(false);
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const [message, setMessage] = useState("");
  React.useEffect(() => {
    if (!params.has("join") || !me.data || joining.current) return;
    joining.current = true;
    api(`/orgs/${params.get("join")}/invitations/accept`, {
      token: params.get("token"),
    })
      .then(() => {
        localStorage.setItem("org", params.get("join")!);
        history.replaceState(null, "", "/");
        qc.invalidateQueries();
        window.location.reload();
      })
      .catch((error) => setMessage("接受邀请：" + error.message));
  }, [me.data]);
  return (
    <>
      {message && <div className="join-notice">{message}</div>}
      <App />
    </>
  );
}
