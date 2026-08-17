# Auth Hardening Plan

Status: **Phases 0 and 4's dashboard items are the only pieces left outside
code.** Phases 1, 2, 3 and 4's code/transport work are implemented. See
"Current state" below for the exact breakdown. Written 2026-08-12, last
updated 2026-08-17.

## Decisions (settled)

| # | Decision |
|---|---|
| D1 | **No self-service password reset.** IT resets passwords on request. Magic links removed entirely. |
| D2 | **Users cannot remove their own MFA.** Only IT can. |
| D3 | **MFA required for all users**, not just privileged roles. |
| D4 | **7-day grace period**, not a single skip. Prompt on every login during grace, with "Set up now" / "Skip for now". After 7 days it is mandatory. |
| D5 | Existing users get the same 7-day grace, starting from their first login after rollout. |
| — | Bulk import: auto-generated temp passwords, built after the Edge Function port. |

A consequence of D1 worth stating plainly: **a forgotten password becomes
an IT ticket.** There is no automated path back into an account. Combined
with D2 (only IT removes MFA), IT is now the sole recovery route for both
credential loss and lost authenticator devices. That is a deliberate
trade — it removes two whole email-based attack surfaces — but it puts IT
availability on the critical path for lockouts. Worth an internal SLA.

---

## Current state (2026-08-17)

