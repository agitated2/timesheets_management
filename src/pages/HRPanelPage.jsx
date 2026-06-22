import { useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { FileText, Inbox, Users, Tags, CalendarDays, ShieldAlert } from 'lucide-react'
import clsx from 'clsx'
import HRTimesheets from '../components/hr/HRTimesheets'
import HRApprovals from '../components/hr/HRApprovals'
import HREmployeeLeaves from '../components/hr/HREmployeeLeaves'
import HRPolicies from '../components/hr/HRPolicies'
import HRCalendar from '../components/hr/HRCalendar'
import HRRevoke from '../components/hr/HRRevoke'

export default function HRPanelPage() {
  const { hasRole } = useAuth()
  const it = hasRole('it')

  const tabs = useMemo(() => {
    const t = []
    if (it || hasRole('hr_view_timesheets')) t.push({ key: 'timesheets', label: 'Timesheets', icon: FileText, Comp: HRTimesheets })
    if (it || hasRole('hr_approve_requests')) t.push({ key: 'approvals', label: 'Approvals', icon: Inbox, Comp: HRApprovals })
    if (it || hasRole('hr_view_timesheets') || hasRole('hr_approve_requests') || hasRole('hr_manage_policies'))
      t.push({ key: 'leaves', label: 'Employee Leaves', icon: Users, Comp: HREmployeeLeaves })
    if (it || hasRole('hr_manage_policies')) t.push({ key: 'policies', label: 'Policies', icon: Tags, Comp: HRPolicies })
    if (it || hasRole('hr_manage_calendar')) t.push({ key: 'calendar', label: 'Calendar', icon: CalendarDays, Comp: HRCalendar })
    if (it) t.push({ key: 'revoke', label: 'Revoke Leaves', icon: ShieldAlert, Comp: HRRevoke })
    return t
  }, [it, hasRole])

  const [active, setActive] = useState(tabs[0]?.key)
  const ActiveComp = tabs.find(t => t.key === active)?.Comp

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">HR Panel</h1>
        <p className="page-subtitle">Manage leaves, policies, calendars, and review timesheets.</p>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-gray-800 -mb-px">
        {tabs.map(t => {
          const Icon = t.icon
          return (
            <button
              key={t.key}
              onClick={() => setActive(t.key)}
              className={clsx(
                'flex items-center gap-1.5 px-3.5 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors',
                active === t.key
                  ? 'border-gray-900 dark:border-gray-100 text-gray-900 dark:text-gray-100'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
              )}
            >
              <Icon size={15} /> {t.label}
            </button>
          )
        })}
      </div>

      {ActiveComp ? <ActiveComp /> : <p className="text-sm text-gray-400">No sections available.</p>}
    </div>
  )
}
