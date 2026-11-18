const SILENT_CODES = new Set([
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
  'auth/user-cancelled'
]);

const MESSAGES = {
  'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.',
  'auth/network-request-failed': 'We could not reach the sign-in service. Check your connection and try again.',
  'auth/account-exists-with-different-credential': 'An account with this email already exists. Sign in with the method you used before.',
  'auth/too-many-requests': 'Too many sign-in attempts. Wait a few minutes and try again.'
};

// Plain-language message for a failed OAuth sign-in, or null when the user closed or cancelled the popup.
export function oauthErrorMessage(reason, providerLabel) {
  const fallback = `${providerLabel} sign-in could not be completed. Please try again.`;
  const code = typeof reason?.code === 'string' ? reason.code : '';
  if (SILENT_CODES.has(code)) return null;
  if (MESSAGES[code]) return MESSAGES[code];
  const message = typeof reason?.message === 'string' ? reason.message : '';
  if (code.startsWith('auth/') || reason?.name === 'FirebaseError' || message.startsWith('Firebase')) return fallback;
  return message || fallback;
}
