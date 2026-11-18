const PROBE_ORIGIN = 'https://redirect-check.invalid';

// Returns `value` when it is a same-site path ("/events/1?token=x#top"), otherwise null.
// Rejects protocol-relative ("//host"), schemes ("https:", "javascript:"), backslashes
// (browsers read "/\host" as "//host") and control characters (the URL parser drops them).
export function safeRedirectPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, PROBE_ORIGIN);
    if (url.origin !== PROBE_ORIGIN) return null;
    // Dot segments ("/.//host") normalise to "//host", so check again after parsing.
    if (url.pathname.startsWith('//')) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
