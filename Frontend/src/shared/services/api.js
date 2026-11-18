import { handleSparkRequest } from './sparkAdapter.js';
import { signOutFirebase } from './firebase.js';
export { signInWithOAuthProvider, signOutFirebase } from './firebase.js';

export async function api(path, options = {}) {
  return handleSparkRequest(path, options);
}

// Ends the adapter session and the Firebase Auth session together, whichever
// way the member signed in. Never throws: signing out always completes locally.
export async function signOutEverywhere(token) {
  try {
    await handleSparkRequest('/auth/logout', { method: 'POST', token });
  } catch {
    // The local session is dropped by the caller either way.
  }
  await signOutFirebase();
}

export function eventDate(value, options = {}) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...options,
  }).format(new Date(value));
}
