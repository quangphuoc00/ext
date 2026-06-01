// L8 - Pure-logic unit tests: verdict parsing, write serialization/summary, and
// the diagnostics copy blob. No browser/extension runtime.
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { formatDiagnostics, type Diagnostics, type ScrapeWrite } from "@optionpilot/contracts";
import { parseVerdict } from "../src/background/verdict";
import { serializeWithCodeFences } from "../src/content/claudeSerialize";
import { serializeWrite, summarizeWrite } from "../src/background/scrapeCore";
import { renderDiagnostics } from "../src/ui/diagnosticsView";

const VALID = [
  "Here is my analysis.",
  "```json",
  '{"verdict":"PASS","score_pass":8,"score_total":10,"recommended_strike":200,"recommended_expiry":"2026-07-17","why":"calm","decision":"Sell 200P","unknowns":["catalyst"]}',
  "```",
].join("\n");

describe("parseVerdict", () => {
  it("parses a valid fenced json verdict", () => {
    const v = parseVerdict(VALID);
    expect(v.verdict).toBe("PASS");
    expect(v.score_pass).toBe(8);
    expect(v.score_total).toBe(10);
    expect(v.recommended_strike).toBe(200);
    expect(v.recommended_expiry).toBe("2026-07-17");
    expect(v.decision).toBe("Sell 200P");
    expect(v.unknowns).toEqual(["catalyst"]);
  });

  it("uses the LAST json block when multiple are present", () => {
    const text = '```json\n{"verdict":"PASS"}\n```\nthen\n```json\n{"verdict":"FAIL"}\n```';
    expect(parseVerdict(text).verdict).toBe("FAIL");
  });

  it("throws when no json block exists", () => {
    expect(() => parseVerdict("no json here")).toThrow(/no .*json verdict block/i);
  });

  it("throws on malformed json", () => {
    expect(() => parseVerdict("```json\n{verdict: PASS,,,}\n```")).toThrow(/parse verdict json/i);
  });

  it("coerces unknown/missing keys to null/empty without throwing", () => {
    const v = parseVerdict('```json\n{"verdict":"MAYBE","score_pass":"7"}\n```');
    expect(v.verdict).toBeNull(); // not PASS/FAIL
    expect(v.score_pass).toBe(7); // numeric string coerced
    expect(v.why).toBeNull();
    expect(v.unknowns).toEqual([]);
  });
});

describe("serializeWithCodeFences", () => {
  function makeEl(html: string): HTMLElement {
    return new JSDOM(`<!DOCTYPE html><div id="root">${html}</div>`).window.document.getElementById("root") as HTMLElement;
  }

  it("`should reconstruct fenced json block from rendered <pre><code> — full roundtrip with parseVerdict`", () => {
    // Simulates how claude.ai renders a ```json ... ``` block in the DOM:
    // the fences become a <pre><code class="language-json"> element.
    const verdictJson = `{"verdict":"PASS","score_pass":8,"score_total":10,"recommended_strike":200,"recommended_expiry":"2026-07-17","why":"calm","decision":"Sell 200P","unknowns":[]}`;
    const el = makeEl(
      `<p>Here is the verdict.</p><pre><code class="language-json">${verdictJson}</code></pre>`,
    );
    const text = serializeWithCodeFences(el);
    expect(text).toContain("```json");
    expect(text).toContain(verdictJson);
    // The extracted text must survive parseVerdict without throwing.
    const v = parseVerdict(text);
    expect(v.verdict).toBe("PASS");
    expect(v.score_pass).toBe(8);
  });

  it("`should return plain text when there are no code blocks`", () => {
    const el = makeEl("<p>Hello world</p>");
    expect(serializeWithCodeFences(el).trim()).toBe("Hello world");
  });

  it("`should use empty language tag when code element has no language class`", () => {
    const el = makeEl("<pre><code>{\"key\":\"value\"}</code></pre>");
    const text = serializeWithCodeFences(el);
    expect(text).toContain("```\n");
    expect(text).toContain("{\"key\":\"value\"}");
  });
});

describe("serializeWrite / summarizeWrite", () => {
  const finviz: ScrapeWrite = { kind: "stock_json", symbol: "AAPL", column: "finviz", data: { price: 312.06, rsi14: 55 } };
  const macro: ScrapeWrite = { kind: "macro", metric: "vix", value: 15.32 };
  const opts: ScrapeWrite = {
    kind: "stock_json",
    symbol: "AAPL",
    column: "yahoo_options",
    data: { price: 312, expirations: [{ expiry: "2026-07-17", puts: [{ strike: 200 }] }] },
  };

  it("serializes equal writes identically and unequal writes differently", () => {
    const a: ScrapeWrite = { kind: "macro", metric: "vix", value: 15.32 };
    expect(serializeWrite(a)).toBe(serializeWrite(macro));
    expect(serializeWrite({ kind: "macro", metric: "vix", value: 16 })).not.toBe(serializeWrite(macro));
    expect(serializeWrite(null)).toBe("");
  });

  it("summarizes each write kind in a human-readable way", () => {
    expect(summarizeWrite(finviz)).toMatch(/price=312\.06/);
    expect(summarizeWrite(macro)).toMatch(/vix = 15\.32/);
    expect(summarizeWrite(opts)).toMatch(/expiration/);
    // optioncharts: greeks chain is paywalled on the free tier — summary must
    // say "greeks paywalled" instead of "0 greek records" so a future copy
    // blob doesn't look like a silent parser bug.
    const ocPaywalled: ScrapeWrite = {
      kind: "stock_json",
      symbol: "AAPL",
      column: "optioncharts",
      data: { ivRank: 28.5, ivPercentile: 50, iv30d: 0.3, expectedMove: null, putCallRatio: 0.7, greeks: [], greeksPaywalled: true },
    };
    expect(summarizeWrite(ocPaywalled)).toMatch(/greeks paywalled/);
    expect(summarizeWrite(ocPaywalled)).toMatch(/ivRank=28\.5%/);
    // When the chain isn't paywalled, fall back to the historical "N greek records" shape.
    const ocOpen: ScrapeWrite = {
      kind: "stock_json",
      symbol: "AAPL",
      column: "optioncharts",
      data: { ivRank: 30, ivPercentile: null, iv30d: 0.3, expectedMove: null, putCallRatio: null, greeks: [{ strike: 200, delta: -0.3 }] },
    };
    expect(summarizeWrite(ocOpen)).toMatch(/1 greek records/);
  });
});

