// Owner: Agent A (extension engine). Popup: Update trigger (also opens the
// persistent monitor tab), a compact live diagnostics panel, and Copy
// diagnostics. Admin-only build - no sign-in.
import {
  formatDiagnostics,
  type BackgroundToPopup,
  type Diagnostics,
} from "@optionpilot/contracts";
import { renderDiagnostics } from "../ui/diagnosticsView";

const app = document.getElementById("app")!;
let latest: Diagnostics | null = null;

async function render(): Promise<void> {
  renderControls();
  await refreshDiagnostics();
}

function renderControls(): void {
  app.innerHTML = `
    <div class="topbar">
      <h1>OptionPilot</h1>
    </div>
    <p class="muted" style="margin:0 0 8px;font-size:11px">Tip: the popup closes when scrape windows open. Use the monitor tab to watch progress live.</p>
    <div class="row">
      <button id="update" class="primary">Update now</button>
      <button id="copy" class="ghost">Copy diagnostics</button>
      <span id="toast" class="toast"></span>
    </div>
    <div id="diag" style="margin-top:8px"></div>
  `;
  document.getElementById("update")!.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "START_UPDATE" });
    chrome.runtime.openOptionsPage(); // open/raise the persistent monitor tab
  });
  document.getElementById("copy")!.addEventListener("click", async () => {
    const text = latest ? formatDiagnostics(latest) : "No diagnostics yet.";
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied!");
    } catch {
      showToast("Copy failed - use the monitor tab.");
    }
  });
}

function showToast(t: string): void {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = t;
  setTimeout(() => { if (el.textContent === t) el.textContent = ""; }, 2500);
}

function paint(): void {
  const el = document.getElementById("diag");
  if (el && latest) renderDiagnostics(el, latest);
}

async function refreshDiagnostics(): Promise<void> {
  // PREVIEW_PLAN seeds the full symbol/source plan when idle and nothing has run
  // yet; otherwise it returns the current run state.
  const d = (await chrome.runtime.sendMessage({ type: "PREVIEW_PLAN" })) as Diagnostics | undefined;
  if (d) { latest = d; paint(); }
}

chrome.runtime.onMessage.addListener((msg: BackgroundToPopup) => {
  if (msg?.type === "DIAGNOSTICS") { latest = msg.diagnostics; paint(); }
});

// No background events fire during the stagger wait, so repaint once a second
// while a countdown is active to make the "next window in Ns" pill tick down.
setInterval(() => {
  if (latest?.countdown) paint();
}, 1000);

void render();
