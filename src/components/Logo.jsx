import logoUrl from '../assets/ae7-logo.png'

// Brand logotype. Imported from src/assets (not referenced out of
// public/) so Vite fingerprints the filename — public/.htaccess caches
// images `immutable` for a year, so an un-hashed logo would be stuck in
// visitors' caches until it expired.

// Intrinsic pixel size of the asset. Passed through as width/height
// attributes so the browser can reserve the right box before the image
// loads — without them the sidebar and auth headers reflow on first paint.
const INTRINSIC = { w: 329, h: 133 }

// Displayed heights. These are ~1.25x the *ink* height of the text
// logotype this replaced — not of its font-size. A 900-weight "ae7" at
// 1.6rem only put about 1.15rem of actual ink on screen, since glyphs
// never fill their em box; matching font-size to image height would have
// come out much larger than what was there before.
//
// Nudge this one table if it wants to be bigger — every call site sizes
// through it. Width follows from the aspect ratio (2.47:1), so `md` here
// occupies roughly 57x23px.
const HEIGHTS = {
  sm: '1.15rem',
  md: '1.45rem',
  lg: '2rem',
}

const PORTAL_SIZES = {
  sm: '0.7rem',
  md: '0.8rem',
  lg: '1rem',
}

export default function Logo({ size = 'md', showPortal = true, className = '' }) {
  const height = HEIGHTS[size] || HEIGHTS.md
  const portalSize = PORTAL_SIZES[size] || PORTAL_SIZES.md

  return (
    <span className={`ae7-logo inline-flex items-center gap-1.5 ${className}`}>
      <img
        src={logoUrl}
        alt="ae7"
        width={INTRINSIC.w}
        height={INTRINSIC.h}
        // The mark's middle glyph is a very dark red (#8b0b04) that only
        // clears 1.8:1 against dark-mode backgrounds, so the wordmark reads
        // as "a 7" with a hole in it. Lifting brightness recovers it
        // without touching the light-mode rendering. A proper light/knockout
        // variant of the asset would be better if one exists.
        className="dark:brightness-125"
        style={{ height, width: 'auto', display: 'block' }}
      />
      {showPortal && (
        <span
          style={{
            fontSize: portalSize,
            fontWeight: 600,
            color: 'var(--logo-portal-color, #6b7280)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            lineHeight: 1,
          }}
        >Portal</span>
      )}
    </span>
  )
}