describe("formatDiagnostics", () => {
  it("includes settings, per-job summaries, and errors in the copy blob", () => {
    const d: Diagnostics = {
      running: false,
      extensionVersion: "0.1.0",
      settings: { staggerDelayMs: 15000, pollIntervalMs: 60000, stableCloseCount: 10 },
      jobs: [
        // Regular scraped finviz job: dataSummary only, no debug dump.
        {
          key: "finviz:AAPL",
          source: "finviz",
          symbol: "AAPL",
          url: "https://finviz.com/quote.ashx?t=AAPL",
          status: "scraped",
          dataSummary: "price=312.06",
          debug: { hiddenProbe: "should_not_appear_for_finviz" },
        },
        { key: "optioncharts:AAPL", source: "optioncharts", symbol: "AAPL", url: "https://optioncharts.io/options/AAPL", status: "error", message: "selector miss" },
        // Optioncharts "scraped" with 0 greek records — silent data-quality
        // miss; debug MUST surface so the DOM is in the copy blob.
        {
          key: "optioncharts:META",
          source: "optioncharts",
          symbol: "META",
          url: "https://optioncharts.io/options/META",
          status: "scraped",
          dataSummary: "0 greek records",
          debug: { optioncharts_zero_probe: "meta_dom_shape" },
        },
        // Generic "0 X records" pattern on any source should also surface the
        // probe (e.g. a future yahoo_options miss).
        {
          key: "yahoo_options:NVDA",
          source: "yahoo_options",
          symbol: "NVDA",
          url: "https://ca.finance.yahoo.com/quote/NVDA/options/",
          status: "scraped",
          dataSummary: "0 expirations, 0 records",
          debug: { zero_records_probe: "nvda_dom_shape" },
        },
      ],
      errors: [{ when: "2026-05-31T00:00:00Z", where: "AAPL optioncharts", message: "boom" }],
      scrapeRequests: { watching: true, subStatus: "SUBSCRIBED", received: 2, lastRequestId: "req-7" },
      analysisRequests: { watching: false, subStatus: "CHANNEL_ERROR", received: 1, lastRequestId: "an-9" },
    };
    const out = formatDiagnostics(d);
    expect(out).toMatch(/settings: stagger=15000ms poll=60000ms stableClose=10/);
    expect(out).toMatch(/price=312\.06/);
    expect(out).toMatch(/AAPL optioncharts: boom/);
    expect(out).toMatch(/\[ERROR\] AAPL \/ optioncharts/);
    expect(out).toMatch(/scrape_requests: watching=true status=SUBSCRIBED received=2/);
    expect(out).toMatch(/req-7/);
    expect(out).toMatch(/analysis_requests: watching=false status=CHANNEL_ERROR received=1/);
    expect(out).toMatch(/an-9/);
    // Regular scraped finviz row keeps just the summary — its probe is hidden.
    expect(out).not.toMatch(/should_not_appear_for_finviz/);
    // Optioncharts is always surfaced (cash-secured-put tool depends on greeks);
    // any "0 X records" summary surfaces on any source.
    expect(out).toMatch(/meta_dom_shape/);
    expect(out).toMatch(/nvda_dom_shape/);
  });
});

describe("renderDiagnostics request indicators", () => {
  function render(d: Diagnostics): string {
    const el = new JSDOM("<!DOCTYPE html><div id='diag'></div>").window.document.getElementById("diag")!;
    renderDiagnostics(el as unknown as HTMLElement, d);
    return el.innerHTML;
  }

  it("`should show watching state when the subscription is live`", () => {
    const html = render({
      running: false,
      jobs: [],
      errors: [],
      scrapeRequests: { watching: true, subStatus: "SUBSCRIBED", received: 3, lastEventAt: new Date().toISOString(), lastRequestId: "req-1" },
      analysisRequests: { watching: true, subStatus: "SUBSCRIBED", received: 5, lastEventAt: new Date().toISOString(), lastRequestId: "an-1" },
    });
    expect(html).toContain("scrape_requests");
    expect(html).toContain("watching");
    expect(html).toContain("3 received");
    expect(html).toContain("#16a34a"); // green dot when watching
    // The analysis_requests indicator renders independently with its own count.
    expect(html).toContain("analysis_requests");
    expect(html).toContain("5 received");
  });

  it("`should show not-watching state when the subscription is not connected`", () => {
    const html = render({
      running: false,
      jobs: [],
      errors: [],
      scrapeRequests: { watching: false, subStatus: "CHANNEL_ERROR", received: 0 },
      analysisRequests: { watching: false, subStatus: "TIMED_OUT", received: 0 },
    });
    expect(html).toContain("scrape_requests");
    expect(html).toContain("CHANNEL_ERROR");
    expect(html).toContain("no request yet");
    expect(html).toContain("#dc2626"); // red dot when not watching
    // analysis_requests surfaces its own failure status separately.
    expect(html).toContain("analysis_requests");
    expect(html).toContain("TIMED_OUT");
  });
});
