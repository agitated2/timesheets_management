// Formats a TIMESTAMPTZ (ISO string) in a specific IANA timezone, using
// Intl.DateTimeFormat directly rather than adding date-fns-tz — date-fns
// v3 is already a dependency but can't format into an arbitrary IANA zone
// without that extra package, and Node 22 / all target browsers ship full
// ICU, so Intl needs nothing extra.
//
// Deliberately NOT viewer-local: two people in different timezones must
// see the identical string for the same submission, or "was this late?"
// becomes a question with a different answer depending on who's asking —
// see HRTimesheets.jsx's formatStamp, which this replaces.
export function formatInOfficeTime(iso, timeZone) {
  if (!iso) return '—'

  if (!timeZone) {
    // No office timezone on record — fall back to the viewer's own clock,
    // but say so explicitly. An unlabelled fallback would silently
    // reintroduce the exact ambiguity this function exists to remove.
    const local = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(iso))
    return `${local} (your time zone)`
  }

  // `timeZoneName` cannot be combined with `dateStyle`/`timeStyle` — the
  // Intl spec forbids mixing "style" shorthands with individual date-time
  // component options, and throws `TypeError: Invalid option : option` for
  // every call, valid timeZone or not. Spell out the components instead.
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso))
}
