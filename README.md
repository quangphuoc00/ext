# OptionPilot

A cash-secured-put (CSP) cockpit in three parts on top of hosted Supabase:

- `extension/` - Chrome MV3 scraper (Vite + crxjs). Scrapes CSP data sources and runs the claude.ai analysis. Writes to Supabase.
- `dashboard/` - Next.js (App Router) app with Supabase Auth. Cash, watchlist, options portfolio (P&L/expiry), Run Analysis. Deploys to Vercel.
- `contracts/` - shared TypeScript: DB types, scraper interface + field shapes, messages, the analysis prompt template. Frozen/import-only.
- `supabase/` - SQL migration (`0001_init.sql`) + setup notes.

## Data model
- Shared (objective, global): `stocks` (PK symbol, incl. intrinsic_value), `macro_data` (PK metric).
- Personal (RLS owner-only): `profiles` (cash + settings), `watchlist`, `portfolio`, `analyses`, `analysis_requests`.

## Local dev
```bash
# contracts (types only)
cd contracts && npm install

# extension
cd ../extension && npm install && npm run dev   # then load dist/ unpacked in Chrome

# dashboard
cd ../dashboard && npm install && npm run dev    # http://localhost:3000
```

See `supabase/README.md` to apply the schema and create your user. Env files hold the Supabase URL + publishable key.

## Analysis flow
Dashboard "Run Analysis" inserts an `analysis_requests` row -> the extension (logged into Claude in your Chrome) consumes it via Realtime, drives claude.ai, parses the verdict, writes `analyses` -> dashboard updates live.
