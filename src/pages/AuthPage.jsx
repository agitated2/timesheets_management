import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Mail, Lock, Eye, EyeOff, ArrowRight, Sun, Moon } from 'lucide-react'
import { useTheme } from '../contexts/ThemeContext'
import Logo from '../components/Logo'

export default function AuthPage() {
  const { isDark, toggle } = useTheme()

  const [credEmail, setCredEmail] = useState('')
  const [credPassword, setCredPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [credLoading, setCredLoading] = useState(false)
  const [credError, setCredError] = useState('')

  async function signInWithPassword(e) {
    e.preventDefault()
    setCredError('')
    setCredLoading(true)
    const { error } = await supabase.auth.signInWithPassword({
      email: credEmail.trim().toLowerCase(),
      password: credPassword,
    })
    setCredLoading(false)
    if (error) {
      // No self-service reset exists (auth hardening: IT resets passwords
      // on request) — point people at the right place instead of a dead
      // end suggesting a link option that no longer exists.
      setCredError(
        error.message.includes('Invalid login credentials')
          ? 'Incorrect email or password. Contact IT if you need your password reset.'
          : error.message
      )
    }
    // On success, AuthContext listener re-routes automatically.
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-rose-50 to-red-50 dark:from-gray-950 dark:to-gray-900 flex items-center justify-center p-4">
      <button
        onClick={toggle}
        className="fixed top-4 right-4 p-2 rounded-xl bg-white dark:bg-gray-800 shadow text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
        aria-label="Toggle theme"
      >
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="mb-3"><Logo size="lg" showPortal={true} /></div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Access your AE7 employee portal.</p>
        </div>

        <div className="card p-8">
          <h2 className="text-xl font-semibold mb-1">Sign in</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
            Use the credentials provided by your IT admin.
          </p>

          <form onSubmit={signInWithPassword} className="space-y-4">
            <div>
              <label className="label" htmlFor="cred-email">Email</label>
              <div className="relative">
                <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  id="cred-email"
                  type="email"
                  value={credEmail}
                  onChange={e => setCredEmail(e.target.value)}
                  className="input pl-9"
                  placeholder="you@company.com"
                  required
                  autoComplete="email"
                  autoFocus
                />
              </div>
            </div>

            <div>
              <label className="label" htmlFor="cred-password">Password</label>
              <div className="relative">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  id="cred-password"
                  type={showPassword ? 'text' : 'password'}
                  value={credPassword}
                  onChange={e => setCredPassword(e.target.value)}
                  className="input pl-9 pr-10"
                  placeholder="Enter your password"
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {credError && (
              <p className="text-sm text-red-600 dark:text-red-400">{credError}</p>
            )}

            <button
              type="submit"
              disabled={credLoading || !credEmail || !credPassword}
              className="btn-primary w-full"
            >
              {credLoading ? (
                <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Signing in…</>
              ) : (
                <>Sign in <ArrowRight size={16} /></>
              )}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-gray-100 dark:border-gray-800 text-center">
            <p className="text-xs text-gray-400">
              Forgot your password, or don't have one yet? Contact your IT admin.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
