// Owner: Analysis agent. Runs on https://claude.ai/*. Receives a RUN_CLAUDE
// message with the prompt, types it into the ProseMirror composer, submits,
// waits for the assistant response to finish streaming, scrapes the final
// assistant message as plain text, and replies with CLAUDE_RESULT/CLAUDE_ERROR.
//
// PHASE 2 NOTE: every DOM hook claude.ai depends on is centralized in SELECTORS
// below. These are best-guess selectors for the current claude.ai DOM and MUST
// be verified live in Phase 2 (open claude.ai, inspect the composer, send
// button, assistant message container, and the streaming/Stop indicator, then
// update the constants). Nothing else in this file should need to change.
import type {
  BackgroundToContent,
  ContentToBackground,
} from "@optionpilot/contracts";
import { serializeWithCodeFences } from "./claudeSerialize";

// --- Selectors to verify live in Phase 2 ------------------------------------
const SELECTORS = {
  // Composer: claude.ai uses a contenteditable ProseMirror editor.
  composer: 'div.ProseMirror[contenteditable="true"], div[contenteditable="true"].ProseMirror, div[contenteditable="true"]',
  // Send button: an enabled button near the composer. aria-label is the most
  // stable hook; the type=submit / fallbacks cover label drift.
  sendButton:
    'button[aria-label="Send message"], button[aria-label*="Send" i], button[data-testid="send-button"], button[type="submit"]',
  // Streaming indicator: while generating, claude.ai shows a Stop button.
  stopButton:
    'button[aria-label="Stop response"], button[aria-label*="Stop" i], button[data-testid="stop-button"]',
  // Assistant message container: the rendered model reply blocks. Multiple
  // candidates because claude.ai has changed this between releases.
  assistantMessage:
    'div[data-testid="assistant-message"], div.font-claude-message, [data-message-author-role="assistant"], div.font-claude-response',
} as const;

// --- Timing knobs ------------------------------------------------------------
const COMPOSER_TIMEOUT_MS = 30_000;
const SEND_ENABLE_TIMEOUT_MS = 5_000;
const RESPONSE_START_TIMEOUT_MS = 20_000;
// Kept under the background's 180s budget so we report a clean timeout first.
const RESPONSE_TIMEOUT_MS = 165_000;
// The reply must be unchanged and not streaming for this long to count as done.
const STABLE_MS = 1_500;
const POLL_MS = 400;

chrome.runtime.onMessage.addListener(
  (msg: BackgroundToContent, _sender, _sendResponse) => {
    if (msg?.type !== "RUN_CLAUDE") return false;
    // Fire-and-forget: the long-running automation replies via a separate
    // runtime.sendMessage, so we do not keep this message channel open.
    void handleRunClaude(msg.prompt);
    return false;
  },
);

async function handleRunClaude(prompt: string): Promise<void> {
  try {
    const composer = await waitForElement<HTMLElement>(
      SELECTORS.composer,
      COMPOSER_TIMEOUT_MS,
    );
    setComposerText(composer, prompt);
    await submitPrompt(composer);
    await waitForResponseStart();
    await waitForResponseComplete();
    const text = readLastAssistantText();
    if (!text) throw new Error("Empty assistant response from claude.ai");
    reply({ type: "CLAUDE_RESULT", text });
  } catch (e) {
    // The listener must never throw: always surface a CLAUDE_ERROR instead.
    reply({
      type: "CLAUDE_ERROR",
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function reply(msg: ContentToBackground): void {
  try {
    void chrome.runtime.sendMessage(msg);
  } catch {
    // Background/service worker may be gone; nothing else we can do.
  }
}

// --- Composer handling -------------------------------------------------------

// Sets the prompt as plain text in the contenteditable ProseMirror editor.
// execCommand("insertText") is preferred because it routes through
// ProseMirror's own beforeinput/input handling, keeping its internal state in
// sync; a manual textContent assignment is the fallback.
function setComposerText(el: HTMLElement, text: string): void {
  el.focus();
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.addRange(range);
  }
  const inserted = document.execCommand("insertText", false, text);
  if (!inserted) {
    el.textContent = text;
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text,
      }),
    );
  }
}

// Clicks the send button once it is enabled; falls back to pressing Enter in
// the composer (claude.ai submits on Enter when the composer has focus).
async function submitPrompt(composer: HTMLElement): Promise<void> {
  const deadline = Date.now() + SEND_ENABLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const btn = findSendButton();
    if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
      btn.click();
      return;
    }
    await delay(150);
  }
  pressEnter(composer);
}

function findSendButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(SELECTORS.sendButton);
}

function pressEnter(el: HTMLElement): void {
  const init: KeyboardEventInit = {
    bubbles: true,
    cancelable: true,
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
  } as KeyboardEventInit;
  el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keypress", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
}

// --- Response detection ------------------------------------------------------

function isStreaming(): boolean {
  return document.querySelector(SELECTORS.stopButton) !== null;
}

function countAssistantMessages(): number {
  return document.querySelectorAll(SELECTORS.assistantMessage).length;
}

function readLastAssistantText(): string {
  const nodes = document.querySelectorAll<HTMLElement>(SELECTORS.assistantMessage);
  const last = nodes[nodes.length - 1];
  if (!last) return "";
  return serializeWithCodeFences(last);
}

// Resolves once generation appears to have started (Stop indicator visible or a
// new assistant message appeared); resolves on timeout regardless, since the
// completion watcher is the real gate.
function waitForResponseStart(): Promise<void> {
  return new Promise<void>((resolve) => {
    const baseline = countAssistantMessages();
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearInterval(interval);
      clearTimeout(timer);
      resolve();
    };
    const check = (): void => {
      if (isStreaming() || countAssistantMessages() > baseline) finish();
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const interval = setInterval(check, POLL_MS);
    const timer = setTimeout(finish, RESPONSE_START_TIMEOUT_MS);
    check();
  });
}

// Resolves once the assistant is no longer streaming AND the last message text
// has been stable for STABLE_MS. Rejects only if the overall timeout elapses
// with no captured text.
function waitForResponseComplete(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let lastText = "";
    let stableSince = Date.now();
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearInterval(interval);
      clearTimeout(timer);
      fn();
    };
    const check = (): void => {
      if (settled) return;
      if (isStreaming()) {
        stableSince = Date.now();
        return;
      }
      const text = readLastAssistantText();
      if (text !== lastText) {
        lastText = text;
        stableSince = Date.now();
        return;
      }
      if (text.length > 0 && Date.now() - stableSince >= STABLE_MS) {
        finish(resolve);
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const interval = setInterval(check, POLL_MS);
    const timer = setTimeout(() => {
      if (readLastAssistantText().length > 0) {
        finish(resolve);
      } else {
        finish(() =>
          reject(new Error("Timed out waiting for claude.ai response to finish")),
        );
      }
    }, RESPONSE_TIMEOUT_MS);
    check();
  });
}

// --- Generic helpers ---------------------------------------------------------

function waitForElement<T extends Element>(
  selector: string,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const existing = document.querySelector<T>(selector);
    if (existing) {
      resolve(existing);
      return;
    }
    const observer = new MutationObserver(() => {
      const el = document.querySelector<T>(selector);
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timed out waiting for element: ${selector}`));
    }, timeoutMs);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
