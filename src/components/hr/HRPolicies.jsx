import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Tags, Plus, Check, X, Power } from 'lucide-react'
import MultiSelect from '../MultiSelect'
import clsx from 'clsx'
import { SkeletonList } from '../Skeleton'

export default function HRPolicies() {
  const [categories, setCategories] = useState([])
  const [employees, setEmployees]   = useState([])
  const [loading, setLoading]       = useState(true)

  // new category
  const [newName, setNewName]   = useState('')
  const [newPaid, setNewPaid]   = useState(true)
  const [savingCat, setSavingCat] = useState(false)
  const [catError, setCatError] = useState('')

  // balance assignment
  const [balCat, setBalCat]     = useState('')
  const [balEmps, setBalEmps]   = useState([])
  const [balAmount, setBalAmount] = useState('')
  const [savingBal, setSavingBal] = useState(false)
  const [balMsg, setBalMsg]     = useState('')

  const load = useCallback(async () => {
    const [cats, profs] = await Promise.all([
      supabase.from('leave_categories').select('*').order('name'),
      supabase.from('profiles').select('id, full_name, email').order('full_name'),
    ])
    setCategories(cats.data || [])
    setEmployees(profs.data || [])
    if (!balCat && cats.data?.length) setBalCat(cats.data.find(c => c.is_paid)?.id || cats.data[0].id)
    setLoading(false)
  }, [balCat])

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const employeeOptions = useMemo(
    () => employees.map(e => ({ value: e.id, label: e.full_name || e.email, sublabel: e.email })),
    [employees]
  )

  async function addCategory(e) {
    e.preventDefault()
    setCatError(''); setSavingCat(true)
    const { error } = await supabase.from('leave_categories').insert({ name: newName.trim(), is_paid: newPaid })
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
    const { error } = await supabase.rpc('set_leave_balance', {
      p_employees: balEmps, p_category: balCat, p_allowance: Number(balAmount),
    })
    setSavingBal(false)
    if (error) { setBalMsg(error.message); return }
    setBalMsg(`Allowance set for ${balEmps.length} employee${balEmps.length === 1 ? '' : 's'}.`)
    setBalEmps([]); setBalAmount('')
  }

  if (loading) return <div className="card overflow-hidden"><SkeletonList rows={6} /></div>

  return (
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
      <div className="card overflow-hidden h-fit">
        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800">
          <h2 className="font-semibold text-sm">Set allowances</h2>
          <p className="text-xs text-gray-400 mt-0.5">Apply a balance (in days) to one or more employees.</p>
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
            <label className="label">Employees</label>
            <MultiSelect options={employeeOptions} value={balEmps} onChange={setBalEmps} placeholder="Select employees…" />
          </div>
          <div>
            <label className="label">Allowance (days)</label>
            <input type="number" min="0" step="0.5" value={balAmount} onChange={e => setBalAmount(e.target.value)} className="input text-sm" placeholder="e.g. 21" required />
          </div>
          {balMsg && <p className={clsx('text-xs', balMsg.includes('set for') ? 'text-emerald-600' : 'text-red-500')}>{balMsg}</p>}
          <button type="submit" disabled={savingBal || !balCat || balEmps.length === 0 || balAmount === ''} className="btn-primary w-full text-sm">
            {savingBal ? 'Saving…' : <><Check size={14} /> Apply allowance</>}
          </button>
        </form>
      </div>
    </div>
  )
}
