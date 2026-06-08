import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { Bell, CheckCheck, Trash2 } from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import clsx from 'clsx'

const typeConfig = {
  submission: { color: 'bg-blue-500',    label: 'Submission' },
  approval:   { color: 'bg-emerald-500', label: 'Approved' },
  rejection:  { color: 'bg-red-500',     label: 'Rejected' },
}

export default function NotificationsPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [notifications, setNotifications] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    load()
  }, [user])

  async function load() {
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
    if (data) setNotifications(data)
    setLoading(false)
  }

  async function markAllRead() {
    await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', user.id)
      .eq('is_read', false)
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })))
  }

  async function markRead(id) {
    await supabase.from('notifications').update({ is_read: true }).eq('id', id)
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n))
  }

  const unreadCount = notifications.filter(n => !n.is_read).length

  const grouped = notifications.reduce((acc, n) => {
    const key = format(new Date(n.created_at), 'yyyy-MM-dd')
    if (!acc[key]) acc[key] = []
    acc[key].push(n)
    return acc
  }, {})

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Notifications</h1>
          {unreadCount > 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{unreadCount} unread</p>
          )}
        </div>
        {unreadCount > 0 && (
          <button onClick={markAllRead} className="btn-secondary gap-2 text-sm">
            <CheckCheck size={15} /> Mark all read
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-400 text-sm">Loading…</div>
      ) : notifications.length === 0 ? (
        <div className="card p-12 text-center">
          <Bell size={40} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
          <p className="text-gray-500">You have no notifications.</p>
        </div>
      ) : (
        Object.entries(grouped).map(([dateKey, items]) => (
          <div key={dateKey}>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">
              {format(new Date(dateKey), 'EEEE, MMMM d')}
            </p>
            <div className="card overflow-hidden divide-y divide-gray-100 dark:divide-gray-800">
              {items.map(n => {
                const { color } = typeConfig[n.type] ?? { color: 'bg-gray-400' }
                return (
                  <div
                    key={n.id}
                    className={clsx(
                      'flex gap-3 px-5 py-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors',
                      !n.is_read && 'bg-blue-50/40 dark:bg-blue-950/10'
                    )}
                    onClick={() => {
                      markRead(n.id)
                      if (n.timesheet_id) navigate(`/review/${n.timesheet_id}`)
                    }}
                  >
                    <div className={clsx('mt-1.5 w-2 h-2 rounded-full flex-shrink-0', color)} />
                    <div className="flex-1 min-w-0">
                      <p className={clsx('text-sm leading-snug', !n.is_read ? 'font-medium' : 'text-gray-600 dark:text-gray-400')}>
                        {n.message}
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                      </p>
                    </div>
                    {!n.is_read && (
                      <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-2" />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
