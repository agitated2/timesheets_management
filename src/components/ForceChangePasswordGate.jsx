// Sits between ProtectedRoute and MfaGate — see AUTH_HARDENING_PLAN.md
// Phase 3's stated gate ordering: temp password -> forced change -> MFA
// enrolment. A bulk-imported account's temporary password (see
// bulk-import-users) must never quietly become permanent.
//
// In practice this only ever fires for bulk-imported accounts: they're
// the only path that sets must_change_password, and they're created with
// onboarding_complete already true, so there's no real interaction with
// the onboarding redirect in ProtectedRoute. The onboarding guard below
// is kept anyway, purely for symmetry with MfaGate's own — cheap, and it
// keeps the invariant "nothing past onboarding gates before onboarding
// itself" true everywhere rather than true almost everywhere.

import { useState } from 'react'
import { KeyRound, ArrowRight, LogOut, Eye, EyeOff } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import Logo from './Logo'
import MfaGate from './MfaGate'

// Mirrors the Phase 0 recommended Supabase password policy (min length
// 12) as a client-side floor — enforced here regardless of whether that
// dashboard setting has actually been turned on yet.
const MIN_LENGTH = 12

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

export default function ForceChangePasswordGate() {
  const { user, profile, refreshProfile, signOut } = useAuth()
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (!profile?.must_change_password) return <MfaGate />

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (newPassword.length < MIN_LENGTH) { setError(`Password must be at least ${MIN_LENGTH} characters.`); return }
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return }

    setLoading(true)
    const { error: pwErr } = await supabase.auth.updateUser({ password: newPassword })
    if (pwErr) { setError(pwErr.message); setLoading(false); return }

    // Self-clearable: profiles_update_own already lets a user write their
    // own full_name, and this column was deliberately left out of the
    // v15 privileged-column guard (see migration_v19) — clearing your OWN
    // flag after actually changing your password isn't privilege-sensitive.
    const { error: profErr } = await supabase.from('profiles').update({ must_change_password: false }).eq('id', user.id)
    setLoading(false)
    if (profErr) { setError(profErr.message); return }
    await refreshProfile()
  }

  return (
    <Frame>
      <div className="text-center mb-5">
        <div className="w-14 h-14 rounded-2xl bg-ae7-light dark:bg-ae7-red/10 flex items-center justify-center mx-auto mb-4">
          <KeyRound size={26} className="text-ae7-red" />
        </div>
        <h2 className="text-xl font-semibold mb-1">Set a new password</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          You're signed in with a temporary password. Choose your own before continuing.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label" htmlFor="new-pw">New password</label>
          <div className="relative">
            <input
              id="new-pw"
              type={show ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="input pr-10"
              placeholder={`Min. ${MIN_LENGTH} characters`}
              autoComplete="new-password"
              autoFocus
              required
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              tabIndex={-1}
            >
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="confirm-pw">Confirm password</label>
          <input
            id="confirm-pw"
            type={show ? 'text' : 'password'}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="input"
            placeholder="Repeat password"
            autoComplete="new-password"
            required
          />
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <button type="submit" disabled={loading} className="btn-primary w-full">
          {loading ? (
            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <>Continue <ArrowRight size={16} /></>
          )}
        </button>
      </form>

      <button
        onClick={signOut}
        className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 mt-5"
      >
        <LogOut size={13} /> Not your account? Sign out
      </button>
    </Frame>
  )
}
