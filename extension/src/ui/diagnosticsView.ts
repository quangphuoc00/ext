// Shared diagnostics renderer used by both the popup and the monitor tab.
import type {
  Countdown,
  Diagnostics,
  JobDiagnostic,
  JobStatus,
  RequestsIndicator,
} from "@optionpilot/contracts";

export function statusColor(s: JobStatus): string {
  switch (s) {
    case "scraped": return "#16a34a";
    case "empty": return "#d97706";
    case "error": return "#dc2626";
    case "opening":
    case "loading": return "#2563eb";
    case "pending":
    default: return "#9ca3af";
  }
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}

// Human-friendly relative time, e.g. "5s ago", "3m ago", "2h ago", "1d ago".
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour}h ago`;
  const day = Math.round(hour / 24);
  return `${day}d ago`;
}

// Short, non-technical label for each status.
function statusLabel(s: JobStatus): string {
  switch (s) {
    case "scraped": return "success";
    case "empty": return "no data";
    case "error": return "error";
    case "opening": return "opening…";
    case "loading": return "loading…";
    case "pending":
    default: return "waiting";
  }
}

function jobRow(j: JobDiagnostic): string {
  // On success show a short "what I scraped" line (e.g. record counts);
  // on error/empty show the failure note instead.
  let note = "";
  if (j.status === "empty") {
    if (j.message) note = `<div class="err">${esc(j.message)}</div>`;
  } else if (j.status === "scraped" && j.dataSummary) {
    note = `<div class="sub">${esc(j.dataSummary)}</div>`;
  }
  const count = j.scrapeCount ? ` · ${j.scrapeCount}x` : "";
  const time = j.updatedAt ? relativeTime(j.updatedAt) : "";
  return `
    <div class="job">
      <span class="dot" style="background:${statusColor(j.status)}"></span>
      <div style="flex:1">
        <div class="row" style="justify-content:space-between">
          <span class="src">${esc(j.source)}</span>
          <span class="muted" style="font-size:11px">${statusLabel(j.status)}${count}</span>
        </div>
        <div class="muted" style="font-size:11px">${time ? `last: ${time}` : ""}</div>
        ${note}
      </div>
    </div>`;
}

// Twelve clock-face glyphs (12 o'clock → 11 o'clock). The panel re-renders once
// a second during a countdown, so stepping through these by remaining seconds
// makes the clock visibly "tick" as the timer winds down — a render-safe
// animation that survives the full innerHTML repaint (a CSS keyframe would
// restart each second and look frozen).
const CLOCK_FACES = ["🕛", "🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚"];

// Live "next window opens in Ns" pill with a ticking clock. Recomputed on every
// paint (the monitor and popup tick paint() each second), so the seconds visibly
// count down and the clock hand advances.
function countdownPill(c: Countdown | undefined): string {
  if (!c) return "";
  const remainingMs = new Date(c.nextWindowAt).getTime() - Date.now();
  const secs = Math.max(0, Math.ceil(remainingMs / 1000));
  const what = c.label ? `${esc(c.label)} ` : "";
  const clock = CLOCK_FACES[secs % CLOCK_FACES.length];
  const text = secs > 0 ? `next: ${what}in ${secs}s` : `next: ${what}opening…`;
  // The spinner span carries a CSS class so it can also rotate smoothly if the
  // stylesheet defines `@keyframes spin`; the glyph swap guarantees motion
  // regardless of CSS support.
  return `<span class="pill countdown" style="border-left:3px solid #2563eb"><span class="countdown-clock">${clock}</span> ${text}</span>`;
}

// Liveness row for a Realtime request-trigger path: is the extension watching
// the table, when did it last check, and when did the last request arrive.
// Shared by scrape_requests (scrapeOrchestrator) and analysis_requests
// (analysisWorker), which have identical indicator shapes.
function requestsRow(table: string, ind: RequestsIndicator | undefined): string {
  if (!ind) return "";
  const color = ind.watching ? "#16a34a" : "#dc2626";
  const label = ind.watching ? "watching" : ind.subStatus ?? "not watching";
  const lastEvent = ind.lastEventAt
    ? `last request ${relativeTime(ind.lastEventAt)}`
    : "no request yet";
  const lastChecked = ind.lastCheckedAt ? ` · checked ${relativeTime(ind.lastCheckedAt)}` : "";
  const lastSymbol = ind.lastSymbol
    ? `<div class="muted" style="font-size:11px">last analyzed: <strong>${esc(ind.lastSymbol)}</strong></div>`
    : "";
  return `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <span class="src">
          <span class="dot" style="background:${color}"></span>${esc(table)}
        </span>
        <span class="muted" style="font-size:11px">${esc(label)}</span>
      </div>
      <div class="muted" style="font-size:11px">${esc(lastEvent)} · ${ind.received} received${lastChecked}</div>
      ${lastSymbol}
    </div>`;
}

// Renders a brief diagnostics panel into `el`: which source, its status, and
// the last update time. Raw data/debug is intentionally omitted here and lives
// only in the "Copy diagnostics" report.
export function renderDiagnostics(el: HTMLElement, d: Diagnostics): void {
  const counts = d.jobs.reduce<Record<string, number>>((a, j) => {
    a[j.status] = (a[j.status] ?? 0) + 1; return a;
  }, {});
  const summary = ["scraped", "empty", "error", "loading", "opening", "pending"]
    .filter((s) => counts[s])
    .map((s) => `<span class="pill" style="border-left:3px solid ${statusColor(s as JobStatus)}">${s}: ${counts[s]}</span>`)
    .join("");

  const groups = new Map<string, JobDiagnostic[]>();
  for (const j of d.jobs) {
    const key = j.symbol ?? "MACRO";
    groups.set(key, [...(groups.get(key) ?? []), j]);
  }
  const orderedKeys = [...groups.keys()].sort((a, b) =>
    a === "MACRO" ? 1 : b === "MACRO" ? -1 : a.localeCompare(b),
  );

  const groupHtml = orderedKeys
    .map((k) => `
      <div class="card">
        <div class="group-title">${esc(k)}</div>
        ${groups.get(k)!.map((j) => jobRow(j)).join("")}
      </div>`)
    .join("");

  const errorsHtml = d.errors.length
    ? `<div class="card"><div class="group-title">Errors (${d.errors.length})</div>${d.errors
        .map((e) => `<div class="err">${esc(e.where)}: ${esc(e.message)}</div>`)
        .join("")}</div>`
    : "";

  const started = d.startedAt ? new Date(d.startedAt).toLocaleTimeString() : "-";
  el.innerHTML = `
    <div class="summary-bar">
      <span class="pill">${d.running ? "RUNNING" : "idle"}</span>
      <span class="pill">started ${started}</span>
      ${countdownPill(d.countdown)}
      ${summary}
    </div>
    ${requestsRow("scrape_requests", d.scrapeRequests)}
    ${requestsRow("analysis_requests", d.analysisRequests)}
    ${d.jobs.length === 0 ? '<p class="muted">No run yet. Click "Update now".</p>' : ""}
    <div class="scroll">${groupHtml}${errorsHtml}</div>
  `;
}
