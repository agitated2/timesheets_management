# Deployment — cPanel VPS + Supabase

Frontend: static build → cPanel `public_html`.
Backend: Supabase (Postgres + Edge Functions). Nothing server-side runs on
the VPS; it serves files only.

---

## Pre-flight check results (2026-08-17)

| Check | Result |
|---|---|
| `npm run build` | Passes — 2613 modules |
| `npm test` | Passes — 8/8 |
| `.htaccess` reaches `dist/` | Yes |
| Secrets in client bundle | None (only `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`, both public by design) |
| `console.log` in `src/` | None |
| Supabase URL baked into bundle | Yes — `.env` was present at build time |
| `xlsx` in frontend bundle | No — Edge Function only |
| `npm audit --omit=dev` | 3 (2 moderate, 1 high) — see "Known issues" |

---

## The `.env` file

Vite reads this at **BUILD** time and string-substitutes the values into
the bundle. It is **not** uploaded to the VPS and is **not** read at
runtime. It only needs to exist wherever `npm run build` runs.

`.env` in the project root:

```
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key from Supabase → Settings → API>
```

Both come from Supabase → Settings → API. Use the **anon / public** key,
never the `service_role` key — anything in a `VITE_` variable ends up
readable in the shipped JavaScript.

The existing `.env` also has `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
left over from the Netlify era. They are unused now (all server-side code
moved to Edge Functions, where Supabase injects them automatically) and
can be deleted. Harmless either way — without a `VITE_` prefix Vite never
exposes them.

**Never upload `.env` to the VPS.** It has no purpose there.

---

## Which database path are you on?

| | Fresh / empty database | Existing database |
|---|---|---|
| Schema | `schema.sql` **only** — skip v2–v21 | v15 → v21 in numeric order |
| Storage bucket | Create it (Private) | Already exists |
| Realtime on `notifications` | Enable it | Already enabled |
| v14 (reminder cron) | Apply separately — see §A5 | Already applied |
| Auth dashboard config | Do Phase 0 | Already done |
| First office + IT user | Bootstrap manually — see §A6 | Already exist |

Both paths then converge on "Deploy steps" §2–§8 below (CLI, Edge
Functions, M365, secrets, build, upload, HTTPS). A single top-to-bottom
checklist for a fresh install is at the end of this file.

---

## §A — Fresh database only

Skip this entire section on an existing database.

**Everything `schema.sql` does NOT cover**, in one list — these are the
things that bite because running one big SQL file *feels* complete:

1. Storage bucket (§A2) — Dashboard, not SQL
2. Realtime on `notifications` (§A3) — Dashboard, not SQL
3. Auth configuration (§A4) — Dashboard, not SQL
4. Migration v14, the reminder cron (§A5) — SQL, but excluded from
   `schema.sql` on purpose because it references live secrets
5. First office + first IT user (§A6) — cannot be done through the app
6. Everything under "Deploy steps" §2–§8 (CLI, Edge Functions, M365,
   secrets, build, upload, HTTPS) — those apply to both paths

### A1. Run `schema.sql`

Supabase Dashboard → SQL Editor → paste the whole file → run.

This is the consolidated schema: every migration v2–v21 is already folded
into it (verified object-by-object), so running the individual migration
files as well is unnecessary and pointless. It also seeds the
`app_settings` singleton row and a default holiday calendar.

Data-backfill steps inside the older migrations (e.g. v11 remapping
existing leave requests onto new category ids) are irrelevant here —
there is no existing data to migrate.

### A2. Create the storage bucket

Dashboard → Storage → New bucket:
- Name: **`timesheet-files`** (exact — it's hardcoded)
- **Private** (not public)

Leave it with **no policies**. That's fail-closed and is the current
production configuration — files are reached through server-generated
signed URLs, not direct client access.

`schema.sql` contains a commented-out storage policy block. **Do not
paste it in as-is** — it calls `public.my_role()`, which no longer exists
(the schema moved to `my_has_role()`), so it will error. It is kept only
as a record of the original intent.

### A3. Enable Realtime on `notifications`

Dashboard → Database → Replication (or Table Editor → `notifications` →
Realtime toggle) → enable Realtime for **`public.notifications`**.

`NotificationBell.jsx` opens a `postgres_changes` subscription on that
table. Without Realtime the bell still works, but only refreshes on page
load — new notifications never appear live, which looks like a bug rather
than a missing setting.

No other table needs it.

### A4. Phase 0 auth configuration

Dashboard → Authentication:
1. Providers → Email → **disable "Enable sign-ups"** (accounts are
   IT-created only; the DB cannot enforce this on its own)
2. URL Configuration → **Site URL** = your production domain
3. URL Configuration → **Redirect URLs** = leave empty (nothing in the app
   uses a redirect since magic link and password reset were removed)
4. Policies → minimum password length **12**, enable leaked-password
   protection if your plan offers it
5. Security → enable **email enumeration protection**
6. Sessions → **time-box sessions to 12h** if available on your plan

### A5. Reminder emails — apply v14 separately (optional)

**v14 is deliberately NOT in `schema.sql`**, because it references real
secret values that must never live in a committed file. It is the only
migration you still apply by hand on a fresh database.

Skip this entirely if you don't want daily reminder emails yet — nothing
else depends on it.

First, in the SQL Editor (these contain live secrets — run them ad hoc,
never save them into a file):

```sql
select vault.create_secret('https://<your-ref>.supabase.co', 'project_url');
select vault.create_secret('<service_role key>', 'service_role_key');
```

Note the argument order — `vault.create_secret(value, name)`. The first
argument is the real secret you substitute in; the second is just the label
it's filed under, and must be typed **exactly** as shown, because v14 looks
the secrets up by those names.

`<…>` marks a placeholder: replace it *including the angle brackets*, but
keep the surrounding single quotes. Leaving the brackets in does not raise
an error — Vault stores the literal text `<service_role key>` and you get a
silent 401 from the cron job forever after. The verification query below
catches it.

Both values come from Dashboard → Settings → API. `<your-ref>` is the
project ref (also the `supabase.com/dashboard/project/<ref>` path segment).

For the key, use the **Legacy API keys → `service_role`** JWT (starts
`eyJ…`), *not* a newer `sb_secret_…` key. `daily-timesheet-reminders`
compares the incoming header against its injected
`SUPABASE_SERVICE_ROLE_KEY` with an exact string match, and the platform
injects the legacy JWT — anything else is a silent 401.

#### Check 1 — are the stored values sane?

Run this straight after creating them. It catches every mistake described
above without printing either secret in full:

```sql
with s as (
  select name, decrypted_secret as v
    from vault.decrypted_secrets
   where name in ('project_url', 'service_role_key')
), j as (
  select s.*,
         case when name = 'service_role_key' and v like 'eyJ%' then
           convert_from(
             decode(
               translate(split_part(v, '.', 2), '-_', '+/')
               || repeat('=', (4 - length(split_part(v, '.', 2)) % 4) % 4),
               'base64'),
             'utf8')::jsonb
         end as claims
    from s
)
select name,
       length(v)         as len,
       claims->>'role'   as jwt_role,
       case
         when v ~ '[<>]'
           then 'FAIL — placeholder brackets not removed'
         when name = 'project_url' and v !~ '^https://[a-z0-9]+\.supabase\.co$'
           then 'FAIL — want https://<ref>.supabase.co, no trailing slash'
         when name = 'service_role_key' and v not like 'eyJ%'
           then 'FAIL — not a legacy JWT (pasted an sb_secret_… key?)'
         when name = 'service_role_key' and claims->>'role' is distinct from 'service_role'
           then 'FAIL — JWT role is ' || coalesce(claims->>'role', 'null') || ' (anon key?)'
         else 'OK'
       end as verdict
  from j
 order by name;
