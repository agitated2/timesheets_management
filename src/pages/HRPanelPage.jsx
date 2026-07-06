import { useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { FileText, Inbox, Users, Tags, CalendarDays, ShieldAlert, Layers } from 'lucide-react'
import Tabs from '../components/Tabs'
import HRTimesheets from '../components/hr/HRTimesheets'
import HRApprovals from '../components/hr/HRApprovals'
import HREmployeeLeaves from '../components/hr/HREmployeeLeaves'
import HRPolicies from '../components/hr/HRPolicies'
import HRDisciplines from '../components/hr/HRDisciplines'
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
    if (it || hasRole('hr_manage_policies')) t.push({ key: 'disciplines', label: 'Disciplines', icon: Layers, Comp: HRDisciplines })
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

      <Tabs tabs={tabs} active={active} onChange={setActive} />

      {ActiveComp ? <ActiveComp /> : <p className="text-sm text-gray-400">No sections available.</p>}
    </div>
  )
}
