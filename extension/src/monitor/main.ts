// Owner: Agent A (extension engine). Persistent monitor tab: stays open while
// scrape windows come and go, shows live per-source diagnostics (with inline
// scraped JSON), and offers Update + Copy diagnostics.
import {
  formatDiagnostics,
  type BackgroundToPopup,
  type Diagnostics,
} from "@optionpilot/contracts";
import { renderDiagnostics } from "../ui/diagnosticsView";

const app = document.getElementById("app")!;
let latest: Diagnostics | null = null;

function shell(): void {
  app.innerHTML = `
    <div class="topbar">
      <h1>OptionPilot Monitor</h1>
    </div>
    <div class="row">
      <button id="update" class="primary">Update now</button>
      <button id="copy">Copy diagnostics</button>
      <span id="toast" class="toast"></span>
    </div>
    <div id="diag" style="margin-top:14px"></div>
  `;
  document.getElementById("update")!.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "START_UPDATE" });
  });
  document.getElementById("copy")!.addEventListener("click", async () => {
    const text = latest ? formatDiagnostics(latest) : "No diagnostics yet.";
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied!");
    } catch {
      toast("Copy failed - select the text below.");
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "width:100%;height:200px;margin-top:8px;font-size:11px";
      document.getElementById("diag")!.prepend(ta);
      ta.select();
    }
  });
}

function toast(t: string): void {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = t;
  setTimeout(() => { if (el.textContent === t) el.textContent = ""; }, 2500);
}

function paint(): void {
  const el = document.getElementById("diag");
  if (el && latest) renderDiagnostics(el, latest);
}

async function init(): Promise<void> {
  shell();
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

void init();
