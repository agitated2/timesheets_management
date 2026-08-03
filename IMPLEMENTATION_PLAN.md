# Implementation Plan — Offices, Leave Cycles, Timesheet Revamp, Date-only Projects

Target: incremental integration into the existing Vite + React + Supabase app.
Execute phases **in order**. Each phase is independently shippable and ends with
`npm test && npm run build` passing.

---

## Decisions already locked (do not re-litigate)

| Topic | Decision |
|---|---|
| Office membership | **Home office (single FK) + additional offices (array) + `sees_all_offices` flag** |
| Leave year basis | **Employee joining anniversary** |
| Rollover | **Enabled per category, with configurable cap AND expiry** |
| Hours-tracked projects | **Convert to date-based**, `end_date = NULL` until a PM sets it |
| Seed office | All pre-existing data is backfilled to one office named **Amman** |
| XLSX upload | Kept in code, **disabled by default**, IT-togglable |
| Calendars | **Tied 1:1 to office**; create/delete + employee assignment UI disabled but code retained |

## Already implemented — DO NOT rebuild

1. **Stage end-date hard block, no grace period.** `src/lib/projectRules.js` (`canLogToStage`
   returns `reason: 'ended'` for `entryDate > endDate`) and `enforce_stage_logging()` in
   `schema.sql` already enforce this. Backdating inside the window is already allowed
   indefinitely. Extensions already work by moving `end_date` via `update_stage_boundary`.
2. **Discipline filter on Projects analytics.** Already present in `ProjectInsights`
   (`AnalyticsPage.jsx`), currently labelled "Department" — only needs relabelling.

---

# PHASE 1 — Projects: date-based tracking only

### 1.1 Migration `supabase/migration_v7_dates_only.sql`

```sql
-- Flag converted projects so a PM can supply real dates later.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS needs_date_review BOOLEAN NOT NULL DEFAULT false;

-- Convert hours projects. start_date derived from earliest logged work;
-- end_date deliberately left NULL so NOBODY is locked out of logging.
UPDATE public.projects p SET
  tracking_type     = 'date',
  needs_date_review = true,
  start_date = COALESCE(
    p.start_date,
    (SELECT MIN(t.date) FROM public.timesheet_entries e
       JOIN public.timesheets t ON t.id = e.timesheet_id
      WHERE e.project_id = p.id),
    p.created_at::date
  ),
  end_date = NULL
WHERE p.tracking_type = 'hours';

UPDATE public.project_stages s SET
  start_date = COALESCE(s.start_date,
                        (SELECT start_date FROM public.projects WHERE id = s.project_id)),
  end_date   = NULL
WHERE s.start_date IS NULL;
```

### 1.2 `supabase/schema.sql` edits

- `create_project()` — force `p_tracking_type := 'date'`; raise if `'hours'` passed.
- `create_stage()` / `update_stage_boundary()` — delete the `ELSE` (hours) branches and
  the `allocated_hours` validation. Keep the columns in the table.
- `project_stages_view` — remove the `pool_full` CASE arm. States become
  `not_started | ended | active`.
- `enforce_stage_logging()` — delete the entire `ELSIF v_proj.tracking_type = 'hours'`
  block (pool-exhausted + would-exceed checks).
- `after_entry_hours_close()` — drop the trigger and function.
- **Keep** `projects.tracking_type`, `projects.total_hours`, `project_stages.allocated_hours`
  columns. Cheap to retain, and makes reverting possible.

### 1.3 Frontend

- **`src/lib/projectRules.js`** — delete `poolFit()`; delete the `trackingType === 'hours'`
  branch of `canLogToStage()`. A stage is now purely `not_started | ended | active`.
- **`src/lib/projectRules.test.js`** — remove hour-tracked describe blocks and `poolFit`
  tests. Keep and extend the date-tracked coverage.
- **`src/pages/ProjectsPage.jsx`** — remove the tracking-type toggle in the create modal;
  strip every `isHours` branch (~15 sites); remove hour-pool progress bars and the
  `Hours`/`Dates` badge. Add an amber **“Dates need review”** badge where
  `needs_date_review` is true, clearing it when a PM saves an end date.
- **`src/pages/AnalyticsPage.jsx`** — strip `isHours`; remove the budget `<Bar>`, the pool
  `<ReferenceLine>`, and the exhaustion forecast. Relabel the Department filter to
  **“Discipline”**.
