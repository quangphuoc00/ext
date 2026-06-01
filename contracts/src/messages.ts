// Frozen extension-internal messaging contract (popup <-> background <-> content scripts).

import type { ScrapeWrite, SourceId } from "./scraper";
import type { Diagnostics } from "./diagnostics";

export interface ScrapeProgress {
  running: boolean;
  total: number;
  completed: number;
  openTabs: number;
  current?: string; // human-readable, e.g. "AAPL optioncharts"
  lastError?: string;
}

// popup -> background
export type PopupToBackground =
  | { type: "START_UPDATE" }
  | { type: "STOP_UPDATE" }
  | { type: "GET_PROGRESS" }
  | { type: "GET_DIAGNOSTICS" }
  | { type: "PREVIEW_PLAN" };

// background -> popup (responses / pushes)
export type BackgroundToPopup =
  | { type: "PROGRESS"; progress: ScrapeProgress }
  | { type: "DIAGNOSTICS"; diagnostics: Diagnostics };

// background -> content script
export type BackgroundToContent =
  | { type: "SCRAPE"; source: SourceId; symbol?: string } // -> data-source tab
  | { type: "RUN_CLAUDE"; prompt: string }; // -> claude.ai tab

// content script -> background. `debug` is a raw per-source DOM probe captured
// alongside the parse so a copied diagnostics report is enough to fix selectors.
export type ContentToBackground =
  | { type: "SCRAPE_RESULT"; write: ScrapeWrite | null; debug?: Record<string, unknown> | null }
  | { type: "SCRAPE_ERROR"; error: string; debug?: Record<string, unknown> | null }
  | { type: "CLAUDE_RESULT"; text: string }
  | { type: "CLAUDE_ERROR"; error: string };

export type ExtMessage =
  | PopupToBackground
  | BackgroundToPopup
  | BackgroundToContent
  | ContentToBackground;
