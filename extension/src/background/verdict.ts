// Pure verdict parsing for the claude.ai analysis response. Kept free of any
// chrome/runtime dependency so it can be unit-tested directly.
import type { Verdict } from "@optionpilot/contracts";

export interface ParsedVerdict {
  verdict: Verdict | null;
  score_pass: number | null;
  score_total: number | null;
  recommended_strike: number | null;
  recommended_expiry: string | null;
  why: string | null;
  decision: string | null;
  unknowns: string[];
}

// Extract the LAST fenced ```json block and parse it into the verdict shape.
export function parseVerdict(text: string): ParsedVerdict {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (blocks.length === 0) {
    throw new Error("No ```json verdict block found in claude.ai response");
  }
  const raw = (blocks[blocks.length - 1]?.[1] ?? "").trim();
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not parse verdict JSON: ${detail}`);
  }
  return {
    verdict: asVerdict(obj.verdict),
    score_pass: asNumberOrNull(obj.score_pass),
    score_total: asNumberOrNull(obj.score_total),
    recommended_strike: asNumberOrNull(obj.recommended_strike),
    recommended_expiry: asStringOrNull(obj.recommended_expiry),
    why: asStringOrNull(obj.why),
    decision: asStringOrNull(obj.decision),
    unknowns: asStringArray(obj.unknowns),
  };
}

function asVerdict(v: unknown): Verdict | null {
  return v === "PASS" || v === "FAIL" ? v : null;
}

function asNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

function asStringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" || trimmed.toLowerCase() === "null" ? null : trimmed;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
