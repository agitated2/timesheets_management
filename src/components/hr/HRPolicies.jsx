import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Tags, Plus, Check, Power, CalendarClock, Building2 } from 'lucide-react'
import MultiSelect from '../MultiSelect'
import clsx from 'clsx'
import { SkeletonList } from '../Skeleton'

// ── One category's leave policy (default days/year + rollover) ────
function PolicyRow({ category, policy, onSaved }) {
  const [defaultDays, setDefaultDays]   = useState(policy?.default_days_per_year ?? 0)
  const [rolloverEnabled, setRollover]  = useState(policy?.rollover_enabled ?? false)
  const [cap, setCap]                   = useState(policy?.rollover_cap ?? '')
  const [expiryMonths, setExpiryMonths] = useState(policy?.rollover_expiry_months ?? '')
  const [saving, setSaving]             = useState(false)
  const [error, setError]               = useState('')

  const dirty = !policy
    || Number(defaultDays) !== Number(policy.default_days_per_year ?? 0)
    || rolloverEnabled !== !!policy.rollover_enabled
    || String(cap) !== String(policy.rollover_cap ?? '')
    || String(expiryMonths) !== String(policy.rollover_expiry_months ?? '')

  async function save() {
    setSaving(true); setError('')
    const { error: err } = await supabase.rpc('upsert_leave_policy', {
      p_category: category.id,
      p_default_days: Number(defaultDays) || 0,
      p_rollover_enabled: rolloverEnabled,
      p_rollover_cap: rolloverEnabled && cap !== '' ? Number(cap) : null,
      p_rollover_expiry_months: rolloverEnabled && expiryMonths !== '' ? Number(expiryMonths) : null,
    })
    setSaving(false)
    if (err) { setError(err.message); return }
    onSaved()
  }

  return (
    <div className="px-5 py-3.5 border-b border-gray-100 dark:border-gray-800 last:border-b-0 space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-sm font-medium min-w-0 truncate">{category.name}</span>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-gray-500">
            Days/year
            <input type="number" min="0" step="0.5" value={defaultDays} onChange={e => setDefaultDays(e.target.value)} className="input text-sm w-20 py-1" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
            <input type="checkbox" checked={rolloverEnabled} onChange={e => setRollover(e.target.checked)} className="rounded" />
            Rollover
          </label>
          {rolloverEnabled && (
            <>
              <label className="flex items-center gap-1.5 text-xs text-gray-500">
                Cap
                <input type="number" min="0" step="0.5" value={cap} onChange={e => setCap(e.target.value)} placeholder="uncapped" className="input text-sm w-20 py-1" />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-500">
                Expires (months)
                <input type="number" min="1" step="1" value={expiryMonths} onChange={e => setExpiryMonths(e.target.value)} placeholder="never" className="input text-sm w-20 py-1" />
              </label>
            </>
          )}
          <button onClick={save} disabled={saving || !dirty} className="btn-primary text-xs px-2.5 py-1.5">
            {saving ? '…' : <Check size={13} />}
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}

export default function HRPolicies() {
  const { profile, hasRole } = useAuth()
  const canPickOffice = hasRole('it') || !!profile?.sees_all_offices

  const [offices, setOffices] = useState([])
  const [officeId, setOfficeId] = useState(profile?.office_id || '')
  const [categories, setCategories] = useState([])
  const [policies, setPolicies]     = useState([])
  const [employees, setEmployees]   = useState([])
  const [loading, setLoading]       = useState(true)

  // new category
  const [newName, setNewName]   = useState('')
  const [newPaid, setNewPaid]   = useState(true)
  const [savingCat, setSavingCat] = useState(false)
  const [catError, setCatError] = useState('')

  // balance assignment
  const [balCat, setBalCat]     = useState('')
  const [balMode, setBalMode]   = useState('set')   // 'set' | 'add' | 'subtract'
  const [balEmps, setBalEmps]   = useState([])
  const [balAmount, setBalAmount] = useState('')
  const [savingBal, setSavingBal] = useState(false)
  const [balMsg, setBalMsg]     = useState('')
  const [balOk, setBalOk]       = useState(true)

  useEffect(() => {
    supabase.from('offices').select('id, name').order('name').then(({ data }) => setOffices(data || []))
  }, [])

  const load = useCallback(async () => {
    if (!officeId) { setLoading(false); return }
    const [cats, profs, pols] = await Promise.all([
      supabase.from('leave_categories').select('*').eq('office_id', officeId).order('name'),
      supabase.from('profiles').select('id, full_name, email').eq('office_id', officeId).order('full_name'),
      supabase.from('leave_policies').select('*'),
    ])
    setCategories(cats.data || [])
    setEmployees(profs.data || [])
    setPolicies(pols.data || [])
    if (cats.data?.length) setBalCat(cats.data.find(c => c.is_paid)?.id || cats.data[0].id)
    else setBalCat('')
    setLoading(false)
  }, [officeId])

  useEffect(() => { load() }, [load])

  const employeeOptions = useMemo(
    () => employees.map(e => ({ value: e.id, label: e.full_name || e.email, sublabel: e.email })),
    [employees]
  )
  const policyByCategory = useMemo(() => new Map(policies.map(p => [p.category_id, p])), [policies])
  const paidCategories = useMemo(() => categories.filter(c => c.is_paid), [categories])

  async function addCategory(e) {
    e.preventDefault()
    setCatError(''); setSavingCat(true)
    const { error } = await supabase.from('leave_categories').insert({ name: newName.trim(), is_paid: newPaid, office_id: officeId })
    setSavingCat(false)
    if (error) { setCatError(error.message); return }
    setNewName(''); setNewPaid(true)
    load()
  }

  async function toggleActive(cat) {
    await supabase.from('leave_categories').update({ is_active: !cat.is_active }).eq('id', cat.id)
    load()
  }

  async function saveBalance(e) {
    e.preventDefault()
    setBalMsg('')
    if (!balCat || balEmps.length === 0 || balAmount === '') return
    setSavingBal(true)
    const amount = Number(balAmount)
    const { error } = balMode === 'set'
      ? await supabase.rpc('set_leave_balance', { p_employees: balEmps, p_category: balCat, p_allowance: amount })
      : await supabase.rpc('adjust_leave_balance', { p_employees: balEmps, p_category: balCat, p_delta: balMode === 'add' ? amount : -amount })
    setSavingBal(false)
    if (error) { setBalOk(false); setBalMsg(error.message); return }
    const verb = balMode === 'set' ? 'set' : balMode === 'add' ? 'increased' : 'decreased'
    setBalOk(true)
    setBalMsg(`Allowance ${verb} for ${balEmps.length} employee${balEmps.length === 1 ? '' : 's'}.`)
    setBalEmps([]); setBalAmount('')
  }

  const officeName = offices.find(o => o.id === officeId)?.name

  return (
    <div className="space-y-6">
      <div className="card px-5 py-3 flex items-center gap-3 flex-wrap">
        <Building2 size={15} className="text-gray-400 flex-shrink-0" />
        {canPickOffice ? (
          <>
            <span className="text-sm font-medium">Office</span>
            <select value={officeId} onChange={e => setOfficeId(e.target.value)} className="input text-sm w-auto max-w-[220px]">
              {offices.length === 0 && <option value="">No offices found</option>}
              {offices.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </>
        ) : (
          <span className="text-sm">
            <span className="font-medium">Office:</span> {officeName || '—'}
          </span>
        )}
      </div>

      {loading ? (
        <div className="card overflow-hidden"><SkeletonList rows={6} /></div>
      ) : (
        <>
        <div className="grid lg:grid-cols-2 gap-6">
      {/* Categories */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
          <Tags size={15} className="text-gray-400" />
          <h2 className="font-semibold text-sm">Leave categories</h2>
        </div>

        <form onSubmit={addCategory} className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 space-y-3">
          <input
            value={newName} onChange={e => setNewName(e.target.value)}
            placeholder="New category name (e.g. Sick Leave)" className="input text-sm" required
          />
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
              <input type="checkbox" checked={newPaid} onChange={e => setNewPaid(e.target.checked)} className="rounded" />
              Paid (deducts from balance)
            </label>
            <button type="submit" disabled={savingCat || !newName.trim()} className="btn-primary text-sm">
              <Plus size={14} /> Add
            </button>
          </div>
          {catError && <p className="text-xs text-red-500">{catError}</p>}
        </form>

        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {categories.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No categories yet.</p>
          ) : categories.map(c => (
            <div key={c.id} className="flex items-center justify-between px-5 py-3">
              <div className="flex items-center gap-2">
                <span className={clsx('text-sm', !c.is_active && 'text-gray-400 line-through')}>{c.name}</span>
                <span className={clsx('text-xs px-1.5 py-0.5 rounded-full',
                  c.is_paid ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400')}>
                  {c.is_paid ? 'Paid' : 'Record-only'}
                </span>
                {!c.is_active && <span className="text-xs text-gray-400">inactive</span>}
              </div>
              <button onClick={() => toggleActive(c)} title={c.is_active ? 'Deactivate' : 'Activate'}
                className={clsx('p-1.5 rounded-md transition-colors',
                  c.is_active ? 'text-gray-400 hover:text-red-500' : 'text-gray-400 hover:text-emerald-500')}>
                <Power size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Balances */}
      <div className="card h-fit">
        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800">
          <h2 className="font-semibold text-sm">Set allowances</h2>
          <p className="text-xs text-gray-400 mt-0.5">Set, add to, or subtract from the balance (in days) for one or more employees.</p>
        </div>
        <form onSubmit={saveBalance} className="p-5 space-y-4">
          <div>
            <label className="label">Category</label>
            <select value={balCat} onChange={e => setBalCat(e.target.value)} className="input text-sm">
              {categories.filter(c => c.is_paid).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <p className="text-xs text-gray-400 mt-1">Only paid categories track balances.</p>
          </div>
          <div>
            <label className="label">Mode</label>
            <div className="flex gap-1.5">
              {[['set', 'Set to'], ['add', 'Add'], ['subtract', 'Subtract']].map(([m, lbl]) => (
                <button
                  key={m} type="button" onClick={() => setBalMode(m)}
                  className={clsx(
                    'flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                    balMode === m
                      ? 'bg-ae7-red text-white'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
                  )}
                >
                  {lbl}
                </button>
              ))}
            </div>
            {balMode !== 'set' && (
              <p className="text-xs text-gray-400 mt-1">
                Applies against each employee's current balance individually — no need to know their running total.
              </p>
            )}
          </div>
          <div>
            <label className="label">Employees</label>
            <MultiSelect options={employeeOptions} value={balEmps} onChange={setBalEmps} placeholder="Select employees…" showSelectAll />
          </div>
          <div>
            <label className="label">
              {balMode === 'set' ? 'Set allowance to (days)' : balMode === 'add' ? 'Add (days)' : 'Subtract (days)'}
            </label>
            <input type="number" min="0" step="0.5" value={balAmount} onChange={e => setBalAmount(e.target.value)} className="input text-sm" placeholder="e.g. 21" required />
          </div>
          {balMsg && <p className={clsx('text-xs', balOk ? 'text-emerald-600' : 'text-red-500')}>{balMsg}</p>}
          <button type="submit" disabled={savingBal || !balCat || balEmps.length === 0 || balAmount === ''} className="btn-primary w-full text-sm">
            {savingBal
              ? 'Saving…'
              : <><Check size={14} /> {balMode === 'set' ? 'Set allowance' : balMode === 'add' ? 'Add to allowance' : 'Subtract from allowance'}</>
            }
          </button>
        </form>
      </div>
    </div>

      {/* Leave policies */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
          <CalendarClock size={15} className="text-gray-400" />
          <div>
            <h2 className="font-semibold text-sm">Leave policies</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Annual allowance and rollover rules per paid category. Cycles run on each employee's join anniversary.
            </p>
          </div>
        </div>

        {paidCategories.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-8">
            No leave categories for this office yet — add one on the left to get started.
          </p>
        ) : (
          <div>
            {paidCategories.map(c => (
              <PolicyRow key={`${officeId}:${c.id}`} category={c} policy={policyByCategory.get(c.id)} onSaved={load} />
            ))}
          </div>
        )}
      </div>
        </>
      )}
    </div>
  )
}
