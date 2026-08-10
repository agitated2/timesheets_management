import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { Clock } from 'lucide-react'

// Ticks once a second, showing the CURRENT time in the viewer's home
// office — not the browser's. The browser's own clock only ever tells you
// the viewer's local time; for a multi-office company "what time is it
// right now" is meaningless without picking a timezone, so this reads
// offices.timezone the same way the reminder job and HR Timesheets do
// (see src/lib/datetime.js).
export default function OfficeClock() {
  const { profile } = useAuth()
  const [office, setOffice] = useState(null)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (!profile?.office_id) return
    supabase.from('offices').select('name, timezone').eq('id', profile.office_id).single()
      .then(({ data }) => setOffice(data))
  }, [profile?.office_id])

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  if (!office?.timezone) return null

  // Individual date-time component options, NOT dateStyle/timeStyle —
  // those two can't be combined with timeZoneName, see the comment in
  // src/lib/datetime.js for the exact TypeError this throws otherwise.
  const dateStr = new Intl.DateTimeFormat(undefined, {
    timeZone: office.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(now)
  const timeStr = new Intl.DateTimeFormat(undefined, {
    timeZone: office.timezone, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(now)

  return (
    <div className="card px-4 py-3 flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl bg-ae7-light dark:bg-ae7-red/10 flex items-center justify-center flex-shrink-0">
        <Clock size={16} className="text-ae7-red" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold tabular-nums">{timeStr}</p>
        <p className="text-xs text-gray-400 truncate">{dateStr} · {office.name}</p>
      </div>
    </div>
  )
}
