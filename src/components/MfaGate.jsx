// Sits between ForceChangePasswordGate and every route it guards (the two
// chain: temp-password check first, then this — see
// AUTH_HARDENING_PLAN.md Phase 3). Three things can happen here, checked
// in order:
//   1. User has a verified TOTP factor but this session hasn't satisfied
//      it yet (aal1) -> challenge screen, no way around it.
//   2. User has no factor at all -> enrolment prompt. Skippable for 7
//      days from their first login after rollout (mfa_grace_started_at,
//      migration_v18), mandatory after.
//   3. Otherwise -> render the app.
//
// Deliberately does NOT apply until onboarding is complete — a user who
// hasn't finished onboarding shouldn't be blocked by a second gate before
// the first one clears.
//
// Client-side only. This is the UX layer, not the enforcement layer — see
// AUTH_HARDENING_PLAN.md Phase 2 "Enforcement" for the server-side half
// (aal2 required on the IT-gated endpoints), which is separate work.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { ShieldAlert, ShieldCheck, ArrowRight, LogOut, AlertCircle } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import MfaEnrollFlow from './MfaEnrollFlow'
import Logo from './Logo'

const GRACE_DAYS = 7
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000

function daysLeft(startIso) {
  if (!startIso) return GRACE_DAYS
  const msLeft = new Date(startIso).getTime() + GRACE_MS - Date.now()
  return Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)))
}

function Frame({ children }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-rose-50 to-red-50 dark:from-gray-950 dark:to-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6"><Logo size="lg" showPortal={false} /></div>
        <div className="card p-8">{children}</div>
      </div>
    </div>
  )
}

function ChallengeScreen({ factorId, onVerified }) {
  const { signOut } = useAuth()
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({ factorId })
    if (chErr) { setError(chErr.message); setLoading(false); return }
    const { error: vErr } = await supabase.auth.mfa.verify({
      factorId, challengeId: challenge.id, code: code.trim(),
    })
    setLoading(false)
    if (vErr) { setError('Incorrect code. Please try again.'); return }
    onVerified()
  }

  return (
    <Frame>
      <div className="text-center mb-5">
        <div className="w-14 h-14 rounded-2xl bg-ae7-light dark:bg-ae7-red/10 flex items-center justify-center mx-auto mb-4">
          <ShieldCheck size={26} className="text-ae7-red" />
        </div>
        <h2 className="text-xl font-semibold mb-1">Verification required</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Enter the 6-digit code from your authenticator app.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <input
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
        {error && <p className="text-sm text-red-600 dark:text-red-400 text-center">{error}</p>}
        <button type="submit" disabled={loading || code.length !== 6} className="btn-primary w-full">
          {loading ? (
            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <>Verify <ArrowRight size={16} /></>
          )}
        </button>
      </form>

      <button
        onClick={signOut}
        className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 mt-5"
      >
        <LogOut size={13} /> Not your device? Sign out
      </button>
    </Frame>
  )
}

function EnrollPrompt({ mandatory, daysRemaining, enrolling, onStart, onSkip, onEnrolled, onCancel }) {
  if (enrolling) {
    return (
      <Frame>
        <MfaEnrollFlow onEnrolled={onEnrolled} onCancel={mandatory ? undefined : onCancel} />
      </Frame>
    )
  }

  return (
    <Frame>
      <div className="text-center mb-2">
        <div className="w-14 h-14 rounded-2xl bg-ae7-light dark:bg-ae7-red/10 flex items-center justify-center mx-auto mb-4">
          <ShieldAlert size={26} className="text-ae7-red" />
        </div>
        <h2 className="text-xl font-semibold mb-1">Set up two-factor authentication</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {mandatory
            ? 'Two-factor authentication is now required for your account.'
            : `Required in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}. Set it up now to avoid interruption.`}
        </p>
      </div>

      <div className="flex flex-col gap-2 mt-6">
        <button onClick={onStart} className="btn-primary w-full">
          <ShieldCheck size={15} /> Set up now
        </button>
        {!mandatory && (
          <button onClick={onSkip} className="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 py-1">
            Skip for now
          </button>
        )}
      </div>
    </Frame>
  )
}

export default function MfaGate() {
  const { user, profile, refreshProfile } = useAuth()
  const [state, setState] = useState({ checked: false })
  const [enrolling, setEnrolling] = useState(false)
  const graceWritePending = useRef(false)
  const dismissKey = user ? `mfa_prompt_dismissed:${user.id}` : null
  const [dismissed, setDismissed] = useState(() => (dismissKey ? sessionStorage.getItem(dismissKey) === '1' : false))

  const check = useCallback(async () => {
    const [{ data: factorsData }, { data: aalData }] = await Promise.all([
      supabase.auth.mfa.listFactors(),
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    ])
    const verified = (factorsData?.totp || []).find(f => f.status === 'verified')
    setState({ checked: true, verified, aal: aalData?.currentLevel })
  }, [])

  useEffect(() => {
    if (!profile?.onboarding_complete) return
    check()
  }, [profile?.onboarding_complete, check])

  // Start the grace period exactly once, the first time we know this user
  // has no verified factor. Guarded by a ref (not just the DB write
  // itself) so a slow network doesn't let a second render fire a second
  // write while the first is still in flight.
  useEffect(() => {
    if (!state.checked || state.verified) return
    if (profile?.mfa_grace_started_at || graceWritePending.current) return
    graceWritePending.current = true
    supabase
      .from('profiles')
      .update({ mfa_grace_started_at: new Date().toISOString() })
      .eq('id', user.id)
      .then(() => refreshProfile())
      .catch(() => { graceWritePending.current = false })
  }, [state.checked, state.verified, profile?.mfa_grace_started_at, user?.id, refreshProfile])

  function skip() {
    if (dismissKey) sessionStorage.setItem(dismissKey, '1')
    setDismissed(true)
  }

  // Onboarding gates first — nothing here applies until that clears.
  if (!profile?.onboarding_complete) return <Outlet />

  if (!state.checked) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-950">
        <div className="w-8 h-8 border-4 border-ae7-red border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (state.verified && state.aal === 'aal1') {
    return <ChallengeScreen factorId={state.verified.id} onVerified={check} />
  }

  if (!state.verified) {
    // profile.mfa_grace_started_at may still be NULL for one render while
    // the write above is in flight — treat that as "grace just started"
    // rather than flashing "mandatory" for a moment.
    const daysRemaining = daysLeft(profile.mfa_grace_started_at)
    const mandatory = daysRemaining <= 0

    if (!mandatory && dismissed && !enrolling) return <Outlet />

    return (
      <EnrollPrompt
        mandatory={mandatory}
        daysRemaining={daysRemaining}
        enrolling={enrolling}
        onStart={() => setEnrolling(true)}
        onSkip={skip}
        onCancel={() => setEnrolling(false)}
        onEnrolled={() => { setEnrolling(false); check() }}
      />
    )
  }

  return <Outlet />
}
