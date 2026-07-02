import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { Upload, Clock, CheckSquare, XCircle, Hourglass, TrendingUp, Users, FileText, AlertCircle } from 'lucide-react'
import { format, subDays } from 'date-fns'
import clsx from 'clsx'
import { SkeletonList } from '../components/Skeleton'

const statusConfig = {
  pending:  { label: 'Pending',  color: 'text-amber-600 dark:text-amber-400',   bg: 'bg-amber-50  dark:bg-amber-950/30',  icon: Hourglass },
  approved: { label: 'Approved', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950/30', icon: CheckSquare },
  rejected: { label: 'Rejected', color: 'text-red-600 dark:text-red-400',       bg: 'bg-red-50    dark:bg-red-950/30',     icon: XCircle },
}

function StatCard({ icon: Icon, label, value, sub, color = 'blue' }) {
  const iconColors = {
    blue:  'text-blue-500  dark:text-blue-400',
    green: 'text-emerald-500 dark:text-emerald-400',
    amber: 'text-amber-500 dark:text-amber-400',
    red:   'text-red-500   dark:text-red-400',
  }
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">{label}</p>
          <p className="text-2xl font-semibold mt-1 tabular-nums">{value}</p>
          {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
        </div>
        <Icon size={18} className={clsx('flex-shrink-0 mt-0.5', iconColors[color])} />
      </div>
    </div>
  )
}

// ---- Employee dashboard ----
function EmployeeDashboard({ profile }) {
  const [timesheets, setTimesheets] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase
      .from('timesheets')
      .select('*')
      .eq('employee_id', profile.id)
      .order('date', { ascending: false })
      .limit(10)
      .then(({ data }) => { if (data) setTimesheets(data); setLoading(false) })
  }, [profile.id])

  const counts = { pending: 0, approved: 0, rejected: 0 }
  timesheets.forEach(t => { if (counts[t.status] !== undefined) counts[t.status]++ })
  const totalHours = timesheets.filter(t => t.status === 'approved').reduce((s, t) => s + (t.total_hours || 0), 0)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Good {greeting()}, {profile.full_name?.split(' ')[0] || 'there'}.</h1>
        <p className="page-subtitle">Your timesheet summary for the last 10 submissions.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={TrendingUp}  label="Approved hours" value={totalHours.toFixed(1)} sub="last 10 submissions" color="green" />
        <StatCard icon={Hourglass}   label="Pending review"  value={counts.pending}  color="amber" />
        <StatCard icon={CheckSquare} label="Approved"         value={counts.approved} color="green" />
        <StatCard icon={XCircle}     label="Rejected"         value={counts.rejected} color="red" />
      </div>

      <div className="flex gap-3 flex-wrap">
        <Link to="/upload" className="btn-primary">
          <Upload size={16} /> Upload today's timesheet
        </Link>
        <Link to="/history" className="btn-secondary">
          <Clock size={16} /> View history
        </Link>
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="font-semibold text-sm">Recent submissions</h2>
        </div>
        {loading ? <SkeletonList rows={5} /> : timesheets.length === 0 ? (
          <div className="p-8 text-center">
            <FileText size={36} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No timesheets yet. Upload your first one!</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {timesheets.map(t => {
              const { label, color, bg, icon: Icon } = statusConfig[t.status] ?? statusConfig.pending
              return (
                <div key={t.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                  <div>
                    <p className="text-sm font-medium">{format(new Date(t.date), 'EEEE, MMM d, yyyy')}</p>
                    <p className="text-xs text-gray-400">{t.total_hours ? `${t.total_hours}h logged` : 'No hours recorded'}</p>
                  </div>
                  <div className={clsx('flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full', bg, color)}>
                    <Icon size={12} />
                    {label}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ---- Manager / C-Suite dashboard ----
function ManagerDashboard({ profile }) {
  const [pending, setPending] = useState([])
  const [stats, setStats] = useState({ totalTeam: 0, pendingCount: 0, approvedToday: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const [{ data: team }, { data: pend }] = await Promise.all([
        supabase.from('profiles').select('id').filter('manager_ids', 'cs', `{${profile.id}}`),
        supabase.from('timesheets')
          .select('*, profiles!employee_id(full_name, email)')
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(20),
      ])
      if (pend) setPending(pend)
      setStats({ totalTeam: team?.length ?? 0, pendingCount: pend?.length ?? 0 })
      setLoading(false)
    }
    load()
  }, [profile.id])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Manager Dashboard</h1>
        <p className="page-subtitle">Review and manage your team's timesheets.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard icon={Users}      label="Team members"   value={stats.totalTeam}    color="blue" />
        <StatCard icon={Hourglass}  label="Pending review" value={stats.pendingCount}  color="amber" />
        <StatCard icon={TrendingUp} label="View analytics" value="→"                   sub="See team charts" color="green" />
      </div>

      <div className="flex gap-3">
        <Link to="/reviews" className="btn-primary"><CheckSquare size={16} /> Review timesheets</Link>
        <Link to="/analytics" className="btn-secondary"><TrendingUp size={16} /> Analytics</Link>
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <h2 className="font-semibold text-sm">Pending reviews</h2>
          {stats.pendingCount > 0 && (
            <span className="text-xs bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 px-2 py-0.5 rounded-full font-medium">
              {stats.pendingCount} waiting
            </span>
          )}
        </div>
        {loading ? <SkeletonList rows={5} /> : pending.length === 0 ? (
          <div className="p-8 text-center">
            <CheckSquare size={36} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
            <p className="text-sm text-gray-500">All caught up! No pending reviews.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {pending.slice(0, 8).map(t => (
              <Link key={t.id} to={`/review/${t.id}`} className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                <div>
                  <p className="text-sm font-medium">{t.profiles?.full_name || t.profiles?.email}</p>
                  <p className="text-xs text-gray-400">{format(new Date(t.date), 'MMM d, yyyy')} · {t.total_hours}h</p>
                </div>
                <span className="text-xs text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1">
                  <Hourglass size={12} /> Review →
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ---- HR / C-Suite / IT dashboard ----
function GlobalDashboard({ profile }) {
  const { hasRole } = useAuth()
  const [stats, setStats] = useState({ total: 0, pending: 0, approved: 0, employees: 0 })
  const [recent, setRecent] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const since = format(subDays(new Date(), 30), 'yyyy-MM-dd')
      const [{ data: sheets }, { data: emps }] = await Promise.all([
        supabase.from('timesheets')
          .select('*, profiles!employee_id(full_name, email)')
          .gte('date', since)
          .order('created_at', { ascending: false })
          .limit(50),
        supabase.from('profiles').select('id', { count: 'exact' }).filter('roles', 'cs', '{employee}'),
      ])
      if (sheets) {
        setRecent(sheets.slice(0, 8))
        const pending  = sheets.filter(t => t.status === 'pending').length
        const approved = sheets.filter(t => t.status === 'approved').length
        setStats({ total: sheets.length, pending, approved, employees: emps?.length ?? 0 })
      }
      setLoading(false)
    }
    load()
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Company Overview</h1>
        <p className="page-subtitle">Last 30 days · all employees</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Users}       label="Total employees"  value={stats.employees}  color="blue" />
        <StatCard icon={FileText}    label="Submissions"      value={stats.total}      color="blue" />
        <StatCard icon={Hourglass}   label="Pending review"   value={stats.pending}    color="amber" />
        <StatCard icon={CheckSquare} label="Approved"         value={stats.approved}   color="green" />
      </div>

      <div className="flex gap-3 flex-wrap">
        <Link to="/analytics" className="btn-primary"><TrendingUp size={16} /> Open analytics</Link>
        {hasRole('it') && <Link to="/admin" className="btn-secondary"><AlertCircle size={16} /> Admin panel</Link>}
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="font-semibold text-sm">Recent activity</h2>
        </div>
        {loading ? <SkeletonList rows={5} /> : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {recent.map(t => {
              const { label, color, bg, icon: Icon } = statusConfig[t.status] ?? statusConfig.pending
              return (
                <Link key={t.id} to={`/review/${t.id}`} className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                  <div>
                    <p className="text-sm font-medium">{t.profiles?.full_name || t.profiles?.email}</p>
                    <p className="text-xs text-gray-400">{format(new Date(t.date), 'MMM d, yyyy')} · {t.total_hours}h</p>
                  </div>
                  <div className={clsx('flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full', bg, color)}>
                    <Icon size={12} /> {label}
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'morning'
  if (h < 17) return 'afternoon'
  return 'evening'
}

export default function DashboardPage() {
  const { profile, hasRole } = useAuth()
  if (!profile) return null
  if (hasRole('it') || hasRole('hr') || hasRole('c_suite')) return <GlobalDashboard profile={profile} />
  if (hasRole('manager')) return <ManagerDashboard profile={profile} />
  if (hasRole('employee')) return <EmployeeDashboard profile={profile} />
  return <GlobalDashboard profile={profile} />
}