```

**Expect exactly two rows, both `OK`**, with `jwt_role = service_role`.
Fewer than two rows means a secret is missing or misnamed — the label must
be exactly `project_url` / `service_role_key`.

The `jwt_role` column is there because the anon key and the service role
key look nearly identical when pasted, both start `eyJ`, and picking the
wrong one fails exactly the same silent way. The check decodes the JWT
payload (base64**url** — hence the `translate`/`repeat` padding fix) and
reads the `role` claim.

The trailing-slash rule matters because v14 builds the URL by
concatenation: a stored `…supabase.co/` yields `…co//functions/v1/…`.

#### Check 2 — does the whole chain actually work?

Check 1 only proves the values look right. `net.http_post` merely *queues*
a request, so the cron job reports success regardless of what the function
returns — a 401 surfaces nowhere. Don't wait an hour to find out. Fire it
manually right after running v14:

```sql
select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
         || '/functions/v1/daily-timesheet-reminders',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
  )
);

-- wait a second or two, then read the actual response:
select status_code, content
  from net._http_response
 order by created desc
 limit 1;
```

`200` means the whole chain works. `401` means the Vault key doesn't match
the injected one — almost always the legacy-vs-`sb_secret_` mix-up above.

Rotating the service role key later breaks this: the function's injected
copy updates automatically, the Vault copy does not. Re-run
`vault.create_secret` (or `vault.update_secret`) whenever you rotate.

