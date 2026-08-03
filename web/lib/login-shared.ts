/**
 * Sanitize the `next` redirect to a safe same-origin relative path; otherwise '/'.
 *
 * Allow only: starts with '/', the 2nd char is not '/' or '\\' (blocks //evil.com and the
 * backslash-bypass /\evil.com; browsers normalize '\' to '/', contains no '\\' anywhere,
 * and length <= 2048. '/@evil.com' is allowed (it is a same-origin path, not an authority).
 */
export function safeNext(raw: string): string {
  if (typeof raw !== 'string') return '/';
  if (raw.length === 0 || raw.length > 2048) return '/';
  if (raw[0] !== '/') return '/';
  if (raw[1] === '/' || raw[1] === '\\') return '/';
  if (raw.includes('\\')) return '/';
  return raw;
}
