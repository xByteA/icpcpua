const SESSION_EXPIRED = { message: 'Your session has expired. Please sign in again.', status: 401 };
const UNREACHABLE = { message: 'We could not reach the sign-in service. Check your connection and try again.', status: 503 };

// Firebase Auth reports a wrong password and an unknown email with the same code
// when email enumeration protection is on, and with separate codes when it is
// off. All of them get one sentence, so the form never reveals which was wrong.
const WRONG_CREDENTIALS = new Set([
  'auth/invalid-credential',
  'auth/invalid-login-credentials',
  'auth/wrong-password',
  'auth/user-not-found',
]);

const MESSAGES = {
  'auth/email-already-in-use': { message: 'An account with this email already exists.', status: 409, field: 'email' },
  'auth/invalid-email': { message: 'Enter a valid email address.', status: 400, field: 'email' },
  'auth/weak-password': { message: 'This password is too easy to guess. Choose a longer one.', status: 400, field: 'password' },
  'auth/password-does-not-meet-requirements': { message: 'This password does not meet the password rules. Choose a longer one with a mix of characters.', status: 400, field: 'password' },
  'auth/too-many-requests': { message: 'Too many attempts. Wait a few minutes and try again.', status: 429 },
  'auth/network-request-failed': UNREACHABLE,
  'auth/timeout': UNREACHABLE,
  timeout: UNREACHABLE,
  'auth/user-disabled': { message: 'This account has been disabled. Contact the club admins.', status: 403 },
  'auth/operation-not-allowed': { message: 'Email sign-in is not available right now. Use Google or GitHub, or try again later.', status: 503 },
  'auth/requires-recent-login': SESSION_EXPIRED,
  'auth/user-token-expired': SESSION_EXPIRED,
  'auth/user-mismatch': SESSION_EXPIRED,
  'auth/null-user': SESSION_EXPIRED,
};

const WRONG_CREDENTIALS_MESSAGE = {
  login: 'Email or password is incorrect.',
  register: 'Email or password is incorrect.',
  'change-password': 'Your current password is incorrect.',
};

const FALLBACK_MESSAGE = {
  login: 'Sign-in could not be completed. Please try again.',
  register: 'Your account could not be created. Please try again.',
  'change-password': 'Your password could not be changed. Please try again.',
};

export function emailAuthErrorCode(reason) {
  return typeof reason?.code === 'string' ? reason.code : '';
}

// True when the sign-in service answered and refused this email and password.
export function isWrongCredentials(reason) {
  return WRONG_CREDENTIALS.has(emailAuthErrorCode(reason));
}

// Plain-language result for a failed email-and-password request:
// { message, status, field }. `field` names the form input to mark, or is ''.
// `action` is 'login', 'register' or 'change-password'.
export function emailAuthError(reason, action = 'login') {
  const code = emailAuthErrorCode(reason);
  if (WRONG_CREDENTIALS.has(code)) {
    return { message: WRONG_CREDENTIALS_MESSAGE[action] || WRONG_CREDENTIALS_MESSAGE.login, status: 401, field: '' };
  }
  const known = MESSAGES[code];
  if (known) return { field: '', ...known };
  return { message: FALLBACK_MESSAGE[action] || FALLBACK_MESSAGE.login, status: 500, field: '' };
}