**You do not enter the service role key twice.** It appears in two places
in this repo, but only this one is yours to set:

| Store | Who sets it | Used by |
|---|---|---|
| Postgres Vault (`service_role_key`) | **you, here** | the pg_cron job, to authenticate its pg_net call to the Edge Function |
| Edge Function env (`SUPABASE_SERVICE_ROLE_KEY`) | **Supabase, automatically** | the functions themselves |

Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` into every Edge Function at runtime. Don't try
to set them — `supabase secrets set` refuses any name starting with
`SUPABASE_`.

Graph/M365 credentials do **not** go in Vault either — they're Edge
Function secrets, set in §5 below. Vault here holds only the two values
pg_cron needs to reach the function; everything the function needs once
it's running lives in its own environment.

Then run `supabase/migration_v14_schedule_reminders.sql`. It enables
`pg_cron` + `pg_net` and registers an hourly job that calls the
`daily-timesheet-reminders` Edge Function. It verifies both Vault secrets
exist before committing, so a job scheduled against missing secrets — which
would fail silently every hour — is impossible.

`cron.schedule()` upserts by job name, so re-running is safe.

### A6. Bootstrap the first office and IT user

A fresh database has no offices and no IT user, and **both** are required
to create users through the app. `create-user` rejects a missing office,
requires the caller to hold the `it` role, **and** requires `aal2` (MFA
satisfied this session). So the first account cannot be made in-app.

1. Create an office — **this must come first.** `profiles.office_id` is
   NOT NULL, and the `handle_new_user` trigger falls back to an active
   office when a signup carries no office metadata (which Dashboard →
   Add user does not). With no office in the table it refuses outright:
   *"Cannot create a user before any active office exists."*
   ```sql
   insert into public.offices (name, is_active, timezone, timesheet_deadline)
   values ('Dubai', true, 'Asia/Dubai', '18:00');
   ```
2. Dashboard → Authentication → **Add user** (tick *Auto Confirm User*).
   The new profile lands in that first office automatically; step 3 sets
   it explicitly anyway.
3. Promote them:
   ```sql
   update public.profiles
      set roles = '{it}',
          office_id = (select id from public.offices order by name limit 1),
          onboarding_complete = true
    where email = 'you@company.com';
   ```
4. Sign in → **Settings → Two-factor authentication** → enrol.
5. **Sign out and sign back in.**

Step 5 is the one people miss: enrolling MFA does not retroactively
upgrade the session you enrolled from. Until you re-authenticate with the
authenticator app, every admin action returns *"Two-factor verification is
required for this action"*.

After that, Admin → Create user works normally.

---

## Deploy steps

### 1. Apply database migrations — DO THIS FIRST

**Existing database only** — on a fresh one, §A1 already covered these.

Supabase Dashboard → SQL Editor. Run each file's full contents, **in
numeric order**, checking each succeeds before the next:

```
v15_security_fixes            ← privilege-escalation + self-approval fixes
v16_compliance_view
v17_block_future_timesheets
v18_mfa
v19_bulk_import
v20_no_overlapping_entries
v21_custom_project_fields
v22_handle_new_user_office_fallback
```

(v2–v14 predate this work; skip any already applied. Re-running is safe —
every migration is idempotent.)

Each ends with a verification block that raises if it didn't take, so a
silent partial apply isn't possible. v20 additionally raises `WARNING`s
listing any pre-existing overlapping or overnight-wrapped entries — those
are reported, not deleted; recovery queries are in that file's footer.

**v15 is the important one.** Until it runs, any logged-in employee can
set their own `roles` to `{it}` and take over the app. That hole is live
on the current database right now — it is not created by deploying, so
v15 is worth running ahead of everything else rather than as part of the
deployment batch.

**On v14:** if reminder emails already work on this database, v14 is
applied and there is nothing to do. If you have never set it up, follow
§A5 — v14 is the one migration that is *never* covered by `schema.sql`,
on either path, because it references live secret values.

### 2. Install and link the Supabase CLI

Needed to deploy Edge Functions and set secrets. Once per machine.

On Windows (npm global install of the CLI is deprecated — use Scoop or
the `.exe` from their GitHub releases):

```powershell
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```

Then, from the repo root:

```bash
supabase login
supabase link --project-ref <your-project-ref>
```

The project ref is the subdomain in your Supabase dashboard URL, and the
same string in `VITE_SUPABASE_URL`.

### 3. Deploy Edge Functions

All eight. Every one except `daily-timesheet-reminders` is called directly
by the frontend — miss one and that feature fails at runtime with an
unhelpful "Failed to send a request to the Edge Function":

```bash
supabase functions deploy create-user
supabase functions deploy update-user
supabase functions deploy delete-user
supabase functions deploy delete-timesheets
supabase functions deploy parse-timesheet
supabase functions deploy bulk-import-users
supabase functions deploy test-timesheet-reminder
supabase functions deploy daily-timesheet-reminders
```

### 4. Microsoft 365 setup — only if you want reminder emails

Skip if you're not sending email yet. Nothing else depends on it, and the
app works fine without it.

1. **Entra ID → App registrations → New registration.**
2. **API permissions** → Microsoft Graph → **Application** permissions →
   `Mail.Send` → **Grant admin consent**. Without consent the token issues
   fine but every send returns 403.
3. **Certificates & secrets** → new client secret. Copy the *value*
   immediately; it's shown once.
4. Create an **unlicensed shared mailbox** (e.g.
   `timesheets@yourdomain.com`) to send from.
5. Scope the app to that one mailbox — application `Mail.Send` otherwise
   permits sending as *anyone* in the tenant:
   ```powershell
   Connect-ExchangeOnline
   New-ApplicationAccessPolicy -AppId <client-id> `
     -PolicyScopeGroupId timesheets@yourdomain.com `
     -AccessRight RestrictAccess -Description "Timesheet reminders"
   ```

Collect: tenant ID, client ID, client secret, sender address.

### 5. Set Edge Function secrets

```bash
supabase secrets set \
  APP_URL=https://your-domain.com \
  GRAPH_TENANT_ID=... \
  GRAPH_CLIENT_ID=... \
  GRAPH_CLIENT_SECRET=... \
  GRAPH_SENDER_UPN=timesheets@your-domain.com
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically — **do not set them**.

