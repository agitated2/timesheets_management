import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { Shield, Search, CheckCircle, XCircle, UserPlus, Trash2, X, Eye, EyeOff, AlertTriangle } from 'lucide-react'
import { format } from 'date-fns'
import clsx from 'clsx'

const ROLES = ['employee', 'manager', 'hr', 'c_suite', 'it']

const roleBadge = {
  employee: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  manager:  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  hr:       'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  c_suite:  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  it:       'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

// ── Create User Modal ─────────────────────────────────────────────
function CreateUserModal({ onClose, onCreated }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState('employee')
  const [showPw, setShowPw] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleCreate(e) {
    e.preventDefault()
    setError('')
    if (password !== confirmPassword) { setError('Passwords do not match.'); return }

    setLoading(true)
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/.netlify/functions/create-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password, fullName: fullName.trim(), role }),
    })
    const json = await res.json()
    setLoading(false)
    if (!res.ok) { setError(json.error); return }
    onCreated()
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <UserPlus size={18} className="text-blue-500" />
            <h3 className="font-semibold">Create user account</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleCreate} className="p-6 space-y-4">
          <div className="bg-blue-50 dark:bg-blue-950/20 rounded-xl px-4 py-3 text-xs text-blue-700 dark:text-blue-300">
            The account is created pre-verified — no confirmation email is sent. The user can sign in immediately with these credentials.
          </div>

          <div>
            <label className="label" htmlFor="cu-email">Email <span className="text-red-500">*</span></label>
            <input id="cu-email" type="email" value={email} onChange={e => setEmail(e.target.value)} className="input" placeholder="user@company.com" required autoFocus />
          </div>

          <div>
            <label className="label" htmlFor="cu-name">Full name <span className="text-gray-400 font-normal">(optional)</span></label>
            <input id="cu-name" type="text" value={fullName} onChange={e => setFullName(e.target.value)} className="input" placeholder="Jane Smith" />
          </div>

          <div>
            <label className="label" htmlFor="cu-pw">Password <span className="text-red-500">*</span></label>
            <div className="relative">
              <input
                id="cu-pw"
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="input pr-10"
                placeholder="Min. 6 characters"
                required
                minLength={6}
              />
              <button type="button" onClick={() => setShowPw(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" tabIndex={-1}>
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <div>
            <label className="label" htmlFor="cu-cpw">Confirm password <span className="text-red-500">*</span></label>
            <input
              id="cu-cpw"
              type={showPw ? 'text' : 'password'}
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              className="input"
              placeholder="Repeat password"
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="cu-role">Initial role</label>
            <select id="cu-role" value={role} onChange={e => setRole(e.target.value)} className={clsx('input text-sm font-medium', roleBadge[role])}>
              {ROLES.map(r => <option key={r} value={r}>{r.replace('_', '-')}</option>)}
            </select>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-xl px-3 py-2">
              <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
            <button type="submit" disabled={loading} className="btn-primary flex-1">
              {loading ? (
                <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Creating…</>
              ) : (
                <><UserPlus size={15} /> Create account</>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────
export default function AdminPage() {
  const { profile } = useAuth()
  const [users, setUsers] = useState([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [pendingAll, setPendingAll] = useState([])
  const [activeTab, setActiveTab] = useState('users')
  const [toast, setToast] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null) // userId or null
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    loadUsers()
    loadPending()
  }, [])

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

  async function changeRole(userId, newRole) {
    const { error } = await supabase.from('profiles').update({ role: newRole }).eq('id', userId)
    if (error) { showToast('Error: ' + error.message); return }
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u))
    showToast('Role updated.')
  }

  async function deleteUser(userId) {
    setDeleting(true)
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/.netlify/functions/delete-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ userId }),
    })
    const json = await res.json()
    setDeleting(false)
    setConfirmDelete(null)
    if (!res.ok) { showToast('Error: ' + json.error); return }
    setUsers(prev => prev.filter(u => u.id !== userId))
    showToast('User deleted permanently.')
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

  const shown = users.filter(u => {
    if (!search) return true
    const q = search.toLowerCase()
    return (u.full_name || '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
  })

  return (
    <div className="space-y-6 max-w-4xl">
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg animate-fade-in">
          {toast}
        </div>
      )}

      {showCreateModal && (
        <CreateUserModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => { loadUsers(); showToast('User account created.') }}
        />
      )}

      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Shield size={22} className="text-red-500" /> IT Admin Panel
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Manage users, roles, and override timesheets.</p>
      </div>

      <div className="flex gap-2">
        {['users', 'timesheets'].map(t => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={clsx(
              'px-4 py-2 rounded-xl text-sm font-medium transition-colors capitalize',
              activeTab === t ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {activeTab === 'users' && (
        <>
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input type="text" value={search} onChange={e => setSearch(e.target.value)} className="input pl-9" placeholder="Search users…" />
            </div>
            <button
              onClick={() => setShowCreateModal(true)}
              className="btn-primary flex-shrink-0"
            >
              <UserPlus size={15} /> Create user
            </button>
          </div>

          <div className="card overflow-hidden">
            <div className="hidden sm:grid sm:grid-cols-12 gap-4 px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-100 dark:border-gray-800">
              <span className="col-span-5">User</span>
              <span className="col-span-3">Role</span>
              <span className="col-span-2">Joined</span>
              <span className="col-span-2"></span>
            </div>

            {loading ? (
              <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
            ) : shown.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">No users found.</div>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {shown.map(u => {
                  const isSelf = u.id === profile.id
                  const isDeleteConfirm = confirmDelete === u.id

                  return (
                    <div key={u.id} className="flex sm:grid sm:grid-cols-12 gap-3 sm:gap-4 items-center px-5 py-3.5 min-h-[60px]">
                      {/* User info */}
                      <div className="sm:col-span-5 flex items-center gap-2 min-w-0 flex-1">
                        <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400 text-xs font-semibold flex-shrink-0">
                          {(u.full_name || u.email || '?')[0].toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {u.full_name || '(No name)'}
                            {isSelf && <span className="ml-1.5 text-xs text-blue-500 font-normal">You</span>}
                          </p>
                          <p className="text-xs text-gray-400 truncate">{u.email}</p>
                        </div>
                      </div>

                      {/* Role */}
                      <div className="sm:col-span-3 flex-shrink-0">
                        <select
                          value={u.role}
                          onChange={e => changeRole(u.id, e.target.value)}
                          disabled={isSelf}
                          className={clsx(
                            'text-xs font-medium px-2 py-1 rounded-lg border-0 focus:ring-2 focus:ring-blue-500 cursor-pointer',
                            roleBadge[u.role],
                            isSelf && 'opacity-60 cursor-not-allowed'
                          )}
                        >
                          {ROLES.map(r => <option key={r} value={r}>{r.replace('_', '-')}</option>)}
                        </select>
                      </div>

                      {/* Joined */}
                      <span className="sm:col-span-2 text-xs text-gray-400 hidden sm:block">
                        {format(new Date(u.created_at), 'MMM d, yyyy')}
                      </span>

                      {/* Delete */}
                      <div className="sm:col-span-2 flex items-center justify-end gap-1.5 flex-shrink-0">
                        {!isSelf && (
                          isDeleteConfirm ? (
                            <>
                              <button
                                onClick={() => deleteUser(u.id)}
                                disabled={deleting}
                                className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap"
                              >
                                {deleting ? '…' : 'Confirm'}
                              </button>
                              <button
                                onClick={() => setConfirmDelete(null)}
                                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                              >
                                <X size={13} />
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => setConfirmDelete(u.id)}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors"
                              title="Delete user permanently"
                            >
                              <Trash2 size={14} />
                            </button>
                          )
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Delete warning note */}
          <div className="flex items-start gap-2 text-xs text-gray-400 px-1">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5 text-amber-500" />
            Deleting a user is permanent and removes all their timesheets and data. The email address can be reused to create a new account.
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
    </div>
  )
}
