# Implementation Handoff Plan

Written 2026-08-17. Target: a fresh session picking this up cold.

**Status: READY.** Four of five open decisions were answered on
2026-08-17 and are recorded in §7 — the affected sections below already
reflect them. D-b carries a recommendation that stands unless overridden.
All tasks can begin.

---

## 0. How to work in this repo

Read these before writing code — they encode decisions you must not
silently undo:

- `AUTH_HARDENING_PLAN.md` — auth model. All phases implemented.
- `SECURITY_BACKLOG.txt` — four deferred LOW findings, still open.
- `supabase/schema.sql` — the consolidated schema. **Every migration must
  also be mirrored here**, or a fresh database diverges from a migrated
  one. This has been done for every migration through v19; keep it up.

Hard conventions in this codebase:

1. **Migrations are hand-numbered and sequential.** Next is `v20`. Each
   is wrapped in `BEGIN; … COMMIT;` with a `DO $$ … $$` verification
   block at the end that RAISEs if the migration didn't take. Follow the
   existing shape exactly (see `migration_v19_bulk_import.sql`).
2. **The database is the guarantee; the client is a courtesy.** Every
   rule that matters is enforced by a trigger or RLS policy, with a
   client-side check existing only so the user gets a clear message
   instead of a raw Postgres error. Never ship a client-only rule.
3. **`CREATE OR REPLACE FUNCTION` resets grants to default (EXECUTE to
   PUBLIC).** If you replace a function that was previously REVOKEd, you
   must re-apply the REVOKE in the same migration or you silently reopen
   a data leak. This has bitten this schema before.
4. **RLS is row-level, not column-level.** Column protection needs a
   trigger — see `guard_profile_privileged_columns`.
5. Server-side code is **Supabase Edge Functions only** (`supabase/
   functions/`). Netlify is fully retired. Shared helpers live in
   `_shared/` (`cors.ts`, `mfa.ts`). IT-privileged endpoints call
   `requireAal2(token)`.
6. Frontend calls Edge Functions via `supabase.functions.invoke()` — see
   the `invokeFn()` helper in `AdminPage.jsx` for the error-unwrapping
   pattern (`error.context.json()`).
7. **Verify, don't assume.** `npm run build` and `npm test` after every
   task. There is no Deno runtime available locally, so Edge Function
   changes cannot be executed before deploy — say so plainly rather than
   implying they were tested.

---

## Task A — Settings: drop the MFA "contact IT" line

**File**: `src/pages/SettingsPage.jsx` ~line 350.

Remove:
```jsx
<p className="text-xs text-gray-400">
  To remove or replace this, contact IT — it can't be turned off from here.
</p>
```

Leave the "Enabled" status and the `justEnrolled` confirmation. Nothing
else changes — self-removal is still not offered (auth-hardening D2);
this only drops the sentence.

---

## Task B — Onboarding: hide office from employees

**File**: `src/pages/OnboardingPage.jsx` ~lines 101–105.

Remove the `officeName` display block. Also remove the now-unused
`officeName` state (~line 14) and the `useEffect` that fetches it
(~lines 37–40) — leaving a dead fetch behind is worse than the original.

Office remains visible to the employee in Settings; this only removes it
from onboarding.

---

## Task C — Employee overview: hide the "change in IT Panel" hint

**File**: `src/pages/EmployeeOverviewPage.jsx` line 176.

Remove:
```jsx
{canManage && <span className="text-xs text-gray-400">(change in IT Panel → Offices)</span>}
```

Keep the Office label and value. `canManage` is still used elsewhere in
the same component — do not remove the prop.

---

## Task D — Block overlapping time entries

**The requirement**: within one employee's one day, no two timesheet
entries may cover overlapping clock time.

### D1 — Database (the guarantee)

New migration `v20`. **Read this carefully — the obvious implementation
is wrong.**

A `BEFORE INSERT ... FOR EACH ROW` trigger will NOT reliably catch
overlaps *within a single multi-row insert*. Both write paths insert all
of a day's entries in one statement (`.insert(entries)` in
`UploadPage.jsx` ~line 846, and the same in `parse-timesheet`), and a
row-level trigger's SELECT runs against the command's snapshot — rows
being inserted by the same command are not dependably visible to each
other. A naive BEFORE trigger would pass a batch that overlaps itself.

Use a **deferred constraint trigger** instead, which fires after all rows
land:

