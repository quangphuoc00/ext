// Manages a single persistent claude.ai tab. Opened early (at scrape-start)
// so it is warm by the time analysis requests arrive. Subsequent analyses
// reuse the tab WITHOUT navigating it — each prompt is appended to whatever
// claude.ai conversation is currently open. This avoids the per-analysis
// page reload (and its 5-10s warm-up cost) that the old `acquireClaudeTab`
// paid by sending the tab back to /new every time. A navigation only happens
// when (a) we don't have a tab yet, or (b) the user drove the tab off
// claude.ai entirely, in which case we recover by reopening /new.
//
// The tab lives in the orchestrator's dedicated background scrape window so
// users don't get a stray claude.ai tab dropped into whatever window they're
// using. The target window id is plumbed in by the orchestrator once that
// window exists; `acquireClaudeTab` reuses the most recently provided id.

const CLAUDE_NEW_URL = "https://claude.ai/new";

let claudeTabId: number | undefined;
let targetWindowId: number | undefined;

// Keep the stored ID in sync when the user closes the tab externally.
chrome.tabs.onRemoved.addListener((id) => {
  if (id === claudeTabId) claudeTabId = undefined;
});

// Move an existing tab into the target window if it ended up somewhere else
// (e.g. from a previous run before windowId plumbing existed, or because the
// previous scrape window has since closed and the tab survived).
async function ensureInTargetWindow(tabId: number): Promise<void> {
  if (targetWindowId == null) return;
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.windowId === targetWindowId) return;
    await chrome.tabs.move(tabId, { windowId: targetWindowId, index: -1 });
  } catch {
    // tab is gone or the target window no longer exists; let the next
    // acquire/open path recreate things from scratch.
  }
}

function createOptions(): chrome.tabs.CreateProperties {
  return targetWindowId != null
    ? { url: CLAUDE_NEW_URL, active: false, windowId: targetWindowId }
    : { url: CLAUDE_NEW_URL, active: false };
}

// Open a claude.ai/new tab in the background if one is not already tracked,
// and return its id. Intended to be called once the scrape window exists so
// the tab is placed alongside the rest of the scrape tabs (not dropped into
// the user's currently focused window).
export async function openClaudeTab(windowId?: number): Promise<number> {
  if (windowId != null) targetWindowId = windowId;
  if (claudeTabId != null) {
    try {
      await chrome.tabs.get(claudeTabId);
      await ensureInTargetWindow(claudeTabId);
      return claudeTabId;
    } catch {
      claudeTabId = undefined;
    }
  }
  const tab = await chrome.tabs.create(createOptions());
  if (tab.id == null) throw new Error("Failed to open claude.ai tab (no tab id)");
  claudeTabId = tab.id;
  return claudeTabId;
}

// Return the persistent claude.ai tab id, reusing the existing tab in place
// rather than reloading it. New analyses are appended as additional turns to
// whatever conversation the tab is currently on, so we don't pay for a full
// page load (~5-10s on claude.ai) on every request.
//
// We only navigate in two recovery cases:
//   1. The tracked tab no longer exists (user closed it) -> create a fresh
//      tab on /new and wait for it to load before returning.
//   2. The tab is still open but the user has driven it off claude.ai
//      entirely -> send it back to /new so RUN_CLAUDE doesn't get delivered
//      to an unrelated site.
export async function acquireClaudeTab(): Promise<number> {
  if (claudeTabId != null) {
    try {
      const existing = await chrome.tabs.get(claudeTabId);
      await ensureInTargetWindow(claudeTabId);
      if (!isClaudeUrl(existing.url)) {
        // Tab drifted off claude.ai; recover by reopening a fresh conversation
        // in the same tab. This is the only case where we reload.
        await navigateAndWait(claudeTabId, CLAUDE_NEW_URL);
      }
      return claudeTabId;
    } catch {
      claudeTabId = undefined;
    }
  }
  const tab = await chrome.tabs.create(createOptions());
  if (tab.id == null) throw new Error("Failed to open claude.ai tab (no tab id)");
  claudeTabId = tab.id;
  await waitForTabLoaded(claudeTabId);
  return claudeTabId;
}

function isClaudeUrl(url: string | undefined): boolean {
  return url != null && url.startsWith("https://claude.ai/");
}

function navigateAndWait(tabId: number, url: string, timeoutMs = 25_000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch(finish);
    setTimeout(finish, timeoutMs);
  });
}

function waitForTabLoaded(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    void chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") finish();
    }).catch(finish);
    setTimeout(finish, timeoutMs);
  });
}
