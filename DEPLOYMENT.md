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

## Deploy steps

### 1. Apply database migrations — DO THIS FIRST

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
```

(v2–v14 predate this work; skip any already applied. Re-running is safe —
every migration is idempotent.)

Each ends with a verification block that raises if it didn't take, so a
silent partial apply isn't possible. v20 additionally raises `WARNING`s
listing any pre-existing overlapping or overnight-wrapped entries — those
are reported, not deleted; recovery queries are in that file's footer.

**v15 is the important one.** Until it runs, any logged-in employee can
set their own `roles` to `{it}` and take over the app.

### 2. Deploy Edge Functions

Every one of these is called by the frontend. Miss one and that feature
fails at runtime with a CORS-ish "failed to send a request" error:

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

### 3. Set Edge Function secrets

```bash
supabase secrets set \
  APP_URL=https://your-domain.com \
  GRAPH_TENANT_ID=... \
  GRAPH_CLIENT_ID=... \
  GRAPH_CLIENT_SECRET=... \
  GRAPH_SENDER_UPN=timesheets@your-domain.com
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically — do not set them.

`APP_URL` does double duty: the "Submit your timesheet" link in reminder
emails, and locking every browser-facing function's CORS origin down to
your domain (it falls back to `*` while unset).

### 4. Build the frontend

Locally, with `.env` in place:

```bash
npm ci
npm run build
```

Produces `dist/`.

### 5. Upload to cPanel

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

### 6. HTTPS

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