- **`src/pages/UploadPage.jsx`** — drop `poolFit` import and the pool-overflow warning path
  in `getStageWarning`.

---

# PHASE 2 — Timesheet entry revamp

### 2.1 Migration `supabase/migration_v8_timesheet_entry.sql`

```sql
-- (a) App-level feature flags (singleton row)
CREATE TABLE IF NOT EXISTS public.app_settings (
  id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  xlsx_upload_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by          UUID REFERENCES public.profiles(id)
);
INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "settings_read"   ON public.app_settings;
DROP POLICY IF EXISTS "settings_manage" ON public.app_settings;
CREATE POLICY "settings_read"   ON public.app_settings
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "settings_manage" ON public.app_settings
  FOR ALL USING (public.my_has_role('it')) WITH CHECK (public.my_has_role('it'));

-- (b) One timesheet per employee per day.
-- DEDUPE FIRST or the index creation fails. Non-destructive: supersede older rows.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
           PARTITION BY employee_id, date ORDER BY created_at DESC) AS rn
  FROM public.timesheets
  WHERE status IN ('pending', 'approved')
)
UPDATE public.timesheets t
   SET status = 'rejected',
       rejection_reason = COALESCE(t.rejection_reason,
                          'Superseded — duplicate submission for this date.')
  FROM ranked r
 WHERE t.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_timesheets_one_per_day
  ON public.timesheets (employee_id, date)
  WHERE status IN ('pending', 'approved');
```

The partial index is the enforcement: an employee may hold **at most one**
pending-or-approved timesheet per date, but may resubmit freely once a manager
rejects the previous one.

### 2.2 `src/pages/UploadPage.jsx` — rewrite

**Mode handling**
- Fetch `app_settings.xlsx_upload_enabled` on mount.
- Default `uploadMode = 'inapp'`. Render the Excel dropzone **only** when the flag is on.
- Delete all "Beta" badges; rename headings to **“Timesheet entry”**.

**Row-based grid** (replaces the nested date-card layout)
- One date selector at the top, then a table of entry rows.
- Columns: `Project | Stage | Discipline | From | To | Hours | Task | ✕`
- `+ Add row` appends a row. **Pre-fill the new row from the previous row's Project /
  Stage / Discipline** (time and task blank) — this is the common timesheet pattern and
  saves the most clicks. Confirm with the user if they want blank rows instead.
- `Hours` stays computed and read-only.

**Dynamic field sizing**
- Use an **auto-growing `<textarea>` for Task that expands in HEIGHT**, with the column
  widths fixed. Growing widths would desynchronise columns between rows and break the
  grid — do not do that.
- Implementation: `onInput` → `el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'`,
  plus `rows={1}` and `resize-none`.

**Preview & Submit**
- Primary button reads **“Preview & Submit”**.
- Extract the entries table from `ReviewPage.jsx` into a shared
  `src/components/TimesheetPreview.jsx` and render it read-only, so the employee sees
  exactly the manager's view (Time · Hours · Project · Stage · Discipline · Task).
- Preview screen offers **Back to editing** and **Confirm & Submit**.

**Duplicate-day guard**
- Before submitting, query for an existing `pending`/`approved` timesheet on that date.
- If found, block with: *“You already have a timesheet awaiting review for this date.
  You can submit again only if your manager rejects it.”*
- Also catch the unique-violation error (code `23505`) from the insert and surface the
  same message — the client check is a UX nicety, the index is the guarantee.

### 2.3 `src/pages/AdminPage.jsx`

- Add a third tab: `{ key: 'settings', label: 'Settings' }`.
- Content: a toggle for **“Allow XLSX timesheet upload”** writing to `app_settings`,
  with helper text explaining employees use in-app entry when off.

### 2.4 `netlify/functions/parse-timesheet.js`

- At the top of the handler, read `app_settings.xlsx_upload_enabled`.
- If false → `403 { error: 'XLSX upload is disabled. Use in-app timesheet entry.' }`.
- Necessary because this function runs with the service-role key and is reachable
  regardless of what the UI renders.

---

# PHASE 3 — Joining dates & dynamic leave policies

### 3.1 Migration `supabase/migration_v9_leave_policies.sql`

