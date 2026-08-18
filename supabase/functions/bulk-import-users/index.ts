// IT-only: bulk-creates employee accounts from a parsed CSV (parsing
// itself happens client-side — see src/lib/csv.js — this function only
// ever sees structured rows, never a raw file). Two modes on the same
// request shape:
//
//   dryRun: true  — validates every row (office/roles/manager/discipline
//                    references, email format, in-batch AND existing-
//                    profile duplicates) and returns per-row results.
//                    Writes nothing.
//   dryRun: false — re-validates (client-side dry-run results are a
//                    preview, never trusted — state could have moved
//                    between the two calls) and creates every row that
//                    passes, skipping the rest. NOT transactional: if
//                    row 40 of 100 fails, rows 1-39 already exist. Every
//                    row's individual outcome is returned so the caller
//                    knows exactly what to retry — a second submission of
//                    the same file is safe, since already-existing emails
//                    are reported as skipped rather than erroring.
//
// Each created account gets a system-generated temporary password
// (crypto.getRandomValues — never Math.random) returned ONCE in the
// response and never stored or logged; must_change_password (v19) is set
// so it cannot silently become permanent. See AUTH_HARDENING_PLAN.md
// Phase 3.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { json, corsPreflight } from '../_shared/cors.ts'
import { requireAal2 } from '../_shared/mfa.ts'

// Keep in sync with ROLES in src/pages/AdminPage.jsx and the user_role
// enum in schema.sql. Validated against a fixed list here rather than
// queried from the DB — roles are added rarely enough (via a migration,
// same place the enum itself changes) that hardcoding avoids a query on
// every single row of every import.
const VALID_ROLES = new Set([
  'employee', 'manager', 'hr', 'c_suite', 'it', 'global_analytics', 'team_analytics',
  'projects_control', 'hr_view_timesheets', 'hr_manage_policies', 'hr_manage_calendar',
  'hr_approve_requests', 'employee_overview',
])

// Edge Functions have a wall-clock execution limit; each row costs a
// handful of sequential awaits (auth create + profile update), so this
// cap keeps even a full confirm run comfortably inside it. Split a larger
// list into multiple files.
const MAX_ROWS = 200

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface ImportRow {
  email?: string
  fullName?: string
  office?: string
  roles?: string
  managerEmail?: string
  joiningDate?: string
  discipline?: string
}

// Avoids visually ambiguous characters (0/O, 1/l/I) since IT reads these
// off a screen to hand over — a password nobody can misread by eye once,
// not a password anyone should be typing repeatedly.
const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%'
function generateTempPassword(length = 14): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => PASSWORD_CHARS[b % PASSWORD_CHARS.length]).join('')
}

