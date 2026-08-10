import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  User, Shield, Search, CheckCircle,
  Save, Info, Users, AlertCircle, Lock, Eye, EyeOff,
  ChevronLeft, ChevronRight, Building2,
} from 'lucide-react'
import { format } from 'date-fns'
import clsx from 'clsx'
import { SkeletonList } from '../components/Skeleton'

const PAGE_SIZE = 10

function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null
  return (
    <div className="flex items-center justify-between px-6 py-3 border-t border-gray-100 dark:border-gray-800 text-sm">
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

// ----------------------------------------------------------------
// Role config
// ----------------------------------------------------------------
const ROLES = ['employee', 'manager', 'hr', 'c_suite', 'it', 'global_analytics', 'team_analytics', 'projects_control']

const roleDisplay = {
  employee:         'Employee',
  manager:          'Manager',
  hr:               'HR',
  c_suite:          'C-Suite',
  it:               'IT Admin',
  global_analytics: 'Global Analytics',
  team_analytics:   'Team Analytics',
  projects_control: 'Projects Control',
}

const roleBadge = {
  employee:         'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  manager:          'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  hr:               'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  c_suite:          'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  it:               'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  global_analytics: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  team_analytics:   'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  projects_control: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
}

const roleDescription = {
  employee:         'Can upload timesheets and view their own history.',
  manager:          'Can approve/reject timesheets for employees who chose them as manager.',
  hr:               'Universal read access and file downloads.',
  c_suite:          'Universal read access + acts as a line manager for approval workflows.',
  it:               'Full override access including manual approval of any timesheet.',
  global_analytics: 'Can view analytics and reports for all employees across the organization.',
  team_analytics:   'Can view analytics for employees who have chosen them as their manager.',
  projects_control: 'Can manage projects, stages, and team assignments in the Projects portal.',
}

// ----------------------------------------------------------------
// Toast helper (self-contained)
// ----------------------------------------------------------------
function Toast({ message, type }) {
  if (!message) return null
  const colors = {
    success: 'bg-emerald-600 text-white',
    error:   'bg-red-600 text-white',
    info:    'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900',
  }
  return (
    <div className={clsx(
      'fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl shadow-lg text-sm font-medium animate-fade-in',
      colors[type] ?? colors.info
    )}>
      {message}
    </div>
  )
}

// ----------------------------------------------------------------
// Profile section — all roles
// ----------------------------------------------------------------
function ProfileSection({ profile, refreshProfile }) {
  const [name, setName]                   = useState(profile.full_name || '')
  const [assignedManagers, setAssignedMgrs] = useState([])
  const [officeName, setOfficeName]       = useState('')
  const [saving, setSaving]               = useState(false)
  const [saved, setSaved]                 = useState(false)
  const hasChanges = name.trim() !== (profile.full_name || '')

  const isEmployee = Array.isArray(profile.roles) ? profile.roles.includes('employee') : profile.role === 'employee'
  const isIT       = Array.isArray(profile.roles) ? profile.roles.includes('it') : profile.role === 'it'
  const managerIds = profile.manager_ids || []

  useEffect(() => {
    if (!isEmployee || managerIds.length === 0) return
    supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('id', managerIds)
      .then(({ data }) => { if (data) setAssignedMgrs(data) })
  }, [isEmployee, managerIds.join(',')])

  useEffect(() => {
    if (!profile.office_id) return
    supabase.from('offices').select('name').eq('id', profile.office_id).single()
      .then(({ data }) => setOfficeName(data?.name || ''))
  }, [profile.office_id])

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    const { error } = await supabase.from('profiles').update({ full_name: name.trim() }).eq('id', profile.id)
    setSaving(false)
    if (!error) { setSaved(true); setTimeout(() => setSaved(false), 2000); await refreshProfile() }
  }

  return (
    <section className="p-6 space-y-5">
      <h2 className="text-sm font-semibold">Profile</h2>

      <form onSubmit={save} className="space-y-4">
        {/* Read-only account info */}
        <div className={clsx('grid grid-cols-1 gap-3', isIT ? 'sm:grid-cols-4' : 'sm:grid-cols-3')}>
          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
            <p className="text-xs text-gray-400 mb-0.5">Email</p>
            <p className="text-sm font-medium truncate">{profile.email}</p>
          </div>
          {officeName && (
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
              <p className="text-xs text-gray-400 mb-0.5 flex items-center gap-1"><Building2 size={11} /> Office</p>
              <p className="text-sm font-medium truncate">{officeName}</p>
            </div>
          )}
          {isIT && (
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
              <p className="text-xs text-gray-400 mb-0.5">Roles</p>
              <div className="flex flex-wrap gap-1 mt-0.5">
                {(profile.roles || [profile.role]).map(r => (
                  <span key={r} className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', roleBadge[r] || 'bg-gray-100 text-gray-600')}>
                    {roleDisplay[r] || r}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
            <p className="text-xs text-gray-400 mb-0.5">Member since</p>
            <p className="text-sm font-medium">{format(new Date(profile.created_at), 'MMM d, yyyy')}</p>
          </div>
        </div>

        {/* Editable name */}
        <div>
          <label className="label" htmlFor="full-name">Full name</label>
          <input
            id="full-name"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="input"
            placeholder="Your full name"
            required
          />
        </div>

        {/* Line managers — read-only, set by IT */}
        {isEmployee && (
          <div>
            <label className="label">Line manager{assignedManagers.length !== 1 ? 's' : ''}</label>
            {assignedManagers.length > 0 ? (
              <div className="space-y-1.5 mb-3">
                {assignedManagers.map(m => (
                  <div key={m.id} className="flex items-center gap-2 text-sm">
                    <CheckCircle size={12} className="text-emerald-500 flex-shrink-0" />
                    <span className="font-medium text-gray-900 dark:text-gray-100">{m.full_name || m.email}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400 italic mb-3">No line manager assigned yet.</p>
            )}
            <div className="flex items-start gap-2.5 bg-blue-50 dark:bg-blue-950/20 rounded-xl p-3">
              <Info size={14} className="text-blue-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-blue-700 dark:text-blue-300">
                Line manager assignments are managed by your IT department.
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button type="submit" disabled={saving || !name.trim() || !hasChanges} className="btn-primary">
            {saving ? (
              <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</>
            ) : saved ? (
              <><CheckCircle size={15} /> Saved!</>
            ) : (
              <><Save size={15} /> Save changes</>
            )}
          </button>
        </div>
      </form>
    </section>
  )
}

// ----------------------------------------------------------------
// Password section — all roles
// ----------------------------------------------------------------
function PasswordSection() {
  const [newPassword, setNewPassword]   = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPw, setShowPw]             = useState(false)
  const [saving, setSaving]             = useState(false)
  const [saved, setSaved]               = useState(false)
  const [error, setError]               = useState('')

  async function handleSave(e) {
    e.preventDefault()
    setError('')
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return }
    if (newPassword.length < 6) { setError('Password must be at least 6 characters.'); return }
    setSaving(true)
    const { error: err } = await supabase.auth.updateUser({ password: newPassword })
    setSaving(false)
    if (err) { setError(err.message); return }
    setSaved(true)
    setNewPassword('')
    setConfirmPassword('')
    setTimeout(() => setSaved(false), 3000)
  }

  return (
    <section className="p-6 space-y-5">
      <h2 className="text-sm font-semibold">Password</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 -mt-2">
        Set or change your password. If you sign in with email links, you can set a password here to use credentials instead.
      </p>

      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <label className="label" htmlFor="new-pw">New password</label>
          <div className="relative">
            <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              id="new-pw"
              type={showPw ? 'text' : 'password'}
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="input pl-9 pr-10"
              placeholder="Min. 6 characters"
              required
              minLength={6}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPw(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              tabIndex={-1}
            >
              {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="confirm-pw">Confirm new password</label>
          <input
            id="confirm-pw"
            type={showPw ? 'text' : 'password'}
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            className="input"
            placeholder="Repeat password"
            required
            autoComplete="new-password"
          />
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <button type="submit" disabled={saving || !newPassword || !confirmPassword} className="btn-primary">
          {saving ? (
            <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</>
          ) : saved ? (
            <><CheckCircle size={15} /> Password updated!</>
          ) : (
            <><Save size={15} /> Update password</>
          )}
        </button>
      </form>
    </section>
  )
}

// ----------------------------------------------------------------
// Role management — IT only
// ----------------------------------------------------------------
function RoleManagementSection() {
  const { profile: currentUser } = useAuth()
  const [users, setUsers]     = useState([])
  const [search, setSearch]   = useState('')
  const [page, setPage]       = useState(1)
  const [loading, setLoading] = useState(true)
  const [toast, setToast]     = useState({ msg: '', type: 'info' })
  const [pending, setPending] = useState({}) // userId → newRole (unsaved)
  const [saving, setSaving]   = useState({}) // userId → bool

  useEffect(() => {
    supabase
      .from('profiles')
      .select('id, email, full_name, role, roles, created_at, onboarding_complete')
      .order('created_at', { ascending: false })
      .then(({ data }) => { if (data) setUsers(data); setLoading(false) })
  }, [])

  function showToast(msg, type = 'info') {
    setToast({ msg, type })
    setTimeout(() => setToast({ msg: '', type: 'info' }), 2800)
  }

  function togglePendingRole(userId, role) {
    const base = users.find(u => u.id === userId)
    const currentRoles = pending[userId] ?? (base?.roles || (base?.role ? [base.role] : []))
    const newRoles = currentRoles.includes(role)
      ? currentRoles.filter(r => r !== role)
      : [...currentRoles, role]
    setPending(p => ({ ...p, [userId]: newRoles }))
  }

  async function saveRoles(userId) {
    const newRoles = pending[userId]
    if (!newRoles) return
    setSaving(s => ({ ...s, [userId]: true }))
    const { error } = await supabase.from('profiles').update({ roles: newRoles }).eq('id', userId)
    setSaving(s => ({ ...s, [userId]: false }))
    if (error) {
      showToast('Failed to update roles: ' + error.message, 'error')
    } else {
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, roles: newRoles } : u))
      setPending(p => { const n = { ...p }; delete n[userId]; return n })
      showToast('Roles updated.', 'success')
    }
  }

  function cancelPending(userId) {
    setPending(p => { const n = { ...p }; delete n[userId]; return n })
  }

  const filtered = users.filter(u => {
    if (!search) return true
    const q = search.toLowerCase()
    return (u.full_name || '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
  })

  const totalPages  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const shown       = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  function handleSearch(v) { setSearch(v); setPage(1) }

  return (
    <section className="card overflow-hidden">
      <div className="px-6 py-5 border-b border-gray-100 dark:border-gray-800 space-y-3">
        <h2 className="text-sm font-semibold">User role management</h2>

        {/* Default role note */}
        <div className="flex items-start gap-2.5 bg-blue-50 dark:bg-blue-950/20 rounded-xl p-3">
          <Info size={15} className="text-blue-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-blue-700 dark:text-blue-300">
            All new registrations are assigned the <strong>Employee</strong> role by default. Promote users here after they sign up.
          </p>
        </div>

        {/* Search */}
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={e => handleSearch(e.target.value)}
            className="input pl-9 text-sm"
            placeholder="Search by name or email…"
          />
        </div>
      </div>

      {loading ? (
        <SkeletonList rows={6} />
      ) : filtered.length === 0 ? (
        <div className="p-8 text-center text-gray-400 text-sm">No users found.</div>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {shown.map(u => {
            const effectiveRoles = pending[u.id] ?? (u.roles || [u.role])
            const hasChange = !!pending[u.id]
            const isSelf = u.id === currentUser.id

            return (
              <div key={u.id} className={clsx(
                'flex flex-col gap-3 px-6 py-4 transition-colors',
                hasChange && 'bg-amber-50/40 dark:bg-amber-950/10'
              )}>
                {/* User info */}
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400 text-sm font-semibold flex-shrink-0">
                    {(u.full_name || u.email || '?')[0].toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium truncate">{u.full_name || '(Name not set)'}</p>
                      {!u.onboarding_complete && (
                        <span className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded-md">Setup pending</span>
                      )}
                      {isSelf && (
                        <span className="text-xs text-blue-500 font-medium">You</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 truncate">{u.email}</p>
                  </div>
                </div>

                {/* Role pills + actions */}
                <div className="flex flex-col gap-2">
                  {hasChange && (
                    <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                      <AlertCircle size={12} />
                      <span>Unsaved changes</span>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {ROLES.map(r => {
                      const active = effectiveRoles.includes(r)
                      return (
                        <button
                          key={r}
                          type="button"
                          disabled={isSelf}
                          onClick={() => togglePendingRole(u.id, r)}
                          className={clsx(
                            'text-xs font-medium px-2.5 py-1 rounded-full border transition-colors',
                            active
                              ? clsx(roleBadge[r], 'border-transparent')
                              : 'border-gray-200 dark:border-gray-600 text-gray-400 dark:text-gray-500 hover:border-ae7-red/50 hover:text-gray-600 dark:hover:text-gray-300',
                            isSelf && 'opacity-50 cursor-not-allowed pointer-events-none'
                          )}
                        >
                          {roleDisplay[r]}
                        </button>
                      )
                    })}
                  </div>
                  {hasChange && !isSelf && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => saveRoles(u.id)}
                        disabled={saving[u.id]}
                        className="text-xs font-semibold px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
                      >
                        {saving[u.id] ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => cancelPending(u.id)}
                        className="text-xs font-medium px-2.5 py-1.5 rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Pagination page={currentPage} totalPages={totalPages} onChange={setPage} />

      {/* Role descriptions */}
      <div className="px-6 py-5 border-t border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Role permissions</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {ROLES.map(r => (
            <div key={r} className="flex items-start gap-2">
              <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 mt-0.5', roleBadge[r])}>
                {roleDisplay[r]}
              </span>
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-snug">{roleDescription[r]}</p>
            </div>
          ))}
        </div>
      </div>

      <Toast message={toast.msg} type={toast.type} />
    </section>
  )
}

// ----------------------------------------------------------------
// Page
// ----------------------------------------------------------------
export default function SettingsPage() {
  const { profile, refreshProfile } = useAuth()
  const isIT = Array.isArray(profile?.roles) ? profile.roles.includes('it') : profile?.role === 'it'

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="page-title">Settings</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          Manage your profile and password{isIT ? ', and user roles' : ''}.
        </p>
      </div>

      <div className="card divide-y divide-gray-100 dark:divide-gray-800">
        <ProfileSection profile={profile} refreshProfile={refreshProfile} />
        <PasswordSection />
      </div>

      {isIT && <RoleManagementSection />}
    </div>
  )
}