`APP_URL` does double duty: the "Submit your timesheet" link in reminder
emails, and locking every browser-facing function's CORS origin down to
your domain (it falls back to `*` while unset). Set it even if you skip
the Graph vars.

Verify with `supabase secrets list` (names only, not values).

### 6. Build the frontend

Locally, with `.env` in place:

```bash
npm ci
npm run build
```

Produces `dist/`.

### 7. Upload to cPanel

Upload the **contents** of `dist/` into `public_html/` — not the `dist`
folder itself. You should end up with:

```
public_html/
  index.html
  .htaccess
  assets/
    index-<hash>.js
    index-<hash>.css
```

Via cPanel File Manager: zip `dist`, upload, extract, then move the
contents up one level.

**Two things people miss:**

- **`.htaccess` is a dotfile** — File Manager hides it by default
  (Settings → "Show Hidden Files"). Without it every deep link
  (`/hr`, `/reviews`, refreshing on `/review/:id`) 404s.
- **Delete the old `assets/` folder before uploading a new build.**
  Filenames are content-hashed, so old files are never overwritten — they
  just accumulate forever.

### 8. HTTPS

cPanel → SSL/TLS Status → run **AutoSSL**, then Domains → **Force HTTPS
Redirect**. Non-negotiable: Supabase keeps session tokens in browser
storage.

Once HTTPS is confirmed working in a real browser, optionally uncomment
the HSTS line in `public/.htaccess` and redeploy. Read the comment above
it first — it is effectively irreversible for a year per visitor.

---

## Post-deploy smoke test

1. Load the site, hard-refresh (`Ctrl+Shift+R`).
2. Navigate to `/hr` directly in the address bar → must load, not 404.
   (If it 404s, `.htaccess` is missing or `mod_rewrite` is off.)