| Area | Today |
|---|---|
| Sign-in | Password only — magic link removed, `AuthCallback.jsx` deleted |
| Password reset | None by design (D1) — IT resets via Edit user |
| MFA | **Built**: grace-period gate, self-service enrollment (Settings), IT removal, `aal2` enforced on every IT-gated function |
| Account creation | Single: `supabase/functions/create-user` (ported off Netlify). Bulk: `supabase/functions/bulk-import-users` (Phase 3, new) |
| Bulk import | **Built** — CSV in, dry-run/preview/confirm, temp passwords, forced change on first login |
| Server functions | All 5 ported to Supabase Edge Functions; Netlify retired entirely |
| CORS | Locked to `APP_URL` (falls back to `*` until that's set) on every browser-facing function |
| Session expiry | 12h time-box set (2026-08-17) |
| Phase 0 (signup lockdown, Site URL, password policy, etc.) | **Done** (2026-08-17) — captcha (item 7) deliberately skipped |
| Migrations v15–v19 applied to the live database | **Still unverified** — no DB access to confirm from here |

---

## Phase 0 — Dashboard configuration (no code) — ✅ Done (2026-08-17)

Items 1–6 confirmed done by you on 2026-08-17. Item 7 (captcha)
deliberately skipped — see below.

1. **Disable self-signup** — Authentication → Providers → Email → off.
   This is the control behind "IT only creates accounts"; the v15
   `handle_new_user` hardening only validates the office, it cannot stop
   registration.
2. **Site URL** — Authentication → URL Configuration → production domain.
3. **Redirect allow-list** — with magic link and password reset both gone,
   nothing in the app needs a redirect URL any more. Keep the list
   **empty** (or Site URL only). Fewer entries, fewer open-redirect
   opportunities.
4. **Password policy** — Authentication → Policies. Minimum length 12,
   require mixed character classes, and enable **leaked-password
   protection** (HaveIBeenPwned check) if the plan offers it. This matters
   more now: passwords are set by IT and changed rarely, so a weak one
   persists.
5. **Email enumeration protection** — Authentication → Security. Stops the
   login form revealing which addresses have accounts.
6. **Session controls** — see Phase 4 below for recommended values.
7. ~~**Captcha**~~ — **Decision (2026-08-17): skipped for now.** Would
   have paired hCaptcha or Cloudflare Turnstile in Supabase's dashboard
   with a matching `AuthPage.jsx` change to render the widget and pass
   its token. Revisit if credential-stuffing/brute-force login attempts
   actually show up (Supabase Logs → Auth would surface repeated failed
   sign-ins), or proactively once a provider account is set up. Until
   then, items 1–6 below still stand as the core of Phase 0.

**Supabase Auth SMTP is no longer required.** With no password reset, no
magic link, and `email_confirm: true` on creation, Supabase Auth sends no
mail at all. (Graph mail for reminders is unaffected — different channel.)

---

## Phase 1 — Remove magic link ✅ Implemented

Now a pure deletion; nothing replaces it.

- Delete the `magic-link` and `link-sent` modes from `AuthPage.jsx`,
  the two `signInWithOtp` calls (~lines 49, 61), and the "email me a link"
  affordance (~line 159).
- Update the copy at [SettingsPage.jsx:248](src/pages/SettingsPage.jsx#L248),
  which explicitly references signing in with email links.
- Add a line to the login screen telling users to contact IT for a
  password reset, so the dead end is signposted rather than discovered.
- **`AuthCallback.jsx` becomes dead code.** With no magic link, no
  password reset, and `email_confirm: true` on account creation, nothing
  can route to `/auth/callback`. Recommend deleting the component and the
  route. (It would need restoring if invite-based onboarding is ever
  adopted — noted here so that is a conscious choice later, not a
  rediscovery.)
- Add captcha token to `signInWithPassword` if Phase 0 item 7 is enabled.

---

## Phase 2 — MFA (TOTP) ✅ Implemented

Supabase has native TOTP: `mfa.enroll`, `mfa.challenge`, `mfa.verify`,
`mfa.unenroll`, `mfa.listFactors`, `mfa.getAuthenticatorAssuranceLevel()`.
supabase-js v2.39 supports all of it — no new dependency.

### AAL

Supabase models MFA state as **Authenticator Assurance Level**:

- `aal1` — password only
- `aal2` — password + verified TOTP

`getAuthenticatorAssuranceLevel()` returns `{ currentLevel, nextLevel }`.
`nextLevel === 'aal2' && currentLevel === 'aal1'` means "has a factor,
hasn't satisfied it this session".

### Grace period (D4/D5)

Supabase has no concept of a grace period — ours to build.

Schema:

```sql
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS mfa_grace_started_at TIMESTAMPTZ;
```

Set it on the user's **first login after rollout** if NULL. This handles
new and existing users with one rule and no backfill: a brand-new account
starts its 7 days when the person first signs in, and an existing account
does the same. Nobody's clock starts while they aren't looking.

Guard it in the v15 `guard_profile_privileged_columns` trigger: a
non-IT user may let it be set once, but must never move it forward or
clear it — otherwise the grace period is infinitely renewable. Concretely,
reject any non-IT update where `OLD.mfa_grace_started_at IS NOT NULL AND
NEW.mfa_grace_started_at IS DISTINCT FROM OLD.mfa_grace_started_at`.

### Post-login gate

A wrapper around `ProtectedRoute` so it covers every route:

```
factors = await supabase.auth.mfa.listFactors()
aal     = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()

if (has verified factor && aal.currentLevel === 'aal1')
    -> TOTP challenge screen. No skip, ever.

if (no factor) {
    if (mfa_grace_started_at IS NULL) set it to NOW()
    graceEnds = mfa_grace_started_at + 7 days

    if (now < graceEnds)
        -> enrolment prompt WITH "Skip for now"
           ("Required in N days" — show the countdown, Microsoft-style)
    else
        -> enrolment prompt, mandatory, no skip
}

else -> proceed
```

Shown **once per login**, not once per navigation — track dismissal in
session state so skipping doesn't re-prompt on every route change.

### Settings

New "Two-factor authentication" card:

- Not enrolled → "Set up" → QR + manual secret → verify 6-digit code
- Enrolled → status only, plus "contact IT to remove". **No self-removal**
  (D2) — offering it would make mandatory MFA voluntary.

### IT removal

`auth.admin.mfa.deleteFactor({ userId, id })` needs the service role, so
this is a **new server endpoint**, not a client call. Build it during the
Edge Function port — either extend `update-user` or add `remove-mfa`.
Surface it in the AdminPage edit-user modal.

Supabase TOTP has **no backup codes**, so this is the only recovery path
for a lost device.

### Enforcement — read this before shipping

Client-side gating is **not** enforcement. A user who skipped, or who
edits the client, still holds a valid `aal1` JWT that satisfies every
existing RLS policy. Three levels:

- **(a) Client gate** — UX only. Necessary but not sufficient.
- **(b) `aal2` on privileged server actions** — the IT-gated endpoints
  (`create-user`, `update-user`, `delete-user`, `delete-timesheets`,
  `remove-mfa`) inspect the caller's `aal` claim and refuse `aal1`. Best
  value for least blast radius: IT is the role that can escalate anything.
- **(c) `aal2` in RLS** — policies test `auth.jwt()->>'aal' = 'aal2'`.
  Strongest, but touches many policies and would lock out every user still
  inside their grace period.

**Ship (a) + (b) with Phase 2. Adopt (c) only once the grace period has
elapsed for everyone** — i.e. 7+ days after rollout, once
`SELECT count(*) FROM profiles WHERE <no factor>` is zero.

---

## Phase 3 — Bulk employee import ✅ Implemented (2026-08-17)

Settled: **auto-generated temp password per user**, shown once to IT.
**Format decision: CSV** (recommendation below, confirmed at build time).

Built as:
- `supabase/migration_v19_bulk_import.sql` — `profiles.must_change_password`.
  Deliberately NOT added to the v15 privileged-column guard: a user
  clearing their own flag after actually changing their password isn't
  privilege-sensitive the way roles/office_id are.
- `supabase/functions/bulk-import-users` — IT + `aal2` gated (same
  `requireAal2` as every other admin endpoint). One request shape for
  both dry-run and confirm; confirm re-validates from scratch rather than
  trusting the earlier dry-run, since state can move between the two
  calls. Capped at 200 rows per request (Edge Function wall-clock limit).
- `src/lib/csv.js` — parse/serialize/download, ~90 lines, zero
  dependencies. `xlsx` was deliberately not used, even though it's
  already installed for timesheet import — see the file format
  discussion below for why.
- `src/components/admin/BulkImportUsersModal.jsx` — upload → dry-run
  preview → confirm → results-with-passwords, mirroring
  `UploadPage.jsx`'s own dry-run/preview/confirm shape for XLSX.
- `src/components/ForceChangePasswordGate.jsx` — new gate, chained
  **before** `MfaGate` (temp password → forced change → MFA enrolment,
  per the ordering below). Wired into `ProtectedRoute.jsx` the same way
  `MfaGate` already was: rendered directly rather than as a separate
  `<Route>` layer, so `Outlet` resolution keeps working unchanged.

Not built: column-mapping UI (headers are fixed — `email, fullName,
office, roles, managerEmail, joiningDate, discipline`; a template
download covers this instead) and multi-manager-per-row CSV support
(one `managerEmail` column; add more via Edit user after import).

### File format — recommendation

You asked for Excel. The honest position: `xlsx` (already a dependency,
used by `parse-timesheet.js`) carries an **unfixed high-severity advisory**
(prototype pollution + ReDoS), and this new path would parse untrusted
uploads *to create user accounts* — the highest-privilege operation in the
app. Options, in order of preference:

1. **CSV** — parsed in ~20 lines of plain JS, no dependency, no advisory.
   Users "Save As → CSV" from Excel. Recommended.
2. **XLSX via `exceljs`** — accepts `.xlsx` natively, maintained library.
   Adds a dependency and still parses a complex binary format from
   untrusted input, but materially safer than option 3.
3. **XLSX via existing `xlsx`** — no new dependency, but knowingly extends
   a known-vulnerable parser to account creation. Not recommended.

If the `.xlsx` requirement is firm, take **option 2**.

### Design

- Mirror `parse-timesheet.js`'s **dry-run → preview → confirm** flow.
  Never create accounts directly off an upload.
- Columns: email, full name, office, roles, manager, joining date,
  discipline. Validate all foreign references in the dry run and report
  per-row errors before anything is written.
- **No transaction across `auth.users`.** If row 40 fails, rows 1–39 exist.
  The importer must report exactly which rows succeeded and be safely
  re-runnable — skip existing emails rather than erroring on them.
- Temp passwords shown **once**, never persisted. Generate with
  `crypto.randomUUID()`-grade entropy, not `Math.random()`.
- Add `profiles.must_change_password BOOLEAN NOT NULL DEFAULT false` so a
  temp password can't become permanent.
- **Gate ordering for a new user:** temp password → forced password change
  → MFA enrolment (with grace). Three gates in a row; design as one guided
  flow, not three redirects.

---

## Phase 4 — Session & transport hardening — ⏳ Mostly done, dashboard items open

### Session controls (Authentication → Sessions)

| Setting | Default | Recommended | Why |
|---|---|---|---|
| JWT expiry | 3600s | 3600s (keep) | Access-token lifetime; refresh handles renewal transparently |
| Refresh token rotation | on | **on** | A stolen refresh token is single-use; reuse is detected |
| Reuse interval | 10s | 10s (keep) | Tolerates races from parallel tabs |
| Time-box sessions | off | **12h**, if available on your plan | Absolute cap — a session cannot outlive a working day |
| Inactivity timeout | off | Not available on your Supabase plan (Pro+ only) | — |

Server-enforced, so preferable to a client-side idle timer (which is
trivially defeated and only affects the UI).

**Decision (2026-08-14): skipping inactivity enforcement for now.**
Supabase gates server-side inactivity timeout behind Pro; the current
plan doesn't have it. Considered and declined a client-side idle timer
(real limitation: only fires while a tab is open with JS running — no
protection against a bearer token used directly outside the browser) and
a full server-side implementation via a `last_seen_at` heartbeat woven
into RLS (real protection, but touches most policies in the schema —
materially bigger than anything else in Phase 4). Revisit if: the
Supabase plan is upgraded to Pro, or the risk profile changes enough to
justify the RLS-heartbeat approach despite its cost.

### Transport

- **HTTPS forced** — cPanel → Domains → Force HTTPS Redirect.
- **HSTS** — add to the `public/.htaccess` from the deployment plan:
  ```apache
  Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
  ```
  Only after HTTPS is confirmed working — HSTS is sticky and hard to undo.
- Security headers (`X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`) are already in the deployment plan's `.htaccess`.
- **Lock down CORS** — all five functions currently send
  `Access-Control-Allow-Origin: *`. Pin to the production origin once the
  domain is fixed. The JWT check is the real guard, so this is
  defence-in-depth, but it is free.

### Step-up re-auth (optional, later)

Require a fresh TOTP challenge immediately before the highest-impact
actions — changing another user's roles, deleting a user — even inside a
valid session. Supabase supports this via a fresh `mfa.challenge`. Guards
against an unlocked laptop. Worth doing once (b) enforcement is in place.

### Audit visibility

Supabase logs auth events (sign-ins, failures, MFA enrolment) under Logs →
Auth. No build needed, but worth knowing it exists — it is the only record
of a compromised login, and there is currently no in-app audit trail for
auth events.

---

## Suggested order — actual order things landed in

1. **Phase 0** ✅ (2026-08-17) — signup lockdown, Site URL, empty redirect
   list, password policy, email enumeration protection, 12h session
   time-box. Item 7 (captcha) deliberately skipped, documented above.
2. **Phase 1** ✅ — magic link removed, `AuthCallback.jsx` deleted.
3. **Phase 4** ✅ (code + dashboard) — CORS lock, security headers, HSTS
   (present but commented out pending HTTPS confirmation), 12h session
   time-box confirmed set.
4. **Edge Function port** ✅ — all 5 Netlify functions moved to Supabase
   Edge Functions; Netlify retired from the repo entirely.
5. **Phase 2** ✅ — MFA, including IT MFA removal (now on the ported
   `update-user` function) and `aal2` enforcement on every admin endpoint.
6. **Phase 3** ✅ — bulk import, CSV-based, built on the ported functions.
7. **Still open**: confirming migrations v15–v19 are applied to the live
   database (no DB access from here to check), captcha (skipped, revisit
   if warranted — see Phase 0 item 7), step-up re-auth (optional/later),
   and enforcement level (c) (`aal2` in RLS) — correctly still deferred
   until everyone has cleared their MFA grace period.
