import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Layers, Plus, Check, X, Power, Pencil } from 'lucide-react'
import MultiSelect from '../MultiSelect'
import clsx from 'clsx'
import { SkeletonList } from '../Skeleton'

export default function HRDisciplines() {
  const [disciplines, setDisciplines] = useState([])
  const [employees, setEmployees]     = useState([])
  const [loading, setLoading]         = useState(true)

  // new discipline
  const [newName, setNewName]       = useState('')
  const [savingNew, setSavingNew]   = useState(false)
  const [newError, setNewError]     = useState('')

  // inline rename
  const [editId, setEditId]         = useState(null)
  const [editName, setEditName]     = useState('')

  // assignment
  const [assignDisc, setAssignDisc] = useState('')
  const [assignEmps, setAssignEmps] = useState([])
  const [savingAssign, setSavingAssign] = useState(false)
  const [assignMsg, setAssignMsg]   = useState('')

  const load = useCallback(async () => {
    const [disc, profs] = await Promise.all([
      supabase.from('disciplines').select('*').order('name'),
      supabase.from('profiles').select('id, full_name, email, discipline_id').order('full_name'),
    ])
    setDisciplines(disc.data || [])
    setEmployees(profs.data || [])
    setAssignDisc(prev => prev || disc.data?.find(d => d.is_active)?.id || '')
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const discNameById = useMemo(
    () => new Map(disciplines.map(d => [d.id, d.name])),
    [disciplines]
  )
  const employeeOptions = useMemo(
    () => employees.map(e => ({
      value: e.id,
      label: e.full_name || e.email,
      sublabel: e.discipline_id ? discNameById.get(e.discipline_id) || e.email : e.email,
    })),
    [employees, discNameById]
  )

  async function addDiscipline(e) {
    e.preventDefault()
    setNewError(''); setSavingNew(true)
    const { error } = await supabase.rpc('upsert_discipline', { p_id: null, p_name: newName.trim(), p_active: true })
    setSavingNew(false)
    if (error) { setNewError(error.message); return }
    setNewName('')
    load()
  }

  async function rename(d) {
    if (!editName.trim() || editName.trim() === d.name) { setEditId(null); return }
    const { error } = await supabase.rpc('upsert_discipline', { p_id: d.id, p_name: editName.trim(), p_active: d.is_active })
    if (error) { alert(error.message); return }
    setEditId(null)
    load()
  }

  async function toggleActive(d) {
    const { error } = await supabase.rpc('upsert_discipline', { p_id: d.id, p_name: d.name, p_active: !d.is_active })
    if (error) { alert(error.message); return }
    load()
  }

  async function saveAssignment(e) {
    e.preventDefault()
    setAssignMsg('')
    if (!assignDisc || assignEmps.length === 0) return
    setSavingAssign(true)
    const { error } = await supabase.rpc('set_employee_discipline', { p_employees: assignEmps, p_discipline: assignDisc })
    setSavingAssign(false)
    if (error) { setAssignMsg(error.message); return }
    setAssignMsg(`Discipline assigned to ${assignEmps.length} employee${assignEmps.length === 1 ? '' : 's'}.`)
    setAssignEmps([])
    load()
  }

  if (loading) return <div className="card overflow-hidden"><SkeletonList rows={6} /></div>

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      {/* Disciplines list */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
          <Layers size={15} className="text-gray-400" />
          <h2 className="font-semibold text-sm">Disciplines</h2>
        </div>

        <form onSubmit={addDiscipline} className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center gap-3">
          <input
            value={newName} onChange={e => setNewName(e.target.value)}
            placeholder="New discipline (e.g. Structural Engineer)" className="input text-sm flex-1" required
          />
          <button type="submit" disabled={savingNew || !newName.trim()} className="btn-primary text-sm">
            <Plus size={14} /> Add
          </button>
        </form>
        {newError && <p className="text-xs text-red-500 px-5 pt-2">{newError}</p>}

        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {disciplines.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No disciplines yet. Add one to get started.</p>
          ) : disciplines.map(d => (
            <div key={d.id} className="flex items-center justify-between gap-2 px-5 py-3">
              {editId === d.id ? (
                <div className="flex items-center gap-2 flex-1">
                  <input
                    value={editName} onChange={e => setEditName(e.target.value)} autoFocus
                    onKeyDown={e => { if (e.key === 'Enter') rename(d); if (e.key === 'Escape') setEditId(null) }}
                    className="input text-sm flex-1 py-1"
                  />
                  <button onClick={() => rename(d)} className="p-1.5 rounded-md text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"><Check size={14} /></button>
                  <button onClick={() => setEditId(null)} className="p-1.5 rounded-md text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"><X size={14} /></button>
                </div>
              ) : (
                <>
                  <span className={clsx('text-sm', !d.is_active && 'text-gray-400 line-through')}>
                    {d.name}
                    {!d.is_active && <span className="ml-2 text-xs text-gray-400 no-underline">inactive</span>}
                  </span>
                  <div className="flex items-center gap-1">
                    <button onClick={() => { setEditId(d.id); setEditName(d.name) }} title="Rename"
                      className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><Pencil size={13} /></button>
                    <button onClick={() => toggleActive(d)} title={d.is_active ? 'Deactivate' : 'Activate'}
                      className={clsx('p-1.5 rounded-md transition-colors', d.is_active ? 'text-gray-400 hover:text-red-500' : 'text-gray-400 hover:text-emerald-500')}>
                      <Power size={14} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Assign to employees */}
      <div className="card h-fit">
        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800">
          <h2 className="font-semibold text-sm">Assign discipline</h2>
          <p className="text-xs text-gray-400 mt-0.5">Set the home discipline for one or more employees.</p>
        </div>
        <form onSubmit={saveAssignment} className="p-5 space-y-4">
          <div>
            <label className="label">Discipline</label>
            <select value={assignDisc} onChange={e => setAssignDisc(e.target.value)} className="input text-sm">
              {disciplines.filter(d => d.is_active).length === 0 && <option value="">No active disciplines</option>}
              {disciplines.filter(d => d.is_active).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Employees</label>
            <MultiSelect options={employeeOptions} value={assignEmps} onChange={setAssignEmps} placeholder="Select employees…" />
          </div>
          {assignMsg && <p className={clsx('text-xs', assignMsg.includes('assigned to') ? 'text-emerald-600' : 'text-red-500')}>{assignMsg}</p>}
          <button type="submit" disabled={savingAssign || !assignDisc || assignEmps.length === 0} className="btn-primary w-full text-sm">
            {savingAssign ? 'Saving…' : <><Check size={14} /> Assign discipline</>}
          </button>
        </form>
      </div>
    </div>
  )
}
