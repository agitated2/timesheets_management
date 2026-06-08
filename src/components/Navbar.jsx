import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Upload, Clock, BarChart2, CheckSquare,
  Shield, LogOut, Sun, Moon, Menu, X, ChevronDown, Settings
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import NotificationBell from './NotificationBell'
import clsx from 'clsx'

const roleLabel = {
  employee: 'Employee',
  manager: 'Manager',
  hr: 'HR',
  c_suite: 'C-Suite',
  it: 'IT Admin',
}

const roleBadgeColor = {
  employee: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  manager:  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  hr:       'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  c_suite:  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  it:       'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

function NavItem({ to, icon: Icon, label, onClick }) {
  if (onClick) return (
    <button onClick={onClick} className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors w-full">
      <Icon size={18} />
      {label}
    </button>
  )
  return (
    <NavLink to={to} className={({ isActive }) => clsx(
      'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
      isActive
        ? 'bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400'
        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
    )}>
      <Icon size={18} />
      {label}
    </NavLink>
  )
}

function navLinks(role) {
  const links = [{ to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' }]

  if (role === 'employee') {
    links.push(
      { to: '/upload', icon: Upload, label: 'Upload Timesheet' },
      { to: '/history', icon: Clock, label: 'My History' },
    )
  }

  if (['manager', 'c_suite'].includes(role)) {
    links.push(
      { to: '/reviews', icon: CheckSquare, label: 'Reviews' },
      { to: '/analytics', icon: BarChart2, label: 'Analytics' },
    )
  }

  if (['hr', 'it'].includes(role)) {
    links.push(
      { to: '/analytics', icon: BarChart2, label: 'Analytics' },
    )
  }

  if (role === 'it') {
    links.push({ to: '/admin', icon: Shield, label: 'IT Admin' })
  }

  // Settings is available to all roles
  links.push({ to: '/settings', icon: Settings, label: 'Settings' })

  return links
}

export default function Navbar() {
  const { profile, signOut } = useAuth()
  const { isDark, toggle } = useTheme()
  const navigate = useNavigate()
  const [mobileOpen, setMobileOpen] = useState(false)

  const role = profile?.role ?? 'employee'
  const links = navLinks(role)

  const handleSignOut = async () => {
    await signOut()
    navigate('/auth')
  }

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-gray-200 dark:border-gray-800">
        <span className="text-lg font-bold text-gray-900 dark:text-white tracking-tight">TimeTrack</span>
      </div>

      {/* User info */}
      <div className="px-4 py-4 border-b border-gray-100 dark:border-gray-800">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-semibold flex-shrink-0">
            {(profile?.full_name || profile?.email || '?')[0].toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{profile?.full_name || profile?.email}</p>
            <span className={clsx('text-xs px-2 py-0.5 rounded-full font-medium', roleBadgeColor[role])}>
              {roleLabel[role]}
            </span>
          </div>
        </div>
      </div>

      {/* Nav links */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {links.map(l => (
          <NavItem key={l.to} {...l} onClick={l.onClick} />
        ))}
      </nav>

      {/* Bottom controls */}
      <div className="px-3 pb-4 pt-2 border-t border-gray-100 dark:border-gray-800 space-y-1">
        <button
          onClick={toggle}
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors w-full"
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
          {isDark ? 'Light mode' : 'Dark mode'}
        </button>
        <NavItem onClick={handleSignOut} icon={LogOut} label="Sign out" />
      </div>
    </div>
  )

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex flex-col w-60 shrink-0 h-screen sticky top-0 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800">
        <SidebarContent />
      </aside>

      {/* Mobile top bar */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-40 flex items-center justify-between px-4 h-14 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
        <span className="text-base font-bold text-gray-900 dark:text-white">TimeTrack</span>
        <div className="flex items-center gap-1">
          <NotificationBell />
          <button
            onClick={toggle}
            className="p-2 rounded-xl text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            {isDark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button
            onClick={() => setMobileOpen(o => !o)}
            className="p-2 rounded-xl text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            {mobileOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </header>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-30 flex">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="relative w-64 bg-white dark:bg-gray-900 h-full shadow-2xl flex flex-col">
            <SidebarContent />
          </div>
        </div>
      )}

      {/* Notification bell for desktop (in top-right of main content) */}
      <div className="hidden lg:block fixed top-4 right-6 z-30">
        <NotificationBell />
      </div>
    </>
  )
}
