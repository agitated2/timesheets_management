export default function Logo({ size = 'md', showPortal = true, className = '' }) {
  const sizes = {
    sm: { mark: '1.25rem', portal: '0.7rem' },
    md: { mark: '1.6rem',  portal: '0.8rem' },
    lg: { mark: '2.2rem',  portal: '1rem'   },
  }
  const s = sizes[size] || sizes.md

  return (
    <span className={`ae7-logo inline-flex items-baseline gap-1.5 ${className}`}>
      <span className="inline-flex items-baseline leading-none" style={{ lineHeight: 1 }}>
        <span
          style={{
            fontWeight: 900,
            fontSize: s.mark,
            color: '#C41230',
            letterSpacing: '-0.04em',
            lineHeight: 1,
          }}
        >ae</span>
        <span
          style={{
            fontWeight: 900,
            fontSize: s.mark,
            color: '#A8896A',
            lineHeight: 1,
          }}
        >7</span>
      </span>
      {showPortal && (
        <span
          style={{
            fontSize: s.portal,
            fontWeight: 600,
            color: 'var(--logo-portal-color, #6b7280)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            lineHeight: 1,
            paddingBottom: '0.1em',
          }}
        >Portal</span>
      )}
    </span>
  )
}
