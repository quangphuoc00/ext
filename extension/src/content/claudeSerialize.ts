// Pure DOM serialization utility for claude.ai assistant messages.
// Kept in its own module so it can be unit-tested without importing any
// chrome/extension runtime APIs.

// Serialize an assistant message element to plain text while reconstructing
// fenced code blocks. Claude.ai renders ```json … ``` as a styled <pre><code>
// element; a plain innerText/textContent call omits the backtick fence
// markers, causing parseVerdict to throw "No ```json verdict block found".
export function serializeWithCodeFences(root: HTMLElement): string {
  function nodeToText(node: Node): string {
    if (node.nodeType === 3 /* Node.TEXT_NODE */) return node.textContent ?? "";
    const el = node as HTMLElement;
    const tag = el.tagName?.toLowerCase() ?? "";
    if (tag === "pre") {
      const codeEl = el.querySelector("code");
      const lang = codeEl?.className.match(/language-(\w+)/)?.[1] ?? "";
      const content = (codeEl ?? el).textContent ?? "";
      return `\`\`\`${lang}\n${content.trimEnd()}\n\`\`\`\n`;
    }
    if (tag === "br") return "\n";
    let out = "";
    for (const child of Array.from(el.childNodes)) out += nodeToText(child);
    if (tag === "p" || tag === "div" || tag === "li") out += "\n";
    return out;
  }
  let out = "";
  for (const child of Array.from(root.childNodes)) out += nodeToText(child);
  return out.trim();
}
