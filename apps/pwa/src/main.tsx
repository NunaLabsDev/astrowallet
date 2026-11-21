import { Buffer } from "buffer";
import "./styles/tokens.css";
import "./styles/glass.css";

// Install Node-compat globals before dynamically importing App / @ton/* / @stellar/*
// so ESM import hoisting can never evaluate vendor chunks ahead of Buffer.
const g = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
};
if (typeof g.Buffer === "undefined") {
  g.Buffer = Buffer;
}
if (typeof g.global === "undefined") {
  g.global = globalThis;
}

function renderBootFallback(err: unknown): void {
  const root = document.getElementById("root");
  if (!root) return;

  const message = err instanceof Error ? err.message : "Failed to initialize Mini App runtime.";

  const main = document.createElement("main");
  main.className = "glass-canvas";

  const shell = document.createElement("div");
  shell.className = "aw-shell";

  const card = document.createElement("section");
  card.className = "glass-sheet glass-card--vault aw-onboarding-card";
  card.setAttribute("role", "alert");

  const title = document.createElement("h1");
  title.className = "aw-step-title";
  title.textContent = "AstroWallet Startup Recovery";

  const detail = document.createElement("div");
  detail.className = "aw-banner aw-banner--danger";
  detail.textContent = message;

  const reloadBtn = document.createElement("button");
  reloadBtn.type = "button";
  reloadBtn.className = "aw-btn-primary";
  reloadBtn.textContent = "Reload AstroWallet";
  reloadBtn.addEventListener("click", () => window.location.reload());

  card.append(title, detail, reloadBtn);
  shell.appendChild(card);
  main.appendChild(shell);
  root.replaceChildren(main);
}

void import("./bootstrap.js").catch(renderBootFallback);