3. Sign in.
4. Submit a timesheet with two overlapping entries → must be rejected.
5. As IT: create a user, edit a user, delete timesheets.
6. Admin → Settings → "Send test email to me".
7. Projects → Custom Fields → create a field, assign it, log time against
   that stage.

---

## Known issues / still pending

**`xlsx` — high-severity advisory, no fix available.** Prototype pollution
+ ReDoS. Server-side only (the `parse-timesheet` Edge Function), and
`app_settings.xlsx_upload_enabled` defaults to **false**, so the code path
is unreachable unless you turn it on. Leaving XLSX upload off is the
mitigation; in-app entry is the primary path anyway.

**`react-router` — 2 moderate advisories.** Transitive, no action taken.

**Bundle is 1.2 MB (315 KB gzipped).** One chunk, no code splitting.
Fine over HTTPS with the immutable caching in `.htaccess`; worth splitting
later if first-load time matters.

**Nothing here has been run against a real database or Deno runtime.**
Migrations v15–v21 and all eight Edge Functions are unexercised — they
build and pass static checks, but their runtime behaviour is unverified.
The deferred constraint trigger in v20 is the piece I'd test first.

**Auth items assumed done** (you confirmed Phase 0): self-signup disabled,
Site URL set, redirect allow-list empty, password policy, email
enumeration protection, 12h session time-box. Captcha deliberately
skipped.

---

## Redeploying later

```bash
npm run build
```
then replace `public_html/index.html`, `public_html/.htaccess` and the
whole `public_html/assets/` folder (delete the old one first).

Migrations and Edge Functions only need redeploying when they change.

---

## Fresh install — full checklist, in order

Everything, top to bottom. Tick as you go.

**Database (Supabase Dashboard)**
- [ ] A1 — run `schema.sql` in the SQL Editor
- [ ] A2 — create the `timesheet-files` bucket, **Private**, no policies
- [ ] A3 — enable Realtime on `public.notifications`
- [ ] A4 — auth config: disable sign-ups, Site URL, empty redirect list,
      password policy, email enumeration protection, 12h session cap
- [ ] A5 — *(optional, reminders only)* Vault secrets, then run
      `migration_v14_schedule_reminders.sql`

**Bootstrap**
- [ ] A6.1 — insert the first office
- [ ] A6.2 — create the first user via Dashboard → Authentication
- [ ] A6.3 — `update profiles set roles='{it}' …`
- [ ] A6.4 — sign in, enrol MFA in Settings
- [ ] A6.5 — **sign out and back in** (session must reach `aal2`)

**Backend**
- [ ] 2 — install Supabase CLI, `supabase login`, `supabase link`
- [ ] 3 — deploy all **eight** Edge Functions
- [ ] 4 — *(optional, reminders only)* Entra app registration,
      `Mail.Send` + admin consent, shared mailbox, access policy
- [ ] 5 — `supabase secrets set APP_URL=… ` (+ `GRAPH_*` if using email)

**Frontend**
- [ ] 6 — create `.env` with `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`,
      then `npm ci && npm run build`
- [ ] 7 — upload the **contents** of `dist/` to `public_html/`
      (including the hidden `.htaccess`)
- [ ] 8 — cPanel AutoSSL + Force HTTPS Redirect

**Verify**
- [ ] Post-deploy smoke test (above) — especially loading `/hr` directly,
      which proves `.htaccess` and `mod_rewrite` are working

### What breaks if you skip a step

| Skipped | Symptom |
|---|---|
| A2 bucket | XLSX upload fails; timesheet file links 404 |
| A3 Realtime | Notification bell only updates on page reload |
| A4 sign-ups | Anyone who finds `/auth` can self-register |
| A5 / v14 | No reminder emails; everything else fine |
| A6.5 re-login | Every admin action returns "Two-factor verification is required" |
| 3 Edge Functions | Create/edit/delete user, bulk import, XLSX upload, test email all fail |
| 4 M365 | Reminder + test emails fail; app otherwise fine |
| 5 `APP_URL` | CORS stays `*`; reminder email button links nowhere |
| 6 `.env` | Bundle builds with `undefined` Supabase URL — app cannot connect at all |
| 7 `.htaccess` | Every deep link and refresh 404s |
| 8 HTTPS | Sessions unreliable; browsers may drop auth storage |