```sql
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS joining_date DATE;

-- One policy row per leave category.
CREATE TABLE IF NOT EXISTS public.leave_policies (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id            UUID NOT NULL UNIQUE
                           REFERENCES public.leave_categories(id) ON DELETE CASCADE,
  default_days_per_year  NUMERIC(6,2) NOT NULL DEFAULT 0,
  rollover_enabled       BOOLEAN NOT NULL DEFAULT false,
  rollover_cap           NUMERIC(6,2),  -- NULL = uncapped
  rollover_expiry_months INT,           -- NULL = carried days never expire
  prorate_first_year     BOOLEAN NOT NULL DEFAULT true,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by             UUID REFERENCES public.profiles(id)
);

-- Audit + idempotency record of every cycle granted.
CREATE TABLE IF NOT EXISTS public.leave_cycle_grants (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category_id      UUID NOT NULL REFERENCES public.leave_categories(id) ON DELETE CASCADE,
  cycle_start      DATE NOT NULL,
  cycle_end        DATE NOT NULL,
  granted          NUMERIC(6,2) NOT NULL DEFAULT 0,
  carried_in       NUMERIC(6,2) NOT NULL DEFAULT 0,
  carry_expires_on DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, category_id, cycle_start)
);
```

RLS: both tables readable by `hr_manage_policies` / `it` (and own rows for
`leave_cycle_grants`); writable only through the RPCs below.

### 3.2 Anniversary cycle engine

```sql
-- Most recent anniversary of p_joining on or before p_today.
CREATE OR REPLACE FUNCTION public.leave_cycle_start(p_joining DATE, p_today DATE)
RETURNS DATE LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN (p_joining + ((date_part('year', age(p_today, p_joining)))::int || ' years')::interval)::date <= p_today
    THEN (p_joining + ((date_part('year', age(p_today, p_joining)))::int || ' years')::interval)::date
    ELSE (p_joining + ((date_part('year', age(p_today, p_joining)))::int - 1 || ' years')::interval)::date
  END;
$$;
```

`run_leave_cycle(p_employee UUID DEFAULT NULL)` — `SECURITY DEFINER`, **idempotent**:

For each employee with a `joining_date` (optionally filtered to `p_employee`), and each
category having a `leave_policies` row:

1. `cycle_start := leave_cycle_start(joining_date, CURRENT_DATE)`;
   `cycle_end := cycle_start + 1 year - 1 day`.
2. If a `leave_cycle_grants` row already exists for `(employee, category, cycle_start)`
   → **skip** (this is what makes reruns safe).
3. `carried_in` =
   - `0` when `rollover_enabled = false` (balance simply refreshes to default), else
   - `LEAST(previous_remaining, COALESCE(rollover_cap, previous_remaining))`
     where `previous_remaining = allowance − approved days used inside the previous cycle`.
     Clamp at `>= 0`.
4. `granted` = `default_days_per_year`, pro-rated in the employee's **first** cycle when
   `prorate_first_year` (`default * remaining_days_in_cycle / 365`, rounded to 0.5).
5. `carry_expires_on` = `cycle_start + rollover_expiry_months` when both rollover and
   an expiry are configured, else `NULL`.
6. `UPDATE leave_balances SET allowance = granted + carried_in` for that
   `(employee, category)` — insert the row if absent.
7. Insert the `leave_cycle_grants` record.

`expire_carried_leave()` — separate idempotent RPC: for grants where
`carry_expires_on < CURRENT_DATE` and carry has not yet been clawed back, subtract the
unused portion of `carried_in` via the existing `adjust_leave_balance` path and mark it
handled (add a `carry_expired_at TIMESTAMPTZ` column to track).

**Scheduling.** Prefer `pg_cron` running both RPCs daily. If `pg_cron` is unavailable on
the project's Supabase plan, fall back to: (a) a **“Run leave cycle now”** button in HR
Policies, and (b) a lazy call to `run_leave_cycle(auth.uid())` on login. Both are safe
because the RPCs are idempotent.

> **Design note.** This layers cycles on top of the existing single `allowance` number
> rather than replacing it with a full ledger. `leave_cycle_grants` supplies the audit
> trail and the idempotency guard. A full per-transaction ledger remains a clean future
> upgrade and is not blocked by this design.

### 3.3 Frontend

- **`src/pages/EmployeeOverviewPage.jsx`** — add a **Joining date** field to the expanded
  employee panel, editable when `hasRole('employee_overview') || hasRole('it')`, saved via a
  new `set_joining_date(p_employees UUID[], p_date DATE)` RPC. Show it in the collapsed row too.
