import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Mail, KeyRound, ArrowRight, CheckCircle, Sun, Moon } from 'lucide-react'
import { useTheme } from '../contexts/ThemeContext'

export default function AuthPage() {
  const { isDark, toggle } = useTheme()
  const [step, setStep] = useState('email') // 'email' | 'otp'
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  async function sendOtp(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error: err } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase() })
    setLoading(false)
    if (err) { setError(err.message); return }
    setInfo(`A verification code was sent to ${email}`)
    setStep('otp')
  }

  async function verifyOtp(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error: err } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: otp.trim(),
      type: 'email',
    })
    setLoading(false)
    if (err) setError(err.message)
    // Successful verification triggers onAuthStateChange → AuthContext handles redirect
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
                Enter your corporate email to receive a one-time code.
              </p>

              <form onSubmit={sendOtp} className="space-y-4">
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
                    />
                  </div>
                </div>

                {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

                <button type="submit" disabled={loading || !email} className="btn-primary w-full">
                  {loading ? 'Sending…' : 'Send verification code'}
                  <ArrowRight size={16} />
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 mb-4">
                <CheckCircle size={20} className="text-emerald-500 flex-shrink-0" />
                <p className="text-sm text-gray-600 dark:text-gray-400">{info}</p>
              </div>

              <h2 className="text-xl font-semibold mb-1">Enter your code</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                Paste the 6-digit code from your email.
              </p>

              <form onSubmit={verifyOtp} className="space-y-4">
                <div>
                  <label className="label" htmlFor="otp">Verification code</label>
                  <input
                    id="otp"
                    type="text"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    value={otp}
                    onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                    className="input text-center text-2xl tracking-widest font-mono"
                    placeholder="000000"
                    required
                    autoFocus
                    autoComplete="one-time-code"
                  />
                </div>

                {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

                <button type="submit" disabled={loading || otp.length < 6} className="btn-primary w-full">
                  {loading ? 'Verifying…' : 'Verify & continue'}
                  <ArrowRight size={16} />
                </button>

                <button
                  type="button"
                  onClick={() => { setStep('email'); setOtp(''); setError('') }}
                  className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 w-full text-center mt-1"
                >
                  Use a different email
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
