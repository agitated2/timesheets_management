import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import AuthPage from './pages/AuthPage'
import OnboardingPage from './pages/OnboardingPage'
import DashboardPage from './pages/DashboardPage'
import UploadPage from './pages/UploadPage'
import HistoryPage from './pages/HistoryPage'
import ReviewPage from './pages/ReviewPage'
import ReviewsPage from './pages/ReviewsPage'
import NotificationsPage from './pages/NotificationsPage'
import AnalyticsPage from './pages/AnalyticsPage'
import AdminPage from './pages/AdminPage'
import SettingsPage from './pages/SettingsPage'
import ProjectsPage from './pages/ProjectsPage'
import RequestsPage from './pages/RequestsPage'
import HRPanelPage from './pages/HRPanelPage'
import EmployeeOverviewPage from './pages/EmployeeOverviewPage'
import AuthCallback from './pages/AuthCallback'

function RoleGate({ allow, children }) {
  const { profile, hasRole } = useAuth()
  if (!profile || !allow.some(r => hasRole(r))) {
    return <Navigate to="/dashboard" replace />
  }
  return children
}

function AppRoutes() {
  const { user } = useAuth()
  return (
    <Routes>
      <Route path="/auth" element={user ? <Navigate to="/dashboard" replace /> : <AuthPage />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/" element={<Navigate to={user ? '/dashboard' : '/auth'} replace />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/onboarding" element={<OnboardingPage />} />

        <Route element={<Layout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />

          {/* Employee */}
          <Route path="/upload"  element={<RoleGate allow={['employee']}><UploadPage /></RoleGate>} />
          <Route path="/history" element={<RoleGate allow={['employee']}><HistoryPage /></RoleGate>} />

          {/* Manager / C-Suite */}
          <Route path="/reviews"     element={<RoleGate allow={['manager','c_suite','it']}><ReviewsPage /></RoleGate>} />
          <Route path="/review/:id"  element={<ReviewPage />} />

          {/* Analytics — dedicated analytics roles */}
          <Route path="/analytics"   element={<RoleGate allow={['global_analytics','team_analytics']}><AnalyticsPage /></RoleGate>} />

          {/* Settings — all roles; IT gets extra role-management section */}
          <Route path="/settings"    element={<SettingsPage />} />

          {/* Requests — all authenticated users */}
          <Route path="/requests"    element={<RequestsPage />} />

          {/* HR Panel — any HR flag or IT */}
          <Route path="/hr"          element={<RoleGate allow={['hr_view_timesheets','hr_manage_policies','hr_manage_calendar','hr_approve_requests','it']}><HRPanelPage /></RoleGate>} />

          {/* Employee Overview — dedicated role or IT */}
          <Route path="/employees"   element={<RoleGate allow={['employee_overview','it']}><EmployeeOverviewPage /></RoleGate>} />

          {/* Projects */}
          <Route path="/projects"    element={<RoleGate allow={['projects_control','it']}><ProjectsPage /></RoleGate>} />

          {/* IT only */}
          <Route path="/admin"       element={<RoleGate allow={['it']}><AdminPage /></RoleGate>} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  )
}
