import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  Shield, Search, CheckCircle, XCircle, UserPlus, Trash2, X,
  Eye, EyeOff, AlertTriangle, Pencil, FileText, ChevronDown,
  ChevronUp, Calendar, Check, ChevronLeft, ChevronRight, RefreshCw,
  Clock, Send, ShieldCheck, Upload,
} from 'lucide-react'
import { format, parseISO } from 'date-fns'
import clsx from 'clsx'
import Tabs from '../components/Tabs'
import { SkeletonList } from '../components/Skeleton'
import MultiSelect from '../components/MultiSelect'
import BulkImportUsersModal from '../components/admin/BulkImportUsersModal'

const PAGE_SIZE = 10

// Curated, not the full ~600-entry IANA tz database — every "today"/"late"
// decision the reminder job makes depends on this being a real zone name
// (validated server-side too, see guard_office_timezone in migration_v13).
const TIMEZONE_OPTIONS = [
  { value: 'Asia/Dubai',      label: 'Dubai / Abu Dhabi (GST, UTC+4)' },
  { value: 'Asia/Amman',      label: 'Amman (UTC+3)' },
  { value: 'Asia/Riyadh',     label: 'Riyadh (AST, UTC+3)' },
  { value: 'Asia/Kuwait',     label: 'Kuwait City (AST, UTC+3)' },
  { value: 'Asia/Qatar',      label: 'Doha (AST, UTC+3)' },
  { value: 'Asia/Bahrain',    label: 'Manama (AST, UTC+3)' },
  { value: 'Asia/Muscat',     label: 'Muscat (GST, UTC+4)' },
  { value: 'Africa/Cairo',    label: 'Cairo (EET, UTC+2)' },
  { value: 'Asia/Karachi',    label: 'Karachi (PKT, UTC+5)' },
  { value: 'Asia/Kolkata',    label: 'Mumbai / Delhi (IST, UTC+5:30)' },
  { value: 'Asia/Dhaka',      label: 'Dhaka (BST, UTC+6)' },
  { value: 'Asia/Singapore',  label: 'Singapore (SGT, UTC+8)' },
  { value: 'Asia/Manila',     label: 'Manila (PST, UTC+8)' },
  { value: 'Europe/London',   label: 'London (GMT/BST)' },
  { value: 'Europe/Paris',    label: 'Paris / Berlin (CET/CEST)' },
  { value: 'America/New_York', label: 'New York (ET)' },
  { value: 'America/Chicago',  label: 'Chicago (CT)' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (PT)' },
  { value: 'Australia/Sydney', label: 'Sydney (AET)' },
  { value: 'UTC',             label: 'UTC' },
]

function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null
  return (
    <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 dark:border-gray-800">
      <span className="text-xs text-gray-400">Page {page} of {totalPages}</span>
      <div className="flex gap-1">
        <button onClick={() => onChange(page - 1)} disabled={page === 1} className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
          <ChevronLeft size={15} />
        </button>
        <button onClick={() => onChange(page + 1)} disabled={page === totalPages} className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  )
}

const ROLES = [
  'employee', 'manager', 'hr', 'c_suite', 'it', 'global_analytics', 'team_analytics', 'projects_control',
  'hr_view_timesheets', 'hr_manage_policies', 'hr_manage_calendar', 'hr_approve_requests',
  'employee_overview',
]

const roleDisplay = {
  employee:            'Employee',
  manager:             'Manager',
  hr:                  'HR',
  c_suite:             'C-Suite',
  it:                  'IT Admin',
  global_analytics:    'Global Analytics',
  team_analytics:      'Team Analytics',
  projects_control:    'Projects Control',
  hr_view_timesheets:  'HR · View Timesheets',
  hr_manage_policies:  'HR · Manage Policies',
  hr_manage_calendar:  'HR · Manage Calendar',
  hr_approve_requests: 'HR · Approve Requests',
  employee_overview:   'Employee Overview',
}

const roleBadge = {
  employee:            'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  manager:             'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  hr:                  'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  c_suite:             'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  it:                  'bg-ae7-light text-ae7-red dark:bg-ae7-red/10 dark:text-red-300',
  global_analytics:    'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  team_analytics:      'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  projects_control:    'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  hr_view_timesheets:  'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  hr_manage_policies:  'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  hr_manage_calendar:  'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  hr_approve_requests: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  employee_overview:   'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
}

const statusBadge = {
  pending:  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  approved: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
}

// Thin wrapper around supabase.functions.invoke() for the IT-gated Edge
// Functions (create-user, update-user, delete-user, delete-timesheets).
// invoke() attaches the caller's own session Authorization header
// automatically — no manual getSession()/fetch() dance needed.
//
// On a non-2xx response, supabase-js returns data: null and puts the raw
// Response on error.context — the function's own { error } body (the
// actually useful message) lives there, not on `error` itself. Throws so
// every call site can just try/catch like it's a normal async call.
async function invokeFn(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body })
  if (error) {
    let message = error.message
    if (error.context?.json) {
      try { message = (await error.context.json())?.error || message } catch { /* body wasn't JSON */ }
    }
    throw new Error(message)
  }
  return data
}

