import test from 'node:test';
import assert from 'node:assert/strict';
import { safeRedirectPath } from '../src/features/auth/utils/redirect.js';
import { oauthErrorMessage } from '../src/features/auth/utils/oauthErrors.js';

test('safeRedirectPath accepts same-site paths', () => {
  assert.equal(safeRedirectPath('/'), '/');
  assert.equal(safeRedirectPath('/events/abc'), '/events/abc');
  assert.equal(safeRedirectPath('/check-in/evt_1?token=a1b2c3#confirm'), '/check-in/evt_1?token=a1b2c3#confirm');
  assert.equal(safeRedirectPath('/roadmaps?tab=open&x=%2F%2Fevil.com'), '/roadmaps?tab=open&x=%2F%2Fevil.com');
});

test('safeRedirectPath rejects other origins and schemes', () => {
  for (const value of [
    '//evil.com',
    '//evil.com/path?x=1',
    'https://evil.com',
    'http://evil.com/login',
    'javascript:alert(1)',
    'evil.com',
    'events',
    ''
  ]) assert.equal(safeRedirectPath(value), null, value);
});

test('safeRedirectPath rejects backslash and control-character variants', () => {
  for (const value of [
    '/\\evil.com',
    '\\\\evil.com',
    '\\/evil.com',
    '/\\/evil.com',
    '/events\\..\\..\\evil',
    '/\t/evil.com',
    '/\n/evil.com',
    '/\r\n/evil.com'
  ]) assert.equal(safeRedirectPath(value), null, JSON.stringify(value));
});

test('safeRedirectPath rejects non-strings and missing values', () => {
  for (const value of [undefined, null, 42, true, {}, ['/events'], { pathname: '/events' }]) {
    assert.equal(safeRedirectPath(value), null);
  }
  assert.equal(safeRedirectPath(), null);
});

test('oauthErrorMessage stays silent when the popup is closed or cancelled', () => {
  for (const code of ['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled']) {
    assert.equal(oauthErrorMessage({ code, message: `Firebase: Error (${code}).` }, 'Google'), null);
  }
});

test('oauthErrorMessage maps Firebase codes to plain sentences', () => {
  assert.match(oauthErrorMessage({ code: 'auth/popup-blocked' }, 'Google'), /blocked the sign-in window/);
  assert.match(oauthErrorMessage({ code: 'auth/network-request-failed' }, 'Google'), /connection/);
  assert.match(oauthErrorMessage({ code: 'auth/account-exists-with-different-credential' }, 'GitHub'), /already exists/);
  assert.match(oauthErrorMessage({ code: 'auth/too-many-requests' }, 'GitHub'), /Too many/);
  assert.equal(
    oauthErrorMessage({ code: 'auth/internal-error', message: 'Firebase: Error (auth/internal-error).' }, 'GitHub'),
    'GitHub sign-in could not be completed. Please try again.'
  );
  assert.equal(
    oauthErrorMessage({ name: 'FirebaseError', code: 'permission-denied', message: 'Missing or insufficient permissions.' }, 'Google'),
    'Google sign-in could not be completed. Please try again.'
  );
});

test('oauthErrorMessage keeps app errors and falls back when empty', () => {
  assert.equal(oauthErrorMessage(new Error('This account has been suspended.'), 'Google'), 'This account has been suspended.');
  assert.equal(oauthErrorMessage(undefined, 'Google'), 'Google sign-in could not be completed. Please try again.');
});
