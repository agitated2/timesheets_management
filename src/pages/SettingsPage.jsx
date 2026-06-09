import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  User, Shield, Search, CheckCircle, ChevronDown,
  Save, Info, Users, AlertCircle, Lock, Eye, EyeOff
} from 'lucide-react'
import { format } from 'date-fns'
import clsx from 'clsx'

// ----------------------------------------------------------------
// Role config
// ----------------------------------------------------------------
const ROLES = ['employee', 'manager', 'hr', 'c_suite', 'it']

const roleDisplay = {
  employee: 'Employee',
  manager:  'Manager',
  hr:       'HR',
  c_suite:  'C-Suite',
  it:       'IT Admin',
}

const roleBadge = {
  employee: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  manager:  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  hr:       'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  c_suite:  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  it:       'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

const roleDescription = {
  employee: 'Can upload timesheets and view their own history.',
  manager:  'Can approve/reject subordinates\' timesheets and view team analytics.',
  hr:       'Universal read access, global analytics, and file downloads.',
  c_suite:  'Universal read access + acts as a line manager for approval workflows.',
  it:       'Full override access including manual approval of any timesheet.',
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
  const [name, setName]         = useState(profile.full_name || '')
  const [managers, setManagers] = useState([])
  const [managerId]             = useState(profile.manager_id || '')
  const [saving, setSaving]     = useState(false)
  const [saved, setSaved]       = useState(false)

  const isEmployee = profile.role === 'employee'

  useEffect(() => {
    if (!isEmployee) return
    supabase
      .from('profiles')
      .select('id, full_name, email, role')
      .in('role', ['manager', 'c_suite'])
      .order('full_name')
      .then(({ data }) => { if (data) setManagers(data) })
  }, [isEmployee])

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    const { error } = await supabase.from('profiles').update({ full_name: name.trim() }).eq('id', profile.id)
    setSaving(false)
    if (!error) { setSaved(true); setTimeout(() => setSaved(false), 2000); await refreshProfile() }
  }

  const currentManager = managers.find(m => m.id === managerId)

  return (
    <section className="card p-6 space-y-5">
      <div className="flex items-center gap-2">
        <User size={18} className="text-blue-500" />
        <h2 className="font-semibold">Profile</h2>
      </div>

      <form onSubmit={save} className="space-y-4">
        {/* Read-only account info */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
            <p className="text-xs text-gray-400 mb-0.5">Email</p>
            <p className="text-sm font-medium truncate">{profile.email}</p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
            <p className="text-xs text-gray-400 mb-0.5">Role</p>
            <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', roleBadge[profile.role])}>
              {roleDisplay[profile.role]}
            </span>
          </div>
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

        {/* Line manager — read-only after onboarding */}
        {isEmployee && (
          <div>
            <label className="label">Line manager</label>
            {currentManager && (
              <div className="flex items-center gap-2 mb-3 text-sm text-gray-500 dark:text-gray-400">
                <CheckCircle size={14} className="text-emerald-500" />
                Currently: <span className="font-medium text-gray-900 dark:text-gray-100">{currentManager.full_name || currentManager.email}</span>
              </div>
            )}
            <div className="flex items-start gap-2.5 bg-blue-50 dark:bg-blue-950/20 rounded-xl p-3">
              <Info size={14} className="text-blue-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-blue-700 dark:text-blue-300">
                To change your line manager, please contact your IT department.
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button type="submit" disabled={saving || !name.trim()} className="btn-primary">
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
    <section className="card p-6 space-y-5">
      <div className="flex items-center gap-2">
        <Lock size={18} className="text-blue-500" />
        <h2 className="font-semibold">Password</h2>
      </div>
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
  const [loading, setLoading] = useState(true)
  const [toast, setToast]     = useState({ msg: '', type: 'info' })
  const [pending, setPending] = useState({}) // userId → newRole (unsaved)
  const [saving, setSaving]   = useState({}) // userId → bool

  useEffect(() => {
    supabase
      .from('profiles')
      .select('id, email, full_name, role, created_at, onboarding_complete')
      .order('created_at', { ascending: false })
      .then(({ data }) => { if (data) setUsers(data); setLoading(false) })
  }, [])

  function showToast(msg, type = 'info') {
    setToast({ msg, type })
    setTimeout(() => setToast({ msg: '', type: 'info' }), 2800)
  }

  function stagePendingRole(userId, newRole) {
    setPending(p => ({ ...p, [userId]: newRole }))
  }

  async function saveRole(userId) {
    const newRole = pending[userId]
    if (!newRole) return
    setSaving(s => ({ ...s, [userId]: true }))
    const { error } = await supabase.from('profiles').update({ role: newRole }).eq('id', userId)
    setSaving(s => ({ ...s, [userId]: false }))
    if (error) {
      showToast('Failed to update role: ' + error.message, 'error')
    } else {
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u))
      setPending(p => { const n = { ...p }; delete n[userId]; return n })
      showToast(`Role updated to ${roleDisplay[newRole]}.`, 'success')
    }
  }

  function cancelPending(userId) {
    setPending(p => { const n = { ...p }; delete n[userId]; return n })
  }

  const shown = users.filter(u => {
    if (!search) return true
    const q = search.toLowerCase()
    return (u.full_name || '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
  })

  return (
    <section className="card overflow-hidden">
      <div className="px-6 py-5 border-b border-gray-100 dark:border-gray-800 space-y-3">
        <div className="flex items-center gap-2">
          <Shield size={18} className="text-red-500" />
          <h2 className="font-semibold">User Role Management</h2>
        </div>

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
            onChange={e => setSearch(e.target.value)}
            className="input pl-9 text-sm"
            placeholder="Search by name or email…"
          />
        </div>
      </div>

      {loading ? (
        <div className="p-8 text-center text-gray-400 text-sm">Loading users…</div>
      ) : shown.length === 0 ? (
        <div className="p-8 text-center text-gray-400 text-sm">No users found.</div>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {shown.map(u => {
            const effectiveRole = pending[u.id] ?? u.role
            const hasChange = !!pending[u.id]
            const isSelf = u.id === currentUser.id

            return (
              <div key={u.id} className={clsx(
                'flex flex-col sm:flex-row sm:items-center gap-3 px-6 py-4 transition-colors',
                hasChange && 'bg-amber-50/40 dark:bg-amber-950/10'
              )}>
                {/* User info */}
                <div className="flex items-center gap-3 flex-1 min-w-0">
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

                {/* Role selector + actions */}
                <div className="flex items-center gap-2 flex-shrink-0 sm:ml-auto">
                  {hasChange && (
                    <AlertCircle size={15} className="text-amber-500 flex-shrink-0" title="Unsaved change" />
                  )}

                  <div className="relative">
                    <select
                      value={effectiveRole}
                      disabled={isSelf}
                      onChange={e => stagePendingRole(u.id, e.target.value)}
                      className={clsx(
                        'appearance-none text-xs font-medium pl-3 pr-7 py-2 rounded-xl border transition-colors cursor-pointer',
                        'focus:outline-none focus:ring-2 focus:ring-blue-500',
                        isSelf
                          ? 'opacity-50 cursor-not-allowed bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700'
                          : hasChange
                          ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300'
                          : clsx(roleBadge[effectiveRole], 'border-transparent')
                      )}
                    >
                      {ROLES.map(r => (
                        <option key={r} value={r}>{roleDisplay[r]}</option>
                      ))}
                    </select>
                    <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-current opacity-60" />
                  </div>

                  {hasChange && !isSelf && (
                    <>
                      <button
                        onClick={() => saveRole(u.id)}
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
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

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
  const isIT = profile?.role === 'it'

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          Manage your profile and password{isIT ? ', and user roles' : ''}.
        </p>
      </div>

      <ProfileSection profile={profile} refreshProfile={refreshProfile} />

      <PasswordSection />

      {isIT && <RoleManagementSection />}
    </div>
  )
}
