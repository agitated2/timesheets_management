import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { UserCircle, Search, CheckCircle } from 'lucide-react'

export default function OnboardingPage() {
  const { user, profile, refreshProfile } = useAuth()
  const navigate = useNavigate()

  const [fullName, setFullName]           = useState(profile?.full_name || '')
  const [managers, setManagers]           = useState([])
  const [managerSearch, setManagerSearch] = useState('')
  const [selectedManager, setSelectedManager] = useState(null)
  const [loading, setLoading]             = useState(false)
  const [error, setError]                 = useState('')

  useEffect(() => {
    supabase
      .from('profiles')
      .select('id, full_name, email, roles')
      .filter('roles', 'ov', '{manager,c_suite}')
      .order('full_name')
      .then(({ data }) => setManagers(data ?? []))
  }, [])

  const filteredManagers = managers.filter(m => {
    const q = managerSearch.toLowerCase()
    return (m.full_name || '').toLowerCase().includes(q) || m.email.toLowerCase().includes(q)
  })

  async function handleSubmit(e) {
    e.preventDefault()
    if (!fullName.trim()) { setError('Please enter your full name.'); return }
    setError('')
    setLoading(true)

    const updates = {
      full_name: fullName.trim(),
      onboarding_complete: true,
      ...(selectedManager && { manager_id: selectedManager.id, manager_ids: [selectedManager.id] }),
    }

    const { error: err } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', user.id)

    setLoading(false)
    if (err) { setError(err.message); return }
    await refreshProfile()
    navigate('/dashboard')
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-950 dark:to-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 mb-4 shadow-lg">
            <UserCircle size={26} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Set up your profile</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Just a couple of things before you get started.
          </p>
        </div>

        <div className="card p-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="label" htmlFor="fullName">Full name</label>
              <input
                id="fullName"
                type="text"
                value={fullName}
                onChange={e => setFullName(e.target.value)}
                className="input"
                placeholder="Jane Smith"
                required
                autoFocus
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="label mb-0">Line manager <span className="text-gray-400 font-normal">(if applicable)</span></label>
                {selectedManager && (
                  <button type="button" onClick={() => { setSelectedManager(null); setManagerSearch('') }} className="text-xs text-gray-400 hover:text-red-500 transition-colors">
                    Clear
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-400 mb-2">
                Select who will review your timesheets. To change or add more managers later, contact your IT department.
              </p>

              {selectedManager ? (
                <div className="flex items-center justify-between p-3 rounded-xl border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30">
                  <div className="flex items-center gap-2">
                    <CheckCircle size={16} className="text-emerald-500" />
                    <span className="text-sm font-medium">{selectedManager.full_name || selectedManager.email}</span>
                    <span className="text-xs text-gray-500">
                      ({(selectedManager.roles || []).includes('c_suite') ? 'C-Suite' : 'Manager'})
                    </span>
                  </div>
                  <button type="button" onClick={() => { setSelectedManager(null); setManagerSearch('') }} className="text-xs text-red-500 hover:underline">
                    Change
                  </button>
                </div>
              ) : (
                <>
                  <div className="relative mb-2">
                    <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="text"
                      value={managerSearch}
                      onChange={e => setManagerSearch(e.target.value)}
                      className="input pl-9"
                      placeholder="Search by name or email…"
                    />
                  </div>
                  {managerSearch && (
                    <div className="max-h-48 overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
                      {filteredManagers.length === 0 ? (
                        <p className="text-sm text-gray-400 text-center py-4">No managers found</p>
                      ) : filteredManagers.map(m => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => { setSelectedManager(m); setManagerSearch('') }}
                          className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                        >
                          <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center text-blue-600 dark:text-blue-400 text-sm font-semibold flex-shrink-0">
                            {(m.full_name || m.email)[0].toUpperCase()}
                          </div>
                          <div>
                            <p className="text-sm font-medium">{m.full_name || '(No name)'}</p>
                            <p className="text-xs text-gray-400">
                              {m.email} · {(m.roles || []).includes('c_suite') ? 'C-Suite' : 'Manager'}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

            <button type="submit" disabled={loading} className="btn-primary w-full mt-2">
              {loading ? 'Saving…' : 'Continue to dashboard'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
