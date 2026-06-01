// One-off: apply a SQL file to the linked Supabase project via the Management API.
// Usage: SUPABASE_ACCESS_TOKEN=... node supabase/apply.mjs <ref> <sqlFile>
import { readFileSync } from "node:fs";

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.argv[2];
const file = process.argv[3];
if (!token || !ref || !file) {
  console.error("need SUPABASE_ACCESS_TOKEN env + <ref> + <sqlFile>");
  process.exit(1);
}
const query = readFileSync(file, "utf8");
const res = await fetch(
  `https://api.supabase.com/v1/projects/${ref}/database/query`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  },
);
const text = await res.text();
console.log("HTTP", res.status);
console.log(text);
process.exit(res.ok ? 0 : 1);