```sql
CREATE CONSTRAINT TRIGGER entries_no_time_overlap
  AFTER INSERT OR UPDATE ON public.timesheet_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.block_overlapping_entries();
```

The function resolves `timesheet_id → (employee_id, date)`, then checks
for any *other* entry on the same timesheet whose window overlaps
NEW's. Standard half-open overlap test — matches the existing
`block_entry_on_hourly_leave` precedent (schema.sql ~line 1498):

```
existing.time_from < NEW.time_to AND existing.time_to > NEW.time_from
```

Edge cases that must be handled explicitly:

- **NULL times** — `parse-timesheet`'s section/legacy formats can produce
  entries with NULL `time_from`/`time_to`. Skip the check (early RETURN),
  matching how `block_entry_on_hourly_leave` does it.
- **Overnight shifts — DECIDED: wrapping is now disallowed** (§7 D-a).
  `time_to` must be strictly after `time_from`; an overnight shift is
  entered as two entries across two days. This makes the overlap test
  simple (no wrapped-range segmentation), and puts hours on the day they
  were actually worked, which is better for every report.

  **This is a behaviour change with three consequences — all three must
  ship together or the app contradicts itself:**

  1. `calcHours()` — `src/pages/UploadPage.jsx` line ~26 — currently
     does `if (h < 0) h += 24`. It must stop wrapping and instead signal
     invalid (return `null`), so the entry fails the `isReady` gate with
     a clear message rather than silently computing a 22-hour day.
  2. `parseTimeRange()` — `supabase/functions/parse-timesheet/index.ts`
     line ~859 — has the identical `if (hours < 0) hours += 24`. Same
     change, surfaced as a violation in the dry-run response.
  3. The v20 trigger should reject `time_to <= time_from` outright
     (when both are non-NULL), making the database the guarantee as
     usual.

  **Before shipping, check for existing wrapped rows** — they'd become
  un-editable under the new rule:
  ```sql
  SELECT t.date, p.email, e.time_from, e.time_to, e.hours_decimal
  FROM public.timesheet_entries e
  JOIN public.timesheets t ON t.id = e.timesheet_id
  JOIN public.profiles p ON p.id = t.employee_id
  WHERE e.time_from IS NOT NULL AND e.time_to IS NOT NULL
    AND e.time_to <= e.time_from
  ORDER BY t.date DESC;
  ```
  The trigger only guards new writes, so existing rows stay as they are.
  If this returns anything, decide whether to correct it before or after
  rollout — do not let the migration silently leave contradictory data
  invisible.
- **Zero-length entries** (`time_from == time_to`) — should not
  false-positive against adjacent entries.
- **Adjacency is not overlap** — `09:00–10:00` and `10:00–11:00` must be
  allowed. The half-open test above already gets this right; don't
  "fix" it to `<=`.

### D2 — Client (the message)

**File**: `src/pages/UploadPage.jsx`.

Add an overlap check to `handlePreviewClick()` (~line 773), next to the
existing duplicate-day guard, so it's caught before the preview step.
Also surface it inline per-row like the existing stage warnings do
(`getStageWarning` / `stageIssues`, ~line 755) so the offending rows are
visibly marked, and fold it into the `isReady` gate (~line 763).

### D3 — XLSX import path

**File**: `supabase/functions/parse-timesheet/index.ts`.

Add `checkOverlapViolations()` alongside the existing
`checkDuplicateDayViolations` / `checkFutureDayViolations`, returning
per-date/per-row violations, and surface it in both the dry-run response
and the confirm path. Mirror the existing violation shape exactly so the
`UploadPage` preview UI can render it with the existing components.

---

## Task E — Employee overview detail modal redesign

**File**: `src/pages/EmployeeOverviewPage.jsx`, `EmployeeDetailModal`
(~lines 139–226).

**Problem**: everything is a flat stack of loosely-grouped rows —
discipline/joining/office crammed into one wrapping flex row, then
Projects, then leave balances, then calendar as an afterthought line.
Dense, no hierarchy, hard to scan.

This is a **visual/structural refactor only**. Do not change what data is
shown, what's editable, or the `canManage` gating. Same props, same
editors (`DisciplineEditor`, `JoiningDateEditor`, `AllowanceEditor`).

Direction:
- A proper header block — name, email, and key identity chips
  (office/discipline) — visually distinct from the body.
