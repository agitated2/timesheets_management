import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  Shield, Search, CheckCircle, XCircle, UserPlus, Trash2, X,
  Eye, EyeOff, AlertTriangle, Pencil, FileText, ChevronDown,
  ChevronUp, Calendar, Check,
} from 'lucide-react'
import { format, parseISO } from 'date-fns'
import clsx from 'clsx'

const ROLES = ['employee', 'manager', 'hr', 'c_suite', 'it']

const roleBadge = {
  employee: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  manager:  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  hr:       'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  c_suite:  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  it:       'bg-ae7-light text-ae7-red dark:bg-ae7-red/10 dark:text-red-300',
}

const statusBadge = {
  pending:  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  approved: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
}

async function getSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

// ── Create User Modal ─────────────────────────────────────────────
function CreateUserModal({ onClose, onCreated }) {
  const [email, setEmail]           = useState('')
  const [password, setPassword]     = useState('')
  const [confirmPw, setConfirmPw]   = useState('')
  const [fullName, setFullName]     = useState('')
  const [role, setRole]             = useState('employee')
  const [showPw, setShowPw]         = useState(false)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')

  async function handleCreate(e) {
    e.preventDefault()
    setError('')
    if (password !== confirmPw) { setError('Passwords do not match.'); return }
    setLoading(true)
    const session = await getSession()
    const res = await fetch('/.netlify/functions/create-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password, fullName: fullName.trim(), role }),
    })
    const json = await res.json()
    setLoading(false)
    if (!res.ok) { setError(json.error); return }
    onCreated()
    onClose()
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

        <Field label="Password *">
          <PasswordInput value={password} onChange={setPassword} show={showPw} onToggle={() => setShowPw(v => !v)} placeholder="Min. 6 characters" />
        </Field>

        <Field label="Confirm password *">
          <input type={showPw ? 'text' : 'password'} value={confirmPw} onChange={e => setConfirmPw(e.target.value)} className="input" placeholder="Repeat password" required />
        </Field>

        <Field label="Initial role">
          <select value={role} onChange={e => setRole(e.target.value)} className={clsx('input text-sm font-medium', roleBadge[role])}>
            {ROLES.map(r => <option key={r} value={r}>{r.replace('_', '-')}</option>)}
          </select>
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
  const [email, setEmail]         = useState(target.email || '')
  const [fullName, setFullName]   = useState(target.full_name || '')
  const [role, setRole]           = useState(target.role || 'employee')
  const [managerId, setManagerId] = useState(target.manager_id || '')
  const [newPassword, setNewPw]   = useState('')
  const [showPw, setShowPw]       = useState(false)
  const [managers, setManagers]   = useState([])
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')

  useEffect(() => {
    supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('role', ['manager', 'c_suite'])
      .order('full_name')
      .then(({ data }) => { if (data) setManagers(data) })
  }, [])

  async function handleSave(e) {
    e.preventDefault()
    if (newPassword && newPassword.length < 6) { setError('New password must be at least 6 characters.'); return }
    setError('')
    setLoading(true)

    const session = await getSession()
    const body = { userId: target.id }
    if (email.trim().toLowerCase() !== target.email) body.email = email.trim().toLowerCase()
    if (fullName.trim() !== (target.full_name || ''))  body.fullName  = fullName.trim()
    if (role !== target.role)                           body.role      = role
    if (managerId !== (target.manager_id || ''))        body.managerId = managerId || null
    if (newPassword)                                    body.newPassword = newPassword

    const res = await fetch('/.netlify/functions/update-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    setLoading(false)
    if (!res.ok) { setError(json.error); return }
    onSaved({ ...target, email: body.email ?? target.email, full_name: body.fullName ?? target.full_name, role: body.role ?? target.role, manager_id: body.managerId !== undefined ? body.managerId : target.manager_id })
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

        <Field label="Role">
          <select value={role} onChange={e => setRole(e.target.value)} className={clsx('input text-sm font-medium', roleBadge[role])}>
            {ROLES.map(r => <option key={r} value={r}>{r.replace('_', '-')}</option>)}
          </select>
        </Field>

        <Field label="Line manager">
          <select value={managerId} onChange={e => setManagerId(e.target.value)} className="input text-sm">
            <option value="">— None —</option>
            {managers.map(m => (
              <option key={m.id} value={m.id}>{m.full_name || m.email}</option>
            ))}
          </select>
        </Field>

        <Field label={<>Reset password <span className="font-normal text-gray-400">(leave blank to keep current)</span></>}>
          <PasswordInput value={newPassword} onChange={setNewPw} show={showPw} onToggle={() => setShowPw(v => !v)} placeholder="New password (optional)" />
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
    const session = await getSession()
    const res = await fetch('/.netlify/functions/delete-timesheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ timesheetIds: [...selected], userId: target.id, notify }),
    })
    const json = await res.json()
    setDeleting(false)
    if (!res.ok) { setError(json.error); return }
    onDeleted(json.deleted)
    onClose()
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
          <div className="py-10 text-center text-sm text-gray-400">Loading…</div>
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

// ── Main page ─────────────────────────────────────────────────────
export default function AdminPage() {
  const { profile }                       = useAuth()
  const [users, setUsers]                 = useState([])
  const [search, setSearch]               = useState('')
  const [loading, setLoading]             = useState(true)
  const [pendingAll, setPendingAll]        = useState([])
  const [activeTab, setActiveTab]         = useState('users')
  const [toast, setToast]                 = useState('')
  const [showCreateModal, setShowCreate]  = useState(false)
  const [editTarget, setEditTarget]       = useState(null)   // user object to edit
  const [tsTarget, setTsTarget]           = useState(null)   // user to manage timesheets for
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [deleting, setDeleting]           = useState(false)

  useEffect(() => { loadUsers(); loadPending() }, [])

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
    const session = await getSession()
    const res = await fetch('/.netlify/functions/delete-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
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
          onClose={() => setShowCreate(false)}
          onCreated={() => { loadUsers(); showToast('User account created.') }}
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
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Shield size={22} className="text-ae7-red" /> IT Admin Panel
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          Manage users, roles, timesheets, and override decisions.
        </p>
      </div>

      <div className="flex gap-2">
        {['users', 'timesheets'].map(t => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={clsx(
              'px-4 py-2 rounded-xl text-sm font-medium transition-colors capitalize',
              activeTab === t
                ? 'bg-ae7-red text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
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
              <input
                type="text" value={search}
                onChange={e => setSearch(e.target.value)}
                className="input pl-9"
                placeholder="Search users…"
              />
            </div>
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
              <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
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

                      {/* Role */}
                      <div className="sm:col-span-2 flex-shrink-0">
                        <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', roleBadge[u.role])}>
                          {u.role.replace('_', '-')}
                        </span>
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
    </div>
  )
}

// ── Shared UI primitives ──────────────────────────────────────────

function Modal({ title, icon, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className={clsx('bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full', wide ? 'max-w-lg' : 'max-w-md')}>
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-2">
            {icon}
            <h3 className="font-semibold text-sm">{title}</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={18} />
          </button>
        </div>
        {children}
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
