import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const dir = dirname(fileURLToPath(import.meta.url));

// Parsers reference the global `Node` (compareDocumentPosition flags), which
// Node.js does not provide; expose it from the jsdom window we just built.
function installNode(dom: JSDOM): void {
  (globalThis as unknown as { Node: unknown }).Node = dom.window.Node;
}

export function docFromFixture(file: string, url = "https://example.com/"): Document {
  const html = readFileSync(resolve(dir, "fixtures", file), "utf8");
  const dom = new JSDOM(html, { url });
  installNode(dom);
  return dom.window.document as unknown as Document;
}

export function blankDoc(): Document {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  installNode(dom);
  return dom.window.document as unknown as Document;
}
