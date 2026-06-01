// One-off: dump fin-streamer candidates from a Yahoo quote page to design a
// robust price selector. Usage: npx tsx debug-yahoo.mts "<url>"
import { chromium } from "playwright";

const url = process.argv[2] ?? "https://ca.finance.yahoo.com/quote/%5EVIX";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-US" });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
if (/consent|guce/i.test(page.url())) {
  await page.locator('button[name="agree"], button:has-text("Accept all"), button:has-text("Agree")').first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
}
await page.waitForSelector("fin-streamer", { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1000);

const wantSym = process.argv[3] ?? "^VIX";
const probe = await page.evaluate((wantSym) => {
  // Find any fin-streamer scoped to our symbol, any field.
  const mine = Array.from(document.querySelectorAll(`fin-streamer[data-symbol="${wantSym}"]`)).map(
    (el) => ({ field: el.getAttribute("data-field"), value: el.getAttribute("value"), text: (el.textContent ?? "").trim().slice(0, 16) }),
  );
  // Elements that look like a small price (VIX ~ 5..120, 2 decimals).
  const priceLike = Array.from(document.querySelectorAll("body *"))
    .filter((el) => el.children.length === 0)
    .map((el) => ({ el, t: (el.textContent ?? "").trim() }))
    .filter(({ t }) => /^\d{1,3}\.\d{2}$/.test(t) && Number(t) > 4 && Number(t) < 200)
    .slice(0, 8)
    .map(({ el, t }) => ({ tag: el.tagName.toLowerCase(), testid: el.getAttribute("data-testid"), field: el.getAttribute("data-field"), symbol: el.getAttribute("data-symbol"), cls: (el.getAttribute("class") ?? "").slice(0, 30), text: t }));
  return { mine, priceLike };
}, wantSym);
console.log("finalUrl:", page.url());
console.log(`fin-streamer[data-symbol="${wantSym}"] (any field):`);
console.table(probe.mine);
console.log("\nleaf elements whose text looks like a price:");
console.table(probe.priceLike);

await browser.close();