- Group into clear sections with real separation, not just a bold label.
  Consider a two-column layout on wide screens (the modal is already
  `wide`), collapsing to one on mobile.
- Leave balances are the densest part and deserve the most attention:
  the current three-numbers-in-a-stacked-span is hard to read. Consider
  a small table or per-category cards with a used/total progress
  indicator.
- Calendar should be a labelled field, not a trailing sentence.
- Reuse existing primitives (`Modal`, `card`, `input`, `btn-*`,
  `SkeletonList`) — do not introduce new styling conventions.

Match the visual language of `TimesheetCompliance.jsx` and the
`ReminderLogCard` in `AdminPage.jsx`, which are the most recently styled
surfaces.

---

## Task F — Custom project fields (BIG)

### Concept

Admin-defined optional fields (v1: **dropdowns only**) attached to
project phases. When an employee logs time against a phase, any fields
assigned to it appear on the entry row. Values roll up as filters and
groupings in Project Analytics.

### Architecture

**Four new tables.** Definitions are workspace-level so the same
"Building" field means the same thing everywhere — per-project field
names would fragment analytics, which defeats the point.

```
custom_fields              -- the Library. id, name, description,
                              is_active, created_by/at
custom_field_options       -- id, field_id, label, sort_order,
                              is_archived, is_na_sentinel
custom_field_assignments   -- which fields apply where:
                              field_id, project_id, stage_id (NULLable),
                              requirement ('required'|'optional'|'disabled')
timesheet_entry_field_values
                           -- entry_id, field_id, option_id,
                              option_label_snapshot
```

**Why a junction table for values, not JSONB on `timesheet_entries`:**
the entire point is aggregation — filter and GROUP BY custom field value
in analytics. That wants real FKs and real indexes. JSONB would work but
makes every analytics query worse, and this schema is relational
throughout; matching it is cheaper than the exception.

**Why both `option_id` AND `option_label_snapshot`:** the FK gives clean
joins/grouping; the snapshot answers "what did this say when it was
submitted." Without the snapshot, renaming an option silently rewrites
history. Without the FK, filtering is string-matching. Both, not either.

**Never hard-delete options** — `is_archived` only, so historical values
keep resolving. Same for fields.

**Archiving an in-use option — DECIDED** (§7 D-c): warn with a usage
count ("This option is used by 47 entries. Archive anyway?"), then
allow. Archiving only removes it from future selection; existing values
keep resolving via the FK, and the label snapshot covers display
regardless. Blocking while in use would mean the most-used options can
never be retired, which is exactly when you usually want to.

**Assignment inheritance — DECIDED** (§7 D-d): project-level with
per-phase override. `stage_id NULL` = applies to every phase of the
project; a row with `stage_id` set overrides the requirement for that
phase. Assigning one field to twelve phases by hand is how data-entry
mistakes happen.

Resolution order when rendering the entry form, most specific wins:
```
1. assignment for (field, project, this stage)   -> use its requirement
2. assignment for (field, project, NULL)         -> use its requirement
3. no assignment                                 -> field does not apply
```
A per-phase override with `requirement = 'disabled'` is how you exclude
one phase from an otherwise project-wide field — so 'disabled' must be a
real stored value, not just the absence of a row.

### The N/A question — most important design point

Three genuinely distinct states, which must not collapse into one:

| State | Meaning | Storage |
|---|---|---|
| Explicit N/A | User said "doesn't apply" | value row, `option_id` → the N/A sentinel option |
| Unanswered | Field was optional, left blank | no value row |
| Not asked | Field didn't exist / wasn't assigned when entry was created | no value row |

If all three read as "N/A" in analytics, the reports lie — "40% of hours
have no building" would blend "genuinely not applicable" with "we didn't
track this yet." **N/A must be a real option row** (auto-created with each
field, `is_na_sentinel = true`, undeletable) so it's filterable and
groupable, and absence must mean absence.

Distinguishing "unanswered" from "not asked" needs the assignment's
`created_at` vs the entry's — worth surfacing in analytics as a caveat
rather than trying to be clever.

**Analytics rollup — DECIDED** (§7 D-e): entries with no value for the
selected field roll into an explicit **"Unspecified"** bucket, shown
separately from explicit N/A. Grouped totals must always reconcile
against the project's unfiltered total — a chart whose slices silently
don't sum to the whole gets noticed at the worst possible moment. Gaps in
data collection should be visible, not hidden.