Deno.serve(async (req: Request) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json(500, { error: 'Server misconfigured: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from the function environment.' })
  }
  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '')
    const { data: { user: caller }, error: authErr } = await supabaseAdmin.auth.getUser(token)
    if (authErr || !caller) return json(401, { error: 'Unauthorized' })

    const { data: callerProfile } = await supabaseAdmin
      .from('profiles').select('roles, role').eq('id', caller.id).single()
    const callerIsIT = callerProfile?.roles?.includes('it') || callerProfile?.role === 'it'
    if (!callerIsIT) return json(403, { error: 'IT role required' })

    const aal2Rejection = requireAal2(token)
    if (aal2Rejection) return aal2Rejection

    const { rows, dryRun } = (await req.json()) as { rows: ImportRow[]; dryRun: boolean }
    if (!Array.isArray(rows) || rows.length === 0) return json(400, { error: 'No rows provided' })
    if (rows.length > MAX_ROWS) return json(400, { error: `Too many rows (${rows.length}) — split into batches of ${MAX_ROWS} or fewer.` })

    // ── Reference data, loaded once for the whole batch ──────────
    const { data: offices } = await supabaseAdmin.from('offices').select('id, name').eq('is_active', true)
    const officeByName = new Map((offices || []).map((o) => [o.name.toLowerCase(), o.id]))

    const { data: disciplines } = await supabaseAdmin.from('disciplines').select('id, name').eq('is_active', true)
    const disciplineByName = new Map((disciplines || []).map((d) => [d.name.toLowerCase(), d.id]))

    const { data: managers } = await supabaseAdmin
      .from('profiles').select('id, email').filter('roles', 'ov', '{manager,c_suite}')
    const managerByEmail = new Map((managers || []).map((m) => [m.email.toLowerCase(), m.id]))

    const { data: existingProfiles } = await supabaseAdmin.from('profiles').select('email')
    const existingEmails = new Set((existingProfiles || []).map((p) => p.email.toLowerCase()))

    // ── Validate every row ────────────────────────────────────────
    const seenInBatch = new Set<string>()
    const validated = rows.map((row, i) => {
      const errors: string[] = []
      const email = (row.email || '').trim().toLowerCase()
      const fullName = (row.fullName || '').trim()
      const officeName = (row.office || '').trim()
      const rolesRaw = (row.roles || '').trim()
      const managerEmail = (row.managerEmail || '').trim().toLowerCase()
      const joiningDate = (row.joiningDate || '').trim()
      const disciplineName = (row.discipline || '').trim()

      if (!email) errors.push('Email is required.')
      else if (!EMAIL_RE.test(email)) errors.push('Email is not a valid address.')

      if (!fullName) errors.push('Full name is required.')

      let officeId: string | null = null
      if (!officeName) errors.push('Office is required.')
      else {
        officeId = officeByName.get(officeName.toLowerCase()) ?? null
        if (!officeId) errors.push(`Office "${officeName}" not found or inactive.`)
      }

      const roleList = rolesRaw ? rolesRaw.split(';').map((r) => r.trim()).filter(Boolean) : ['employee']
      const badRoles = roleList.filter((r) => !VALID_ROLES.has(r))
      if (badRoles.length > 0) errors.push(`Unknown role(s): ${badRoles.join(', ')}.`)

      let managerId: string | null = null
      if (managerEmail) {
        managerId = managerByEmail.get(managerEmail) ?? null
        if (!managerId) errors.push(`Manager "${row.managerEmail}" not found (must already be a manager or C-Suite user).`)
      }

      if (joiningDate && !DATE_RE.test(joiningDate)) errors.push('Joining date must be YYYY-MM-DD.')

      let disciplineId: string | null = null
      if (disciplineName) {
        disciplineId = disciplineByName.get(disciplineName.toLowerCase()) ?? null
        if (!disciplineId) errors.push(`Discipline "${disciplineName}" not found or inactive.`)
      }

      // Duplicate against existing accounts OR an earlier row in this
      // same file — the second occurrence is the duplicate, not both.
      let duplicate = false
      if (email && EMAIL_RE.test(email)) {
        if (existingEmails.has(email)) { duplicate = true; errors.push('An account with this email already exists.') }
        else if (seenInBatch.has(email)) { duplicate = true; errors.push('Duplicate email within this file.') }
        else seenInBatch.add(email)
      }

      return {
        row: i + 1, email, fullName, officeId, roleList, managerId, joiningDate: joiningDate || null, disciplineId,
        valid: errors.length === 0,
        duplicate,
        errors,
      }
    })

    if (dryRun) {
      return json(200, {
        dryRun: true,
        rows: validated.map((v) => ({ row: v.row, email: v.email, valid: v.valid, duplicate: v.duplicate, errors: v.errors })),
        totalRows: validated.length,
        validCount: validated.filter((v) => v.valid).length,
        invalidCount: validated.filter((v) => !v.valid).length,
      })
    }

    // ── Confirm: create every row that validated cleanly ──────────
    const results = []
    for (const v of validated) {
      if (!v.valid) {
        results.push({ row: v.row, email: v.email, status: 'skipped', reason: v.errors.join(' ') })
        continue
      }

      const tempPassword = generateTempPassword()
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: v.email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: { office_id: v.officeId },
      })
      if (createErr || !created?.user) {
        results.push({ row: v.row, email: v.email, status: 'failed', reason: createErr?.message || 'Account creation failed.' })
        continue
      }

      // handle_new_user() creates the profile row with just email/office_id
      // (see migration_v15) — fill in the rest, and skip the self-service
      // onboarding flow entirely: IT already supplied everything it asks
      // for (name, discipline, manager), so making a bulk-imported user
      // re-enter it would be redundant. Runs as service_role, so the v15
      // guard_profile_privileged_columns trigger's IT-equivalent exemption
      // applies (auth.uid() IS NULL for a service-role write).
      const { error: profileErr } = await supabaseAdmin
        .from('profiles')
        .update({
          full_name: v.fullName,
          roles: v.roleList,
          manager_ids: v.managerId ? [v.managerId] : [],
          manager_id: v.managerId,
          joining_date: v.joiningDate,
          discipline_id: v.disciplineId,
          onboarding_complete: true,
          must_change_password: true,
        })
        .eq('id', created.user.id)

      if (profileErr) {
        results.push({ row: v.row, email: v.email, status: 'failed', reason: `Account created but profile setup failed: ${profileErr.message}. Account exists — fix via Edit user, do not re-import this row.` })
        continue
      }

      results.push({ row: v.row, email: v.email, status: 'created', tempPassword })
    }

    return json(200, {
      results,
      created: results.filter((r) => r.status === 'created').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'failed').length,
    })
  } catch (err) {
    console.error('bulk-import-users error:', err)
    const message = err instanceof Error ? err.message : String(err)
    return json(500, { error: message })
  }
})
