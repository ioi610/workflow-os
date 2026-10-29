import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Capacitor } from "@capacitor/core";
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { LOCAL_APP } from "./localMode";
import { Join } from "./layouts/Root";
import "./style.css";
import "./theme.css";
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
const Router = LOCAL_APP ? HashRouter : BrowserRouter;
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <Router>
        <Join />
      </Router>
    </QueryClientProvider>
  </React.StrictMode>,
);
if (
  "serviceWorker" in navigator &&
  location.protocol !== "file:" &&
  !Capacitor.isNativePlatform()
)
  window.addEventListener("load", () =>
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch(() => {}),
  );
