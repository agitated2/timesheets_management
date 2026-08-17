// TOTP enrollment: enroll -> show QR + manual secret -> verify a 6-digit
// code -> done. Shared between the mandatory post-login gate (MfaGate)
// and self-service setup (Settings), since the Supabase calls and the
// screen itself are identical in both places — only what happens before
// and after differs.

import { useEffect, useState } from 'react'
import { ShieldCheck, ArrowRight, AlertCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'

export default function MfaEnrollFlow({ onEnrolled, onCancel }) {
  const [phase, setPhase] = useState('starting') // starting | ready | verifying | error
  const [factorId, setFactorId] = useState(null)
  const [qrCode, setQrCode] = useState(null)
  const [secret, setSecret] = useState(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [showSecret, setShowSecret] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function start() {
      const { data, error: enrollErr } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
      if (cancelled) return
      if (enrollErr) { setError(enrollErr.message); setPhase('error'); return }
      setFactorId(data.id)
      setQrCode(data.totp.qr_code)
      setSecret(data.totp.secret)
      setPhase('ready')
    }
    start()
    return () => { cancelled = true }
  }, [])

  async function handleVerify(e) {
    e.preventDefault()
    setError('')
    setPhase('verifying')
    const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId })
    if (challengeErr) { setError(challengeErr.message); setPhase('ready'); return }
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId, challengeId: challenge.id, code: code.trim(),
    })
    if (verifyErr) {
      setError('Incorrect code. Check the time on your device and try again.')
      setPhase('ready')
      return
    }
    onEnrolled()
  }

  async function handleCancel() {
    // Leaving an unverified factor behind would block a future enrolment
    // attempt (Supabase won't let you enroll a second TOTP factor while
    // one is pending), so clean it up on the way out.
    if (factorId) await supabase.auth.mfa.unenroll({ factorId }).catch(() => {})
    onCancel?.()
  }

  if (phase === 'starting') {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-8 h-8 border-4 border-ae7-red border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (phase === 'error' && !qrCode) {
    return (
      <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-xl px-4 py-3">
        <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
        {error || 'Could not start enrollment. Please try again.'}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-semibold text-sm mb-1">Scan with your authenticator app</h3>
        <p className="text-xs text-gray-400">
          Use Google Authenticator, Microsoft Authenticator, or any TOTP app.
        </p>
      </div>

      <div className="flex justify-center bg-white p-4 rounded-xl border border-gray-200 dark:border-gray-700">
        {qrCode && <img src={qrCode} alt="Scan this QR code with your authenticator app" className="w-44 h-44" />}
      </div>

      <div className="text-center">
        <button
          type="button"
          onClick={() => setShowSecret(v => !v)}
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 underline"
        >
          {showSecret ? 'Hide manual code' : "Can't scan? Enter code manually"}
        </button>
        {showSecret && (
          <p className="mt-2 font-mono text-sm tracking-wider bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2 break-all select-all">
            {secret}
          </p>
        )}
      </div>

      <form onSubmit={handleVerify} className="space-y-3">
        <div>
          <label className="label" htmlFor="mfa-code">6-digit code</label>
          <input
            id="mfa-code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
            className="input text-center text-lg tracking-[0.4em] font-mono"
            placeholder="000000"
            autoComplete="one-time-code"
            autoFocus
            required
          />
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex gap-3">
          {onCancel && (
            <button type="button" onClick={handleCancel} className="btn-secondary flex-1">
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={phase === 'verifying' || code.length !== 6}
            className="btn-primary flex-1"
          >
            {phase === 'verifying' ? (
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <><ShieldCheck size={15} /> Verify <ArrowRight size={14} /></>
            )}
          </button>
        </div>
      </form>
    </div>
  )
}