### RLS — the biggest hidden cost

- `custom_fields`, `custom_field_options`, `custom_field_assignments`:
  SELECT for all authenticated (needed to render the entry form);
  ALL for `projects_control` / `it`.
- `timesheet_entry_field_values`: must be visible **exactly** where its
  parent `timesheet_entries` row is visible. That means mirroring all six
  existing entry policies (`own`, `manager`, `privileged`,
  `global_analytics`, `team_analytics`, `hr_view`). Do not invent a
  looser rule — this table carries per-entry operational detail.
- INSERT: only via the parent timesheet's owner, and only while that
  timesheet is `pending` — mirroring the `entries_insert_own` policy
  fixed in v15.

### UI

- **Field library admin** — new tab in `ProjectsPage.jsx` (or the
  Projects area), gated `projects_control`/`it`. CRUD fields, manage
  option lists, archive.
- **Option list import** — **CSV, not XLSX.** `src/lib/csv.js` already
  exists from the bulk-user-import work and is directly reusable. This is
  the same reasoning that drove that decision: `xlsx` carries an unfixed
  high-severity advisory and this is another untrusted-input path. Show
  a parsed preview before committing, and de-duplicate against existing
  option labels case-insensitively so re-importing a list doesn't double
  every entry.
- **Assignment UI** — per project, and per phase, with the
  required/optional/disabled tri-state.
- **Entry form** (`UploadPage.jsx`, `EntryRow` ~line 1156) — fields
  appear only once a stage is selected, since assignment is
  phase-scoped. Reuse `MultiSelect.jsx` (already has search built in) or
  a single-select variant of it; do not build a new combobox.
- **Analytics** (`AnalyticsPage.jsx`, `ProjectInsights` ~line 121) — add
  custom-field filters alongside the existing discipline filter
  (`deptFilter`, ~line 126, is the pattern to copy), plus a "group hours
  by <field>" view. Note that grouping is a genuinely new query shape,
  not just another filter.

### Explicitly out of scope for v1

- Non-dropdown field types (text/number/date). Free text cannot be
  aggregated, which is the entire purpose here. Additive later.
- Multi-select values. The value table is already a junction, so
  supporting this later is just relaxing a uniqueness constraint —
  design for it, don't build it.
- XLSX timesheet upload populating custom fields. Entries imported via
  `parse-timesheet` will have no custom values in v1. `xlsx_upload_enabled`
  defaults to false, so this affects few or no deployments — but it must
  be stated in the UI, not discovered.

### Suggested build order

1. Migration v20: tables, indexes, RLS, N/A sentinel auto-creation.
2. Field library CRUD + CSV option import (admin only, no entry
   integration yet — shippable and testable on its own).
3. Assignment UI.
4. Entry form integration (`UploadPage`) + value writes.
5. Analytics filters + grouping.

Each step is independently shippable. Do not build all five before
testing any.

---

## §7 — Decisions

Answered 2026-08-17 unless noted. The sections above already reflect
these; this is the record of what was decided and why.

| # | Decision | Resolution |
|---|---|---|
| **D-a** | Overnight entries | **Wrapping disallowed** — split across two days. Simpler overlap logic, hours land on the day worked. Behaviour change: see the three consequences under Task D1. |
| **D-b** | Optional → required with `pending` sheets in flight | **Not explicitly answered — recommendation stands:** enforce at write time only, do not retroactively block approval. A submitted timesheet can no longer be edited by its author, so blocking approval would strand real work with no path forward. Override if you disagree. |
| **D-c** | Archiving an in-use option | **Warn with usage count, then allow.** |
| **D-d** | Assignment scope | **Project-level with per-phase override.** `'disabled'` must be a stored value so a single phase can opt out. |
| **D-e** | Analytics rollup of valueless entries | **Explicit "Unspecified" bucket**, distinct from N/A, so grouped totals reconcile. |

### Still genuinely open

- **D-b** above — recommendation only, not confirmed.
- **Live database state.** Migrations v15–v19 have never been confirmed
  applied (no DB access from this environment). Task D adds v20 on top.
  Confirm the earlier ones landed before assuming v20 will apply cleanly.
- **Pre-existing wrapped time entries** — run the detection query in
  Task D1 before shipping the overnight change.
