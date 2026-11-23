import { Suspense, StrictMode, lazy } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary.js";

const App = lazy(() => import("./App.js").then((m) => ({ default: m.App })));
const PublicStatsPage = lazy(() =>
  import("./components/PublicStatsPage.js").then((m) => ({ default: m.PublicStatsPage })),
);

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root mount element #root not found");
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

const searchParams = new URLSearchParams(window.location.search);
const tgStartParam = (
  window as {
    Telegram?: { WebApp?: { initDataUnsafe?: { start_param?: string } } };
  }
).Telegram?.WebApp?.initDataUnsafe?.start_param;
const isPublicStatsRoute =
  window.location.pathname === "/stats" ||
  window.location.pathname === "/stats/" ||
  searchParams.get("view") === "stats" ||
  tgStartParam === "stats";

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <Suspense fallback={null}>
        {isPublicStatsRoute ? <PublicStatsPage /> : <App />}
      </Suspense>
    </ErrorBoundary>
  </StrictMode>,
);
