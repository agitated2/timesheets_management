import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Mail, KeyRound, ArrowRight, MailCheck, Sun, Moon, RefreshCw } from 'lucide-react'
import { useTheme } from '../contexts/ThemeContext'

export default function AuthPage() {
  const { isDark, toggle } = useTheme()
  const [step, setStep] = useState('email') // 'email' | 'sent'
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [resending, setResending] = useState(false)
  const [error, setError] = useState('')

  async function sendLink(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: window.location.origin },
    })
    setLoading(false)
    if (err) { setError(err.message); return }
    setStep('sent')
  }

  async function resend() {
    setResending(true)
    setError('')
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: window.location.origin },
    })
    setResending(false)
    if (err) setError(err.message)
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
            <KeyRound size={26} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">TimeTrack</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Timesheet Management Platform</p>
        </div>

        <div className="card p-8">
          {step === 'email' ? (
            <>
              <h2 className="text-xl font-semibold mb-1">Sign in</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                Enter your corporate email and we'll send you a sign-in link.
              </p>

              <form onSubmit={sendLink} className="space-y-4">
                <div>
                  <label className="label" htmlFor="email">Corporate email</label>
                  <div className="relative">
                    <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      id="email"
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      className="input pl-9"
                      placeholder="you@company.com"
                      required
                      autoComplete="email"
                      autoFocus
                    />
                  </div>
                </div>

                {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

                <button type="submit" disabled={loading || !email} className="btn-primary w-full">
                  {loading ? 'Sending…' : 'Send sign-in link'}
                  <ArrowRight size={16} />
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="flex flex-col items-center text-center py-2">
                <div className="w-16 h-16 rounded-2xl bg-blue-50 dark:bg-blue-950/30 flex items-center justify-center mb-5">
                  <MailCheck size={32} className="text-blue-600 dark:text-blue-400" />
                </div>

                <h2 className="text-xl font-semibold mb-2">Check your inbox</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
                  We sent a sign-in link to
                </p>
                <p className="text-sm font-semibold text-gray-900 dark:text-white mb-6 break-all">
                  {email}
                </p>

                <p className="text-xs text-gray-400 dark:text-gray-500 mb-6">
                  Click the link in the email to sign in. It expires in 1 hour.
                  Check your spam folder if you don't see it.
                </p>

                {error && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>}

                <div className="flex flex-col gap-2 w-full">
                  <button
                    onClick={resend}
                    disabled={resending}
                    className="btn-secondary w-full"
                  >
                    <RefreshCw size={15} className={resending ? 'animate-spin' : ''} />
                    {resending ? 'Resending…' : 'Resend link'}
                  </button>

                  <button
                    onClick={() => { setStep('email'); setError('') }}
                    className="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 py-1"
                  >
                    Use a different email
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