- **`src/components/hr/HRPolicies.jsx`** — new **Leave policies** section listing each paid
  category with editable: default days/year, rollover on/off, cap, expiry months,
  pro-rate first year. Plus a **“Run leave cycle now”** button (IT/policies only) that
  calls `run_leave_cycle(NULL)` and reports how many grants were created.

---

# PHASE 4 — Office separation

> Highest-risk phase. The backfill and the policy changes **must ship in one
> transaction** — if policies land before data, every non-IT user sees an empty app.

### 4.1 Migration `supabase/migration_v10_offices.sql`

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.offices (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_offices_name_lower ON public.offices(lower(name));

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS office_id             UUID REFERENCES public.offices(id),
  ADD COLUMN IF NOT EXISTS additional_office_ids UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS sees_all_offices      BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES public.offices(id);

ALTER TABLE public.holiday_calendars
  ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES public.offices(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_office ON public.holiday_calendars(office_id);

CREATE INDEX IF NOT EXISTS idx_profiles_office ON public.profiles(office_id);
CREATE INDEX IF NOT EXISTS idx_projects_office ON public.projects(office_id);

-- ---- SEED + BACKFILL BEFORE ANY POLICY CHANGE ----
-- Every row that exists today belongs to the Amman office.
-- Referenced by name (not "first created") so the migration is re-runnable
-- and unambiguous even if other offices already exist.
INSERT INTO public.offices (name)
SELECT 'Amman'
WHERE NOT EXISTS (SELECT 1 FROM public.offices WHERE lower(name) = 'amman');

-- Employees. This is what scopes timesheets, timesheet_entries, leave_requests
-- and leave_balances too — they all resolve office through employee_id.
UPDATE public.profiles
   SET office_id = (SELECT id FROM public.offices WHERE lower(name) = 'amman')
 WHERE office_id IS NULL;

-- Projects. This is what scopes project_stages and project_members.
UPDATE public.projects
   SET office_id = (SELECT id FROM public.offices WHERE lower(name) = 'amman')
 WHERE office_id IS NULL;

-- Tie the existing default calendar to Amman (weekends + public holidays carry over).
UPDATE public.holiday_calendars
   SET office_id = (SELECT id FROM public.offices WHERE lower(name) = 'amman')
 WHERE is_default AND office_id IS NULL;

-- Close the isolation hole: once every row is backfilled, an office becomes
-- mandatory. Without this, any future row created without an office_id would be
-- visible to EVERY user (see the `o IS NULL` safety valve in can_see_office).
ALTER TABLE public.profiles ALTER COLUMN office_id SET NOT NULL;
ALTER TABLE public.projects ALTER COLUMN office_id SET NOT NULL;

COMMIT;
```

> Verify `SELECT COUNT(*) FROM profiles WHERE office_id IS NULL;` and the same for
> `projects` returns **0** before the `SET NOT NULL` statements run — if either is
> non-zero the `ALTER` aborts the whole transaction, which is the desired outcome
> (better a failed migration than a partial one).

### 4.2 Visibility helpers

```sql
-- All offices the caller may READ. IT and sees_all_offices get everything.
CREATE OR REPLACE FUNCTION public.my_visible_office_ids()
RETURNS UUID[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN p.sees_all_offices OR 'it' = ANY(p.roles)
      THEN ARRAY(SELECT id FROM public.offices)
    ELSE ARRAY[p.office_id] || p.additional_office_ids
  END
  FROM public.profiles p WHERE p.id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.can_see_office(o UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o IS NULL OR o = ANY(public.my_visible_office_ids());
$$;
```

`STABLE` matters: the planner evaluates the array **once per statement**, so
`= ANY(...)` costs about the same as plain equality.

### 4.3 Policy edits

Append an office predicate to the **read** policies on these tables. Do **not** touch
`*_read_own` policies (a user always sees their own rows).

| Table | Predicate to AND in |
|---|---|
| `profiles` | `public.can_see_office(office_id)` |
| `projects` | `public.can_see_office(office_id)` |
| `project_stages` | `EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND public.can_see_office(p.office_id))` |
| `project_members` | same join through `projects` |
| `timesheets` | `EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))` |
| `timesheet_entries` | join `timesheets → profiles` |
| `leave_requests`, `leave_balances` | join `profiles` on `employee_id` |
| `holiday_calendars`, `public_holidays` | `public.can_see_office(office_id)` (via calendar for holidays) |

IT bypass is already inside `can_see_office`, so no policy needs a special IT arm.

**Write paths:** new rows take the creator's **home** office.
- `create_project()` → set `office_id := (SELECT office_id FROM profiles WHERE id = auth.uid())`.
- Timesheets inherit through `employee_id` — no change needed.

### 4.4 Calendar ↔ office merge

- Rewrite `emp_calendar(emp)` to resolve the calendar of the employee's **home office**,
  falling back to the default calendar. This keeps `is_working_day()` and every leave
  day-count correct.
- Auto-create a calendar when an office is created (trigger on `offices`, or inside the
  create-office RPC), named after the office, weekend default `{5,6}`.
- **Retain** `calendar_assignments` (table, RLS, `assign_calendar()` RPC) untouched —
  simply stop calling it.

### 4.5 Frontend

- **`src/pages/AdminPage.jsx`** — new **Offices** tab (IT only):
  - Create / rename / deactivate offices.
  - Bulk-assign a **home office** to many employees (reuse `MultiSelect` with `showSelectAll`).
  - Per-employee **additional offices** and the **`sees_all_offices`** toggle.
  - Roster panel: select an office → list its employees (search + `Pagination`).
  - Backed by RPCs `upsert_office`, `set_employee_offices(p_employees[], p_home, p_additional[])`.
- **`AdminPage` create-user modal** — office is a required field; pass it through
  `netlify/functions/create-user.js` into the new profile.
- **`src/pages/OnboardingPage.jsx`** — display the assigned office **read-only**
  ("Office: Dubai — contact IT to change"). No selector.
- **`src/components/hr/HRCalendar.jsx`** — hide the new-calendar form, delete-calendar
  control, and the assign/unassign employee UI behind a `const CALENDAR_ADMIN_ENABLED = false`
  constant (keep the code). Keep weekend toggles and public-holiday management, scoped to
  the calendar of the HR user's own office.
- **`src/pages/EmployeeOverviewPage.jsx`** — show office in the row; keep editing in IT Panel.

### 4.6 Service-role functions — RLS does NOT protect these

`create-user`, `update-user`, `delete-user`, `delete-timesheets` all use
`SUPABASE_SERVICE_ROLE_KEY`, which **bypasses every policy above**. Each must enforce
office scoping in JS:

1. Load the caller's profile (`office_id`, `additional_office_ids`, `sees_all_offices`, `roles`).
2. Load the target user's / timesheet-owner's `office_id`.
3. Unless the caller has the `it` role or `sees_all_offices`, reject with `403` when the
   target's office is not in the caller's visible set.

---

## Verification checklist

Run after **every** phase:

```
npm test && npm run build
node --check netlify/functions/parse-timesheet.js
```

Phase-specific manual checks:

- **P1** — create a project (no tracking-type choice offered); converted projects show the
  “Dates need review” badge; analytics renders with no hours artefacts.
- **P2** — with XLSX off, only in-app entry is offered and a direct POST to
  `parse-timesheet` returns 403; submitting twice for one date is refused; the second
  attempt succeeds only after a manager rejects the first.
- **P3** — set a joining date, run the cycle, confirm the allowance; **run it a second
  time and confirm nothing changes** (idempotency); with rollover off, the balance
  refreshes to the default rather than accumulating.
- **P4** — immediately after the migration, **every existing user and project is in
  Amman**, so isolation is not yet observable. To verify:
  1. Confirm nothing disappeared — existing users still see their own timesheets,
     projects, analytics and calendar exactly as before the migration.
  2. In IT Panel → Offices, create a second office (e.g. `Dubai`) and move one test
     employee's **home office** to it.
  3. As that Dubai employee: Amman timesheets, projects, employees and analytics must all
     be invisible. As an Amman employee: the Dubai employee must be invisible.
  4. Give the Dubai employee Amman as an **additional office** → Amman data becomes
     visible again, but their calendar/weekends still come from Dubai (home office).
  5. As IT: everything across both offices is visible.
  6. Set `sees_all_offices` on an HR user listed in neither office → they see both.

## Open item to confirm during Phase 2

When `+ Add row` is pressed, this plan **pre-fills** Project / Stage / Discipline from the
previous row (time and task left blank). If blank rows are preferred, change the single
`newEntry()` initialiser in `UploadPage.jsx`.
