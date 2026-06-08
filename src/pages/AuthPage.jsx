import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Mail, Lock, Eye, EyeOff, ArrowRight, MailCheck, Sun, Moon, RefreshCw, ArrowLeft } from 'lucide-react'
import { useTheme } from '../contexts/ThemeContext'
import clsx from 'clsx'

export default function AuthPage() {
  const { isDark, toggle } = useTheme()
  // mode: 'credentials' | 'magic-link' | 'link-sent'
  const [mode, setMode] = useState('credentials')

  // Credentials state
  const [credEmail, setCredEmail] = useState('')
  const [credPassword, setCredPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [credLoading, setCredLoading] = useState(false)
  const [credError, setCredError] = useState('')

  // Magic link state
  const [linkEmail, setLinkEmail] = useState('')
  const [linkLoading, setLinkLoading] = useState(false)
  const [resending, setResending] = useState(false)
  const [linkError, setLinkError] = useState('')

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
      setCredError(
        error.message.includes('Invalid login credentials')
          ? "Incorrect email or password. If you haven't set a password yet, use the email link option below."
          : error.message
      )
    }
    // On success, AuthContext listener re-routes automatically.
  }

  async function sendLink(e) {
    e.preventDefault()
    setLinkError('')
    setLinkLoading(true)
    const { error } = await supabase.auth.signInWithOtp({
      email: linkEmail.trim().toLowerCase(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    })
    setLinkLoading(false)
    if (error) { setLinkError(error.message); return }
    setMode('link-sent')
  }

  async function resend() {
    setResending(true)
    setLinkError('')
    const { error } = await supabase.auth.signInWithOtp({
      email: linkEmail.trim().toLowerCase(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    })
    setResending(false)
    if (error) setLinkError(error.message)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-950 dark:to-gray-900 flex items-center justify-center p-4">
      <button
        onClick={toggle}
        className="fixed top-4 right-4 p-2 rounded-xl bg-white dark:bg-gray-800 shadow text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
        aria-label="Toggle theme"
      >
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      <div className="w-full max-w-md">
        {/* Brand */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 mb-4 shadow-lg">
            <Lock size={26} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">TimeTrack</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Timesheet Management Platform</p>
        </div>

        <div className="card p-8">
          {/* ── Credentials (default) ────────────────────────── */}
          {mode === 'credentials' && (
            <>
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
                <p className="text-xs text-gray-400 mb-3">Don't have a password, or prefer a link?</p>
                <button
                  onClick={() => { setMode('magic-link'); setLinkEmail(credEmail); setLinkError('') }}
                  className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Sign in with email link instead
                </button>
              </div>
            </>
          )}

          {/* ── Magic link entry ─────────────────────────────── */}
          {mode === 'magic-link' && (
            <>
              <button
                onClick={() => { setMode('credentials'); setLinkError('') }}
                className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 mb-5 -ml-1"
              >
                <ArrowLeft size={15} /> Back to sign in
              </button>

              <h2 className="text-xl font-semibold mb-1">Sign in with a link</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                Enter your email and we'll send you a one-click sign-in link.
              </p>

              <form onSubmit={sendLink} className="space-y-4">
                <div>
                  <label className="label" htmlFor="link-email">Email</label>
                  <div className="relative">
                    <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      id="link-email"
                      type="email"
                      value={linkEmail}
                      onChange={e => setLinkEmail(e.target.value)}
                      className="input pl-9"
                      placeholder="you@company.com"
                      required
                      autoComplete="email"
                      autoFocus
                    />
                  </div>
                </div>

                {linkError && (
                  <p className="text-sm text-red-600 dark:text-red-400">{linkError}</p>
                )}

                <button
                  type="submit"
                  disabled={linkLoading || !linkEmail}
                  className="btn-primary w-full"
                >
                  {linkLoading ? (
                    <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Sending…</>
                  ) : (
                    <>Send sign-in link <ArrowRight size={16} /></>
                  )}
                </button>
              </form>
            </>
          )}

          {/* ── Link sent ────────────────────────────────────── */}
          {mode === 'link-sent' && (
            <div className="flex flex-col items-center text-center py-2">
              <div className="w-16 h-16 rounded-2xl bg-blue-50 dark:bg-blue-950/30 flex items-center justify-center mb-5">
                <MailCheck size={32} className="text-blue-600 dark:text-blue-400" />
              </div>

              <h2 className="text-xl font-semibold mb-2">Check your inbox</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">We sent a sign-in link to</p>
              <p className="text-sm font-semibold text-gray-900 dark:text-white mb-6 break-all">{linkEmail}</p>

              <p className="text-xs text-gray-400 dark:text-gray-500 mb-6">
                Click the link in the email to sign in. It expires in 1 hour.
                Check your spam folder if you don't see it.
              </p>

              {linkError && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{linkError}</p>}

              <div className="flex flex-col gap-2 w-full">
                <button onClick={resend} disabled={resending} className="btn-secondary w-full">
                  <RefreshCw size={15} className={resending ? 'animate-spin' : ''} />
                  {resending ? 'Resending…' : 'Resend link'}
                </button>
                <button
                  onClick={() => { setMode('credentials'); setLinkError('') }}
                  className="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 py-1"
                >
                  Back to sign in
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