// ── Create User Modal ─────────────────────────────────────────────
function CreateUserModal({ offices, onClose, onCreated }) {
  const [email, setEmail]           = useState('')
  const [password, setPassword]     = useState('')
  const [confirmPw, setConfirmPw]   = useState('')
  const [fullName, setFullName]     = useState('')
  const [officeId, setOfficeId]     = useState('')
  const [roles, setRoles]           = useState(['employee'])
  const [showPw, setShowPw]         = useState(false)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')

  function toggleCreateRole(r) {
    setRoles(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r])
  }

  async function handleCreate(e) {
    e.preventDefault()
    setError('')
    if (password !== confirmPw) { setError('Passwords do not match.'); return }
    if (roles.length === 0) { setError('Select at least one role.'); return }
    if (!officeId) { setError('Select an office.'); return }
    setLoading(true)
    try {
      await invokeFn('create-user', { email: email.trim().toLowerCase(), password, fullName: fullName.trim(), roles, officeId })
      setLoading(false)
      onCreated()
      onClose()
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  return (
    <Modal title="Create user account" icon={<UserPlus size={18} className="text-ae7-red" />} onClose={onClose}>
      <form onSubmit={handleCreate} className="p-6 space-y-4">
        <div className="bg-gray-50 dark:bg-gray-800 rounded-xl px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
          The account is created pre-verified — no confirmation email is sent.
        </div>

        <Field label="Email *">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="input" placeholder="user@company.com" required autoFocus />
        </Field>

        <Field label="Full name">
          <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} className="input" placeholder="Jane Smith" />
        </Field>

        <Field label="Office *">
          <select value={officeId} onChange={e => setOfficeId(e.target.value)} className="input" required>
            <option value="">Select office…</option>
            {offices.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </Field>

        <Field label="Password *">
          <PasswordInput value={password} onChange={setPassword} show={showPw} onToggle={() => setShowPw(v => !v)} placeholder="Min. 6 characters" />
        </Field>

        <Field label="Confirm password *">
          <input type={showPw ? 'text' : 'password'} value={confirmPw} onChange={e => setConfirmPw(e.target.value)} className="input" placeholder="Repeat password" required />
        </Field>

        <Field label="Initial roles">
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden divide-y divide-gray-100 dark:divide-gray-800 max-h-52 overflow-y-auto">
            {ROLES.map(r => (
              <label
                key={r}
                className={clsx(
                  'flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors',
                  roles.includes(r) ? 'bg-ae7-light/60 dark:bg-ae7-red/5' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                )}
              >
                <Checkbox checked={roles.includes(r)} onChange={() => toggleCreateRole(r)} />
                <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', roleBadge[r])}>
                  {roleDisplay[r]}
                </span>
              </label>
            ))}
          </div>
        </Field>

        <ErrorBox msg={error} />

        <div className="flex gap-3 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button type="submit" disabled={loading} className="btn-primary flex-1">
            {loading ? <Spinner /> : <><UserPlus size={15} /> Create account</>}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ── Edit User Modal ────────────────────────────────────────────────
function EditUserModal({ user: target, onClose, onSaved }) {
  const targetRoles      = target.roles || (target.role ? [target.role] : ['employee'])
  const targetManagerIds = target.manager_ids || []
  const [email, setEmail]           = useState(target.email || '')
  const [fullName, setFullName]     = useState(target.full_name || '')
  const [disciplineId, setDisciplineId] = useState(target.discipline_id || '')
  const [disciplines, setDisciplines]   = useState([])
  const [roles, setRoles]           = useState(targetRoles)
  const [managerIds, setManagerIds] = useState(targetManagerIds)
  const [newPassword, setNewPw]     = useState('')
  const [showPw, setShowPw]         = useState(false)
  const [managers, setManagers]     = useState([])
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')
  const [mfaEnrolled, setMfaEnrolled] = useState(undefined) // undefined = loading
  const [removingMfa, setRemovingMfa] = useState(false)

  function toggleEditRole(r) {
    setRoles(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r])
  }

  function toggleManager(id) {
    setManagerIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  useEffect(() => {
    supabase
      .from('profiles')
      .select('id, full_name, email')
      .filter('roles', 'ov', '{manager,c_suite}')
      .order('full_name')
      .then(({ data }) => { if (data) setManagers(data) })
    supabase
      .from('disciplines')
      .select('id, name, is_active')
      .order('name')
      .then(({ data }) => { if (data) setDisciplines(data) })
    loadMfaStatus()
  }, [])

  async function loadMfaStatus() {
    try {
      const data = await invokeFn('update-user', { userId: target.id, checkMfaStatus: true })
      setMfaEnrolled(!!data.mfaEnrolled)
    } catch {
      setMfaEnrolled(null)
    }
  }

  // Auth hardening D2: only IT can remove another user's MFA — there is
  // no self-removal (see MfaSection in SettingsPage.jsx). Resets their
  // grace period too (server-side, see update-user.js) so a user who
  // lost a device gets a fresh window to re-enrol rather than landing
  // straight on "mandatory, right now".
  async function removeMfa() {
    if (!window.confirm(`Remove two-factor authentication for ${target.full_name || target.email}? They will get a new 7-day grace period to set it up again.`)) return
    setRemovingMfa(true)
    setError('')
    try {
      await invokeFn('update-user', { userId: target.id, removeMfa: true })
      setMfaEnrolled(false)
    } catch (err) {
      setError(`Failed to remove MFA: ${err.message}`)
    } finally {
      setRemovingMfa(false)
    }
  }

  async function handleSave(e) {
    e.preventDefault()
    if (roles.length === 0) { setError('Select at least one role.'); return }
    if (newPassword && newPassword.length < 6) { setError('New password must be at least 6 characters.'); return }
    setError('')
    setLoading(true)

    const emailChanged       = email.trim().toLowerCase() !== target.email
    const nameChanged        = fullName.trim() !== (target.full_name || '')
    const disciplineChanged  = (disciplineId || null) !== (target.discipline_id || null)
    const rolesChanged       = JSON.stringify([...roles].sort()) !== JSON.stringify([...targetRoles].sort())
    const managersChanged    = JSON.stringify([...managerIds].sort()) !== JSON.stringify([...targetManagerIds].sort())

    // Profile-level fields (name, discipline, roles, managers) — IT can write
    // these directly via RLS (profiles_update_it). No serverless function required.
    const patch = {}
    if (nameChanged)       patch.full_name   = fullName.trim() || null
    if (disciplineChanged) patch.discipline_id = disciplineId || null
    if (rolesChanged)      patch.roles       = roles
    if (managersChanged)   patch.manager_ids = managerIds

    if (Object.keys(patch).length > 0) {
      const { error: upErr } = await supabase.from('profiles').update(patch).eq('id', target.id)
      if (upErr) { setError(upErr.message); setLoading(false); return }
    }

    // Email / password change the auth user — these need the admin function.
    if (emailChanged || newPassword) {
      try {
        const body = { userId: target.id }
        if (emailChanged) body.email = email.trim().toLowerCase()
        if (newPassword)  body.newPassword = newPassword
        await invokeFn('update-user', body)
      } catch (err) {
        setError(`Saved profile changes, but email/password update failed: ${err.message}`)
        setLoading(false)
        return
      }
    }

    setLoading(false)
    onSaved({
      ...target,
      email: emailChanged ? email.trim().toLowerCase() : target.email,
      full_name: nameChanged ? (fullName.trim() || null) : target.full_name,
      discipline_id: disciplineChanged ? (disciplineId || null) : target.discipline_id,
      roles: rolesChanged ? roles : target.roles,
      manager_ids: managersChanged ? managerIds : target.manager_ids,
    })
    onClose()
  }

  return (
    <Modal title={`Edit: ${target.full_name || target.email}`} icon={<Pencil size={16} className="text-ae7-red" />} onClose={onClose}>
      <form onSubmit={handleSave} className="p-6 space-y-4">
        <Field label="Email">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="input" required />
        </Field>

        <Field label="Full name">
          <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} className="input" placeholder="Jane Smith" />
        </Field>

        <Field label="Discipline">
          <select value={disciplineId} onChange={e => setDisciplineId(e.target.value)} className="input">
            <option value="">— Unassigned —</option>
            {disciplines.map(d => <option key={d.id} value={d.id}>{d.name}{d.is_active ? '' : ' (inactive)'}</option>)}
          </select>
        </Field>

        <Field label="Roles">
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden divide-y divide-gray-100 dark:divide-gray-800 max-h-52 overflow-y-auto">
            {ROLES.map(r => (
              <label
                key={r}
                className={clsx(
                  'flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors',
                  roles.includes(r) ? 'bg-ae7-light/60 dark:bg-ae7-red/5' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                )}
              >
                <Checkbox checked={roles.includes(r)} onChange={() => toggleEditRole(r)} />
                <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', roleBadge[r])}>
                  {roleDisplay[r]}
                </span>
              </label>
            ))}
          </div>
        </Field>

        <Field label={`Line managers (${managerIds.length} assigned)`}>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden divide-y divide-gray-100 dark:divide-gray-800 max-h-44 overflow-y-auto">
            {managers.length === 0 && (
              <p className="text-xs text-gray-400 px-4 py-2.5 italic">No managers or C-Suite found.</p>
            )}
            {managers.map(m => (
              <label
                key={m.id}
                className={clsx(
                  'flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors text-sm',
                  managerIds.includes(m.id) ? 'bg-ae7-light/60 dark:bg-ae7-red/5' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                )}
              >
                <Checkbox checked={managerIds.includes(m.id)} onChange={() => toggleManager(m.id)} />
                <span>{m.full_name || m.email}</span>
              </label>
            ))}
          </div>
        </Field>

        <Field label={<>Reset password <span className="font-normal text-gray-400">(leave blank to keep current)</span></>}>
          <PasswordInput value={newPassword} onChange={setNewPw} show={showPw} onToggle={() => setShowPw(v => !v)} placeholder="New password (optional)" />
        </Field>

        <Field label="Two-factor authentication">
          {mfaEnrolled === undefined ? (
            <div className="h-9 w-full bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse" />
          ) : mfaEnrolled ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2">
              <span className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400 font-medium">
                <ShieldCheck size={14} /> Enabled
              </span>
              <button
                type="button"
                onClick={removeMfa}
                disabled={removingMfa}
                className="text-xs font-medium text-red-600 hover:text-red-700 dark:text-red-400 disabled:opacity-50"
              >
                {removingMfa ? 'Removing…' : 'Remove'}
              </button>
            </div>
          ) : (
            <p className="text-xs text-gray-400 px-1">Not set up{mfaEnrolled === null ? ' (status unavailable)' : ''}.</p>
          )}
        </Field>

        <ErrorBox msg={error} />

        <div className="flex gap-3 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button type="submit" disabled={loading} className="btn-primary flex-1">
            {loading ? <Spinner /> : <><Check size={15} /> Save changes</>}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ── User Timesheets Modal ──────────────────────────────────────────
function UserTimesheetsModal({ user: target, onClose, onDeleted }) {
  const [timesheets, setTimesheets] = useState([])
  const [loading, setLoading]       = useState(true)
  const [selected, setSelected]     = useState(new Set())
  const [notify, setNotify]         = useState(false)
  const [deleting, setDeleting]     = useState(false)
  const [error, setError]           = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    supabase
      .from('timesheets')
      .select('id, date, total_hours, status, created_at')
      .eq('employee_id', target.id)
      .order('date', { ascending: false })
      .then(({ data }) => {
        setTimesheets(data || [])
        setLoading(false)
      })
  }, [target.id])

  function toggleAll() {
    if (selected.size === timesheets.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(timesheets.map(t => t.id)))
    }
  }

  function toggle(id) {
    const s = new Set(selected)
    s.has(id) ? s.delete(id) : s.add(id)
    setSelected(s)
  }

  async function handleDelete() {
    setDeleting(true)
    setError('')
    try {
      const data = await invokeFn('delete-timesheets', { timesheetIds: [...selected], userId: target.id, notify })
      setDeleting(false)
      onDeleted(data.deleted)
      onClose()
    } catch (err) {
      setDeleting(false)
      setError(err.message)
    }
  }

  const allChecked = timesheets.length > 0 && selected.size === timesheets.length
  const someChecked = selected.size > 0 && selected.size < timesheets.length

  return (
    <Modal
      title={`Timesheets: ${target.full_name || target.email}`}
      icon={<FileText size={16} className="text-ae7-red" />}
      onClose={onClose}
      wide
    >
      <div className="p-6 space-y-4">
        {loading ? (
          <SkeletonList rows={5} />
        ) : timesheets.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-400">No timesheets found for this user.</div>
        ) : (
          <>
            {/* Select all header */}
            <div className="flex items-center gap-3 px-1">
              <Checkbox
                checked={allChecked}
                indeterminate={someChecked}
                onChange={toggleAll}
              />
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {selected.size === 0 ? `${timesheets.length} timesheets` : `${selected.size} of ${timesheets.length} selected`}
              </span>
            </div>

            {/* List */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden max-h-72 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800">
              {timesheets.map(t => (
                <label
                  key={t.id}
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  <Checkbox checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{format(parseISO(t.date), 'EEE, MMM d, yyyy')}</span>
                    {t.total_hours != null && (
                      <span className="text-xs text-gray-400 ml-2">{t.total_hours}h</span>
                    )}
                  </div>
                  <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', statusBadge[t.status])}>
                    {t.status}
                  </span>
                </label>
              ))}
            </div>

            {/* Notify option */}
            <label className="flex items-center gap-3 cursor-pointer">
              <Checkbox checked={notify} onChange={() => setNotify(v => !v)} />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                Notify user about deletion
              </span>
            </label>
          </>
        )}

        <ErrorBox msg={error} />

        {/* Confirmation panel */}
        {confirmOpen ? (
          <div className="space-y-3 bg-red-50 dark:bg-red-950/20 rounded-xl p-4 border border-red-200 dark:border-red-800">
            <p className="text-sm font-medium text-red-700 dark:text-red-400">
              Permanently delete {selected.size} timesheet{selected.size !== 1 ? 's' : ''}?
              This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmOpen(false)}
                disabled={deleting}
                className="btn-secondary flex-1 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting || selected.size === 0}
                className="btn-danger flex-1 text-sm"
              >
                {deleting ? <Spinner /> : <><Trash2 size={13} /> Delete {selected.size}</>}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-3">
            <button onClick={onClose} className="btn-secondary flex-1">Close</button>
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={selected.size === 0}
              className="btn-danger flex-1"
            >
              <Trash2 size={15} /> Delete {selected.size > 0 ? `${selected.size} selected` : 'selected'}
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ── Offices tab ──────────────────────────────────────────────────
function OfficeSettingsPanel({ office, onSaved, showToast }) {
  const [timezone, setTimezone] = useState(office.timezone || 'Asia/Dubai')
  const [deadline, setDeadline] = useState((office.timesheet_deadline || '18:00').slice(0, 5))
  const [saving, setSaving]     = useState(false)

  const dirty = timezone !== (office.timezone || 'Asia/Dubai') || deadline !== (office.timesheet_deadline || '18:00').slice(0, 5)

  async function save() {
    setSaving(true)
    const { error } = await supabase.rpc('upsert_office', {
      p_id: office.id, p_name: office.name, p_is_active: office.is_active,
      p_timezone: timezone, p_deadline: deadline,
    })
    setSaving(false)
    if (error) { showToast('Error: ' + error.message); return }
    showToast('Office settings saved.')
    onSaved()
  }

  return (
    <div className="px-5 py-3 space-y-3 bg-gray-50 dark:bg-gray-800/50">
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Timezone">
          <select value={timezone} onChange={e => setTimezone(e.target.value)} className="input text-sm">
            {TIMEZONE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Daily timesheet deadline">
          <input type="time" value={deadline} onChange={e => setDeadline(e.target.value)} className="input text-sm" />
        </Field>
      </div>
      <p className="text-xs text-gray-400">
        Timesheets submitted after this time (in the office's own timezone) are flagged as late in the daily reminder — submission is never blocked.
      </p>
      <button onClick={save} disabled={saving || !dirty} className="btn-primary text-xs px-3 py-1.5">
        {saving ? '…' : <><Check size={13} /> Save</>}
      </button>
    </div>
  )
}

function OfficeRow({ office, onSaved, showToast }) {
  const [editing, setEditing]   = useState(false)
  const [name, setName]         = useState(office.name)
  const [saving, setSaving]     = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  async function rename() {
    if (!name.trim() || name.trim() === office.name) { setEditing(false); setName(office.name); return }
    setSaving(true)
    const { error } = await supabase.rpc('upsert_office', { p_id: office.id, p_name: name.trim(), p_is_active: office.is_active })
    setSaving(false)
    setEditing(false)
    if (error) { showToast('Error: ' + error.message); return }
    onSaved()
  }

  async function toggleActive() {
    setSaving(true)
    const { error } = await supabase.rpc('upsert_office', { p_id: office.id, p_name: office.name, p_is_active: !office.is_active })
    setSaving(false)
    if (error) { showToast('Error: ' + error.message); return }
    onSaved()
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 px-5 py-3">
        {editing ? (
          <input
            autoFocus value={name} onChange={e => setName(e.target.value)}
            onBlur={rename} onKeyDown={e => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') { setEditing(false); setName(office.name) } }}
            className="input text-sm py-1 max-w-[220px]"
          />
        ) : (
          <button onClick={() => setEditing(true)} className="flex items-center gap-2 text-left group">
            <span className={clsx('text-sm font-medium', !office.is_active && 'text-gray-400 line-through')}>{office.name}</span>
            <Pencil size={11} className="text-gray-300 group-hover:text-gray-500 transition-colors" />
          </button>
        )}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setShowSettings(s => !s)}
            title="Timezone & deadline"
            className={clsx('p-1.5 rounded-md transition-colors', showSettings ? 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800')}
          >
            <Clock size={13} />
          </button>
          <button
            onClick={toggleActive}
            disabled={saving}
            className={clsx('text-xs font-medium px-2 py-0.5 rounded-full transition-colors',
              office.is_active
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 hover:bg-emerald-200'
                : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200')}
          >
            {office.is_active ? 'Active' : 'Inactive'}
          </button>
        </div>
      </div>
      {showSettings && <OfficeSettingsPanel office={office} onSaved={onSaved} showToast={showToast} />}
    </div>
  )
}

function EmployeeOfficeEditor({ employee, offices, onSaved, showToast }) {
  const [additional, setAdditional] = useState(employee.additional_office_ids || [])
  const [seesAll, setSeesAll]       = useState(!!employee.sees_all_offices)
  const [saving, setSaving]         = useState(false)

  const otherOffices = offices.filter(o => o.id !== employee.office_id).map(o => ({ value: o.id, label: o.name }))
  const dirty = JSON.stringify([...additional].sort()) !== JSON.stringify([...(employee.additional_office_ids || [])].sort())
    || seesAll !== !!employee.sees_all_offices

  async function save() {
    setSaving(true)
    const { error } = await supabase.rpc('set_employee_offices', {
      p_employees: [employee.id], p_home: employee.office_id, p_additional: additional, p_sees_all: seesAll,
    })
    setSaving(false)
    if (error) { showToast('Error: ' + error.message); return }
    onSaved()
  }

  return (
    <div className="px-5 py-3 space-y-2 bg-gray-50 dark:bg-gray-800/50">
      <Field label="Additional offices">
        <MultiSelect options={otherOffices} value={additional} onChange={setAdditional} placeholder="None" />
      </Field>
      <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
        <Checkbox checked={seesAll} onChange={() => setSeesAll(v => !v)} />
        Sees all offices (bypasses office restrictions entirely)
      </label>
      <button onClick={save} disabled={saving || !dirty} className="btn-primary text-xs px-3 py-1.5">
        {saving ? '…' : <><Check size={13} /> Save</>}
      </button>
    </div>
  )
}

function OfficesTab({ offices, users, onOfficesChanged, showToast }) {
  const [newName, setNewName]           = useState('')
  const [creating, setCreating]         = useState(false)
  const [bulkOffice, setBulkOffice]     = useState('')
  const [bulkEmployees, setBulkEmployees] = useState([])
  const [bulkSaving, setBulkSaving]     = useState(false)
  const [rosterOffice, setRosterOffice] = useState('')
  const [rosterSearch, setRosterSearch] = useState('')
  const [rosterPage, setRosterPage]     = useState(1)
  const [expanded, setExpanded]         = useState(null)

  const officeName = new Map(offices.map(o => [o.id, o.name]))
  const employeeOptions = users.map(u => ({ value: u.id, label: u.full_name || u.email, sublabel: u.email }))

  async function createOffice(e) {
    e.preventDefault()
    if (!newName.trim()) return
    setCreating(true)
    const { error } = await supabase.rpc('upsert_office', { p_id: null, p_name: newName.trim(), p_is_active: true })
    setCreating(false)
    if (error) { showToast('Error: ' + error.message); return }
    setNewName('')
    onOfficesChanged()
  }

  async function assignBulk() {
    if (!bulkOffice || bulkEmployees.length === 0) return
    setBulkSaving(true)
    const { error } = await supabase.rpc('set_employee_offices', {
      p_employees: bulkEmployees, p_home: bulkOffice, p_additional: null, p_sees_all: null,
    })
    setBulkSaving(false)
    if (error) { showToast('Error: ' + error.message); return }
    setBulkEmployees([])
    showToast(`Home office set for ${bulkEmployees.length} employee${bulkEmployees.length !== 1 ? 's' : ''}.`)
    onOfficesChanged()
  }

  const rosterAll = rosterOffice ? users.filter(u => u.office_id === rosterOffice) : []
  const rosterFiltered = rosterAll.filter(u => {
    if (!rosterSearch) return true
    const q = rosterSearch.toLowerCase()
    return (u.full_name || '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
  })
  const rosterTotalPages = Math.max(1, Math.ceil(rosterFiltered.length / PAGE_SIZE))
  const rosterCurrentPage = Math.min(rosterPage, rosterTotalPages)
  const rosterShown = rosterFiltered.slice((rosterCurrentPage - 1) * PAGE_SIZE, rosterCurrentPage * PAGE_SIZE)

  return (
    <div className="space-y-6">
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800">
          <h2 className="font-semibold text-sm">Offices</h2>
          <p className="text-xs text-gray-400 mt-0.5">Every profile and project belongs to one home office. Click a name to rename it.</p>
        </div>
        <form onSubmit={createOffice} className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 flex gap-2">
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New office name (e.g. Dubai)" className="input text-sm flex-1" />
          <button type="submit" disabled={creating || !newName.trim()} className="btn-primary text-sm flex-shrink-0">
            <UserPlus size={14} /> Add
          </button>
        </form>
        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {offices.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No offices yet.</p>
          ) : offices.map(o => (
            <OfficeRow key={o.id} office={o} onSaved={onOfficesChanged} showToast={showToast} />
          ))}
        </div>
      </div>

      <div className="card p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-sm">Bulk-assign home office</h2>
          <p className="text-xs text-gray-400 mt-0.5">Moves the selected employees' home office. Their additional offices and sees-all-offices flag are left untouched.</p>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Office">
            <select value={bulkOffice} onChange={e => setBulkOffice(e.target.value)} className="input text-sm">
              <option value="">Select office…</option>
              {offices.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </Field>
          <Field label="Employees">
            <MultiSelect options={employeeOptions} value={bulkEmployees} onChange={setBulkEmployees} placeholder="Select employees…" showSelectAll />
          </Field>
        </div>
        <button onClick={assignBulk} disabled={bulkSaving || !bulkOffice || bulkEmployees.length === 0} className="btn-primary text-sm">
          {bulkSaving ? '…' : <><Check size={14} /> Assign {bulkEmployees.length > 0 ? bulkEmployees.length : ''}</>}
        </button>
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 space-y-3">
          <div>
            <h2 className="font-semibold text-sm">Roster</h2>
            <p className="text-xs text-gray-400 mt-0.5">Pick an office to see who calls it home, and set additional offices or sees-all-offices per employee.</p>
          </div>
          <div className="flex gap-2">
            <select value={rosterOffice} onChange={e => { setRosterOffice(e.target.value); setRosterPage(1); setExpanded(null) }} className="input text-sm flex-shrink-0 max-w-[200px]">
              <option value="">Select office…</option>
              {offices.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            {rosterOffice && (
              <div className="relative flex-1">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  value={rosterSearch} onChange={e => { setRosterSearch(e.target.value); setRosterPage(1) }}
                  placeholder="Search…" className="input text-sm pl-8 py-1.5"
                />
              </div>
            )}
          </div>
        </div>
        {!rosterOffice ? (
          <p className="text-sm text-gray-400 text-center py-8">Select an office to view its roster.</p>
        ) : rosterShown.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-8">No employees found.</p>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {rosterShown.map(u => (
              <div key={u.id}>
                <button
                  onClick={() => setExpanded(prev => prev === u.id ? null : u.id)}
                  className="w-full flex items-center justify-between gap-3 px-5 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{u.full_name || u.email}</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {(u.additional_office_ids || []).map(id => (
                        <span key={id} className="text-xs px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500">
                          +{officeName.get(id) || '—'}
                        </span>
                      ))}
                      {u.sees_all_offices && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-ae7-light text-ae7-red dark:bg-ae7-red/10">
                          Sees all offices
                        </span>
                      )}
                    </div>
                  </div>
                  {expanded === u.id ? <ChevronUp size={14} className="text-gray-400 flex-shrink-0" /> : <ChevronDown size={14} className="text-gray-400 flex-shrink-0" />}
                </button>
                {expanded === u.id && (
                  <EmployeeOfficeEditor employee={u} offices={offices} onSaved={onOfficesChanged} showToast={showToast} />
                )}
              </div>
            ))}
          </div>
        )}
        <Pagination page={rosterCurrentPage} totalPages={rosterTotalPages} onChange={setRosterPage} />
      </div>
    </div>
  )
}

// ── Reminder settings card (Settings tab) ──────────────────────────
function ReminderSettingsCard({ settings, profileId, users, showToast, onSaved }) {
  const [hour, setHour]     = useState(settings?.reminder_hour ?? 9)
  const [backlog, setBacklog] = useState(settings?.reminder_backlog_days ?? 14)
  const [saving, setSaving] = useState(false)
  const [testSending, setTestSending] = useState(false)
  const [testUserId, setTestUserId] = useState('')   // '' = preview the logged-in admin
  const [testEmail, setTestEmail]   = useState('')   // '' = deliver to that user's own (possibly fake) email

  // settings loads asynchronously after this component first mounts, so
  // the useState initializer above only sees it on the lucky render where
  // it's already resolved — sync local state whenever the loaded value
  // actually changes (initial load, and after a save round-trips through
  // the parent's reload).
  useEffect(() => {
    if (!settings) return
    setHour(settings.reminder_hour)
    setBacklog(settings.reminder_backlog_days)
  }, [settings?.reminder_hour, settings?.reminder_backlog_days])

  const dirty = Number(hour) !== settings?.reminder_hour || Number(backlog) !== settings?.reminder_backlog_days

  async function toggleEnabled() {
    if (!settings) return
    setSaving(true)
    const next = !settings.reminder_enabled
    const { error } = await supabase
      .from('app_settings')
      .update({ reminder_enabled: next, updated_by: profileId })
      .eq('id', 1)
    setSaving(false)
    if (error) { showToast('Error: ' + error.message); return }
    showToast(next ? 'Timesheet reminders enabled.' : 'Timesheet reminders disabled.')
    onSaved()
  }

  async function saveNumbers() {
    setSaving(true)
    const { error } = await supabase
      .from('app_settings')
      .update({ reminder_hour: Number(hour), reminder_backlog_days: Number(backlog), updated_by: profileId })
      .eq('id', 1)
    setSaving(false)
    if (error) { showToast('Error: ' + error.message); return }
    showToast('Reminder settings saved.')
    onSaved()
  }

  // Fires a one-off email to the current admin using today's live data,
  // bypassing both the hourly send-time gate and reminder_log's once-per-
  // day guarantee — otherwise every config tweak costs a full day's wait
  // to see whether it worked.
  async function sendTest() {
    setTestSending(true)
    const { data, error } = await supabase.functions.invoke('test-timesheet-reminder', {
      body: {
        targetUserId: testUserId || undefined,
        deliverTo: testEmail.trim() || undefined,
      },
    })
    setTestSending(false)
    if (error) {
      // On a non-2xx response supabase-js returns data: null and puts the
      // raw Response on error.context — our function's own { error } body
      // (the actually useful message) lives there, not on `error` itself.
      let message = error.message
      if (error.context?.json) {
        try { message = (await error.context.json())?.error || message } catch { /* body wasn't JSON */ }
      }
      showToast('Error: ' + message)
      return
    }
    showToast(`Sent to ${data.to} — previewing ${data.previewing} (${data.ownRows} of theirs, ${data.teamRows} team, ${data.officeRows} office rows).`)
  }

  return (
    <div className="card p-5 space-y-4 max-w-lg">
      <div>
        <h2 className="font-semibold text-sm mb-1">Timesheet reminders</h2>
        <p className="text-xs text-gray-400">
          Each morning, employees with outstanding timesheets — and their managers and HR — get an emailed summary. Sent once per person per day, at the hour below in THEIR OWN office's timezone.
        </p>
      </div>
      <div className="flex items-center justify-between gap-4 py-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Send daily reminders</p>
          <p className="text-xs text-gray-400 mt-0.5">Off disables the whole job — nothing is sent or logged.</p>
        </div>
        <button
          onClick={toggleEnabled}
          disabled={saving || !settings}
          role="switch"
          aria-checked={!!settings?.reminder_enabled}
          className={clsx(
            'relative w-11 h-6 rounded-full transition-colors flex-shrink-0 disabled:opacity-50',
            settings?.reminder_enabled ? 'bg-ae7-red' : 'bg-gray-300 dark:bg-gray-700'
          )}
        >
          <span className={clsx('absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform', settings?.reminder_enabled && 'translate-x-5')} />
        </button>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Send hour (office-local)">
          <input type="number" min="0" max="23" value={hour} onChange={e => setHour(e.target.value)} className="input text-sm" />
        </Field>
        <Field label="Backlog window (days)">
          <input type="number" min="1" max="90" value={backlog} onChange={e => setBacklog(e.target.value)} className="input text-sm" />
        </Field>
      </div>
      <button onClick={saveNumbers} disabled={saving || !dirty} className="btn-secondary text-sm">
        {saving ? '…' : <><Check size={14} /> Save</>}
      </button>

      <div className="border-t border-gray-100 dark:border-gray-800 pt-4 space-y-3">
        <div>
          <p className="text-sm font-medium">Send a test email</p>
          <p className="text-xs text-gray-400 mt-0.5">
            Builds a real report for the selected user (their own/team/office rows, right now) and sends it once — never logged, never blocked by the once-per-day guarantee. Useful since the emails in your data may not be real mailboxes: leave "Deliver to" blank to send to that user's own address, or override it to route the preview anywhere you can actually check.
          </p>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Preview as">
            <select value={testUserId} onChange={e => setTestUserId(e.target.value)} className="input text-sm">
              <option value="">Me</option>
              {[...users].sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email)).map(u => (
                <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
              ))}
            </select>
          </Field>
          <Field label="Deliver to (optional)">
            <input
              type="email"
              value={testEmail}
              onChange={e => setTestEmail(e.target.value)}
              placeholder="defaults to their own email"
              className="input text-sm"
            />
          </Field>
        </div>
        <button onClick={sendTest} disabled={testSending} className="btn-secondary text-sm">
          {testSending ? '…' : <><Send size={14} /> Send test email</>}
        </button>
      </div>
    </div>
  )
}

// ── Reminder log viewer (Settings tab) ──────────────────────────────
const REMINDER_LOG_WINDOW_HOURS = 48

function ReminderLogCard() {
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError('')
    const { data, error: err } = await supabase.rpc('reminder_log_recent', { p_hours: REMINDER_LOG_WINDOW_HOURS })
    setLoading(false)
    if (err) { setError(err.message); return }
    setRows(data || [])
  }

  const sent   = rows.filter(r => r.status === 'sent').length
  const failed = rows.filter(r => r.status === 'failed').length
  const pending = rows.filter(r => r.status === 'pending').length

  const statusColor = {
    sent: 'text-emerald-600 dark:text-emerald-400',
    failed: 'text-red-600 dark:text-red-400',
    pending: 'text-amber-600 dark:text-amber-400',
  }

  return (
    <div className="card p-5 space-y-4 max-w-2xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-sm mb-1">Recent reminder runs</h2>
          <p className="text-xs text-gray-400">
            Last {REMINDER_LOG_WINDOW_HOURS} hours — {sent} sent, {failed} failed{pending ? `, ${pending} pending` : ''}.
          </p>
        </div>
        <button onClick={load} disabled={loading} className="btn-secondary text-xs flex-shrink-0">
          <RefreshCw size={13} className={clsx(loading && 'animate-spin')} /> Refresh
        </button>
      </div>

      <ErrorBox msg={error} />

      {!loading && rows.length === 0 && !error && (
        <p className="text-sm text-gray-400 py-4 text-center">No reminder activity in this window.</p>
      )}

      {rows.length > 0 && (
        <div className="max-h-80 overflow-y-auto -mx-1">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-400 border-b border-gray-100 dark:border-gray-800">
                <th className="px-1 py-1.5 font-medium">Recipient</th>
                <th className="px-1 py-1.5 font-medium">Business date</th>
                <th className="px-1 py-1.5 font-medium">Status</th>
                <th className="px-1 py-1.5 font-medium">Sent at</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-b border-gray-50 dark:border-gray-800/50">
                  <td className="px-1 py-1.5">{r.recipient_email}</td>
                  <td className="px-1 py-1.5">{r.business_date}</td>
                  <td className={clsx('px-1 py-1.5 font-medium', statusColor[r.status])} title={r.error || ''}>
                    {r.status}
                  </td>
                  <td className="px-1 py-1.5 text-gray-400">{format(new Date(r.sent_at), 'dd MMM HH:mm')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────
export default function AdminPage() {
  const { profile }                       = useAuth()
  const [users, setUsers]                 = useState([])
  const [search, setSearch]               = useState('')
  const [userPage, setUserPage]           = useState(1)
  const [loading, setLoading]             = useState(true)
  const [pendingAll, setPendingAll]        = useState([])
  const [activeTab, setActiveTab]         = useState('users')
  const [toast, setToast]                 = useState('')
  const [showCreateModal, setShowCreate]  = useState(false)
  const [showBulkImport, setShowBulkImport] = useState(false)
  const [editTarget, setEditTarget]       = useState(null)   // user object to edit
  const [tsTarget, setTsTarget]           = useState(null)   // user to manage timesheets for
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [deleting, setDeleting]           = useState(false)
  const [settings, setSettings]           = useState(null)
  const [savingSettings, setSavingSettings] = useState(false)
  const [offices, setOffices]             = useState([])
  const [cycleRunning, setCycleRunning]   = useState(false)

  useEffect(() => { loadUsers(); loadPending(); loadSettings(); loadOffices() }, [])

  async function loadSettings() {
    const { data } = await supabase.from('app_settings').select('*').eq('id', 1).single()
    setSettings(data)
  }

  async function loadOffices() {
    const { data } = await supabase.from('offices').select('*').order('name')
    if (data) setOffices(data)
  }

  async function runLeaveCycle() {
    setCycleRunning(true)
    const { data, error } = await supabase.rpc('run_leave_cycle', { p_employee: null })
    setCycleRunning(false)
    if (error) { showToast('Error: ' + error.message); return }
    showToast(`Leave cycle done — ${data} balance${data === 1 ? '' : 's'} granted or refreshed, across all offices.`)
  }

  async function toggleXlsxUpload() {
    if (!settings) return
    setSavingSettings(true)
    const next = !settings.xlsx_upload_enabled
    const { error } = await supabase
      .from('app_settings')
      .update({ xlsx_upload_enabled: next, updated_by: profile.id })
      .eq('id', 1)
    setSavingSettings(false)
    if (error) { showToast('Error: ' + error.message); return }
    setSettings(prev => ({ ...prev, xlsx_upload_enabled: next }))
    showToast(next ? 'XLSX upload enabled.' : 'XLSX upload disabled.')
  }

  async function loadUsers() {
    const { data } = await supabase.from('profiles').select('*').order('created_at', { ascending: false })
    if (data) setUsers(data)
    setLoading(false)
  }

  async function loadPending() {
    const { data } = await supabase
      .from('timesheets')
      .select('*, profiles!employee_id(full_name, email)')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(50)
    if (data) setPendingAll(data)
  }

  async function deleteUser(userId) {
    setDeleting(true)
    try {
      await invokeFn('delete-user', { userId })
      setDeleting(false)
      setConfirmDelete(null)
      setUsers(prev => prev.filter(u => u.id !== userId))
      showToast('User deleted permanently.')
    } catch (err) {
      setDeleting(false)
      setConfirmDelete(null)
      showToast('Error: ' + err.message)
    }
  }

  async function forceDecision(tsId, status, reason = null) {
    const { error } = await supabase.from('timesheets').update({
      status,
      reviewer_id: profile.id,
      rejection_reason: reason,
    }).eq('id', tsId)
    if (error) { showToast('Error: ' + error.message); return }
    setPendingAll(prev => prev.filter(t => t.id !== tsId))
    showToast(status === 'approved' ? 'Approved.' : 'Rejected.')
  }

  function showToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(''), 2500)
  }

  const filtered = users.filter(u => {
    if (!search) return true
    const q = search.toLowerCase()
    return (u.full_name || '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
  })
  const userTotalPages  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const userCurrentPage = Math.min(userPage, userTotalPages)
  const shown           = filtered.slice((userCurrentPage - 1) * PAGE_SIZE, userCurrentPage * PAGE_SIZE)

  function handleSearch(v) { setSearch(v); setUserPage(1) }

  return (
    <div className="space-y-6 max-w-4xl">
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg animate-fade-in">
          {toast}
        </div>
      )}

      {showCreateModal && (
        <CreateUserModal
          offices={offices}
          onClose={() => setShowCreate(false)}
          onCreated={() => { loadUsers(); showToast('User account created.') }}
        />
      )}

      {showBulkImport && (
        <BulkImportUsersModal
          onClose={() => setShowBulkImport(false)}
          onImported={loadUsers}
        />
      )}

      {editTarget && (
        <EditUserModal
          user={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={(updated) => {
            setUsers(prev => prev.map(u => u.id === updated.id ? { ...u, ...updated } : u))
            showToast('User updated.')
          }}
        />
      )}

      {tsTarget && (
        <UserTimesheetsModal
          user={tsTarget}
          onClose={() => setTsTarget(null)}
          onDeleted={(count) => showToast(`${count} timesheet${count !== 1 ? 's' : ''} deleted.`)}
        />
      )}

      <div>
        <h1 className="page-title">IT Admin Panel</h1>
        <p className="page-subtitle">Manage users, roles, timesheets, and override decisions.</p>
      </div>

      <Tabs
        tabs={[
          { key: 'users', label: 'Users' },
          { key: 'timesheets', label: 'Timesheets' },
          { key: 'offices', label: 'Offices' },
          { key: 'settings', label: 'Settings' },
        ]}
        active={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === 'users' && (
        <>
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text" value={search}
                onChange={e => handleSearch(e.target.value)}
                className="input pl-9"
                placeholder="Search users…"
              />
            </div>
            <button onClick={() => setShowBulkImport(true)} className="btn-secondary flex-shrink-0">
              <Upload size={15} /> Bulk import
            </button>
            <button onClick={() => setShowCreate(true)} className="btn-primary flex-shrink-0">
              <UserPlus size={15} /> Create user
            </button>
          </div>

          <div className="card overflow-hidden">
            <div className="hidden sm:grid sm:grid-cols-12 gap-4 px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-100 dark:border-gray-800">
              <span className="col-span-5">User</span>
              <span className="col-span-2">Role</span>
              <span className="col-span-2">Joined</span>
              <span className="col-span-3"></span>
            </div>

            {loading ? (
              <SkeletonList rows={6} />
            ) : shown.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">No users found.</div>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {shown.map(u => {
                  const isSelf     = u.id === profile.id
                  const isDelConf  = confirmDelete === u.id

                  return (
                    <div key={u.id} className="flex sm:grid sm:grid-cols-12 gap-3 sm:gap-4 items-center px-5 py-3.5 min-h-[60px]">
                      {/* User info */}
                      <div className="sm:col-span-5 flex items-center gap-2 min-w-0 flex-1">
                        <div className="w-8 h-8 rounded-full bg-ae7-red/10 flex items-center justify-center text-ae7-red text-xs font-semibold flex-shrink-0">
                          {(u.full_name || u.email || '?')[0].toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {u.full_name || '(No name)'}
                            {isSelf && <span className="ml-1.5 text-xs text-ae7-red font-normal">You</span>}
                          </p>
                          <p className="text-xs text-gray-400 truncate">{u.email}</p>
                        </div>
                      </div>

                      {/* Roles */}
                      <div className="sm:col-span-2 flex flex-wrap gap-1 flex-shrink-0">
                        {(u.roles || (u.role ? [u.role] : [])).map(r => (
                          <span key={r} className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', roleBadge[r] || roleBadge.employee)}>
                            {roleDisplay[r] || r}
                          </span>
                        ))}
                      </div>

                      {/* Joined */}
                      <span className="sm:col-span-2 text-xs text-gray-400 hidden sm:block">
                        {format(new Date(u.created_at), 'MMM d, yyyy')}
                      </span>

                      {/* Actions */}
                      <div className="sm:col-span-3 flex items-center justify-end gap-1 flex-shrink-0">
                        {isDelConf ? (
                          <>
                            <button
                              onClick={() => deleteUser(u.id)}
                              disabled={deleting}
                              className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap"
                            >
                              {deleting ? '…' : 'Confirm delete'}
                            </button>
                            <button
                              onClick={() => setConfirmDelete(null)}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                            >
                              <X size={13} />
                            </button>
                          </>
                        ) : (
                          <>
                            {/* Edit */}
                            <button
                              onClick={() => setEditTarget(u)}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-ae7-red hover:bg-ae7-light dark:hover:bg-ae7-red/10 transition-colors"
                              title="Edit user"
                            >
                              <Pencil size={14} />
                            </button>
                            {/* Manage timesheets */}
                            <button
                              onClick={() => setTsTarget(u)}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/20 transition-colors"
                              title="Manage timesheets"
                            >
                              <FileText size={14} />
                            </button>
                            {/* Delete user */}
                            {!isSelf && (
                              <button
                                onClick={() => setConfirmDelete(u.id)}
                                className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors"
                                title="Delete user permanently"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            <Pagination page={userCurrentPage} totalPages={userTotalPages} onChange={setUserPage} />
          </div>

          <div className="flex items-start gap-2 text-xs text-gray-400 px-1">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5 text-amber-500" />
            Deleting a user is permanent and removes all their data. The email address can be reused.
          </div>
        </>
      )}

      {activeTab === 'timesheets' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
            <h2 className="font-semibold text-sm">All pending timesheets</h2>
            <span className="text-xs bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 px-2 py-0.5 rounded-full">
              {pendingAll.length} waiting
            </span>
          </div>
          {pendingAll.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">No pending timesheets.</div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {pendingAll.map(t => (
                <div key={t.id} className="flex items-center justify-between gap-4 px-5 py-3.5 flex-wrap">
                  <div>
                    <p className="text-sm font-medium">{t.profiles?.full_name || t.profiles?.email}</p>
                    <p className="text-xs text-gray-400">{format(new Date(t.date), 'MMM d, yyyy')} · {t.total_hours}h</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => forceDecision(t.id, 'approved')}
                      className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors"
                    >
                      <CheckCircle size={13} /> Approve
                    </button>
                    <button
                      onClick={() => {
                        const reason = prompt('Rejection reason (required):')
                        if (reason) forceDecision(t.id, 'rejected', reason)
                      }}
                      className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-xl bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
                    >
                      <XCircle size={13} /> Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'offices' && (
        <OfficesTab
          offices={offices}
          users={users}
          onOfficesChanged={() => { loadOffices(); loadUsers() }}
          showToast={showToast}
        />
      )}

      {activeTab === 'settings' && (
        <div className="space-y-6">
        <div className="card p-5 space-y-4 max-w-lg">
          <div>
            <h2 className="font-semibold text-sm mb-1">Timesheet entry</h2>
            <p className="text-xs text-gray-400">Control which submission methods employees can use.</p>
          </div>
          <div className="flex items-center justify-between gap-4 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">Allow XLSX timesheet upload</p>
              <p className="text-xs text-gray-400 mt-0.5">
                In-app entry is always available. When this is on, employees may also upload an Excel file instead.
              </p>
            </div>
            <button
              onClick={toggleXlsxUpload}
              disabled={savingSettings || !settings}
              role="switch"
              aria-checked={!!settings?.xlsx_upload_enabled}
              className={clsx(
                'relative w-11 h-6 rounded-full transition-colors flex-shrink-0 disabled:opacity-50',
                settings?.xlsx_upload_enabled ? 'bg-ae7-red' : 'bg-gray-300 dark:bg-gray-700'
              )}
            >
              <span
                className={clsx(
                  'absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform',
                  settings?.xlsx_upload_enabled && 'translate-x-5'
                )}
              />
            </button>
          </div>
        </div>

        <div className="card p-5 space-y-4 max-w-lg">
          <div>
            <h2 className="font-semibold text-sm mb-1">Leave cycle</h2>
            <p className="text-xs text-gray-400">
              Grants or refreshes every employee's leave balance for their current anniversary cycle, across every office. Safe to run repeatedly — already-granted cycles are skipped.
            </p>
          </div>
          <button onClick={runLeaveCycle} disabled={cycleRunning} className="btn-secondary text-sm">
            <RefreshCw size={14} className={clsx(cycleRunning && 'animate-spin')} />
            {cycleRunning ? 'Running…' : 'Run leave cycle for all offices'}
          </button>
        </div>

        <ReminderSettingsCard settings={settings} profileId={profile.id} users={users} onSaved={loadSettings} showToast={showToast} />
        <ReminderLogCard />
        </div>
      )}
    </div>
  )
}

// ── Shared UI primitives ──────────────────────────────────────────

function Modal({ title, icon, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className={clsx('bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-800 w-full flex flex-col max-h-[90vh]', wide ? 'max-w-lg' : 'max-w-md')}>
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            {icon}
            <h3 className="font-semibold text-sm">{title}</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  )
}

function PasswordInput({ value, onChange, show, onToggle, placeholder = '' }) {
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="input pr-10"
        placeholder={placeholder}
      />
      <button
        type="button"
        onClick={onToggle}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
        tabIndex={-1}
      >
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  )
}

function Checkbox({ checked, indeterminate = false, onChange }) {
  return (
    <button
      type="button"
      onClick={onChange}
      className={clsx(
        'w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors',
        checked || indeterminate
          ? 'bg-ae7-red border-ae7-red'
          : 'border-gray-300 dark:border-gray-600 hover:border-ae7-red'
      )}
    >
      {indeterminate && !checked && (
        <span className="w-2 h-0.5 bg-white rounded-full" />
      )}
      {checked && <Check size={10} className="text-white" strokeWidth={3} />}
    </button>
  )
}

function ErrorBox({ msg }) {
  if (!msg) return null
  return (
    <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-xl px-3 py-2">
      <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
      {msg}
    </div>
  )
}

function Spinner() {
  return <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
}
