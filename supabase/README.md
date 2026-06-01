# OptionPilot - Supabase setup

Project URL: `https://coctobzhtzprglqzmsmf.supabase.co`

## 1. Apply the schema

Two options.

### Option A - SQL editor (no CLI)
1. Open the Supabase dashboard -> SQL Editor.
2. Paste the contents of `migrations/0001_init.sql` and run it.

### Option B - Supabase CLI (needs an access token)
```bash
# from repo root
npx supabase login            # or: export SUPABASE_ACCESS_TOKEN=...
npx supabase link --project-ref coctobzhtzprglqzmsmf
npx supabase db push
```

## 2. Enable auth + create your user
- Authentication -> Providers -> Email: enabled (email/password).
- Authentication -> Users -> Add user: create the single account you log into both the dashboard and the extension with.

## 3. Keys (already wired into .env files)
- `VITE_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` = the project URL above.
- `VITE_SUPABASE_ANON_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` = the **publishable** key (`sb_publishable_...`).
- Never use the secret / service_role key in the extension or dashboard.

## 4. Regenerate types after schema changes
```bash
npx supabase gen types typescript --project-id coctobzhtzprglqzmsmf > contracts/src/database.types.ts
```
The committed `contracts/src/database.types.ts` is hand-authored to match `0001_init.sql`; regenerate to confirm no drift once the schema is applied.
