// FROZEN (Phase 0). Generic data-source content script: waits for a SCRAPE
// message from the background, runs the matching parser against the live DOM,
// and replies with the ScrapeWrite (or null/error).
import type {
  BackgroundToContent,
  ContentToBackground,
} from "@optionpilot/contracts";
import { getParser, REGISTRY } from "./registry";
import { collectDebug } from "./debug";

void REGISTRY; // ensure all parser modules are bundled into this content script

chrome.runtime.onMessage.addListener(
  (msg: BackgroundToContent, _sender, sendResponse) => {
    if (msg?.type !== "SCRAPE") return;
    // Always capture a raw DOM probe so a copied diagnostics report is enough
    // to debug selectors (even when the parse "succeeds" with a wrong value).
    let debug: Record<string, unknown> | null = null;
    try {
      debug = collectDebug(msg.source, document);
    } catch {
      debug = null;
    }
    try {
      const parser = getParser(msg.source);
      const write = parser(document, { symbol: msg.symbol });
      const res: ContentToBackground = { type: "SCRAPE_RESULT", write, debug };
      sendResponse(res);
    } catch (e) {
      const res: ContentToBackground = {
        type: "SCRAPE_ERROR",
        error: e instanceof Error ? e.message : String(e),
        debug,
      };
      sendResponse(res);
    }
    return true; // keep the message channel open for the async response
  },
);
