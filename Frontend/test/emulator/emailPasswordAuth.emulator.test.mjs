// End-to-end check of email-and-password accounts: the real adapter and the real
// Firebase SDK against the local Auth and Firestore emulators, with the real
// firestore.rules. Not part of `npm test`; run it with `npm run test:emulators`
// (needs Java). It refuses to run unless the emulator hosts are set, and it uses
// a bogus project and API key, so it cannot reach a real Firebase project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp, initializeApp } from 'firebase/app';
import { GoogleAuthProvider, connectAuthEmulator, getAuth, signInWithCredential, signOut } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDoc, getFirestore, setDoc, terminate } from 'firebase/firestore';
import {
  createFirebaseAuthClient,
  createFirestoreRemote,
  handleSparkRequest,
  reloadSparkStoreForTests,
  resetSparkStoreForTests,
  setCodeforcesFetcherForTests,
  setSparkAuthForTests,
  setSparkRemoteForTests,
} from '../../src/shared/services/sparkAdapter.js';
import { CodeforcesError } from '../../src/shared/services/codeforcesApi.js';

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FIRESTORE_HOST) {
  throw new Error('Emulator hosts are not set. Run this through `npm run test:emulators` (firebase emulators:exec).');
}

const storage = new Map();
globalThis.localStorage = {
  getItem: key => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, val) => storage.set(key, String(val)),
  removeItem: key => storage.delete(key),
  clear: () => storage.clear(),
};
const STORE_KEY = 'icpc_pua_spark_db_v1';
const storedState = () => JSON.parse(storage.get(STORE_KEY));

const app = initializeApp({ apiKey: 'fake-api-key', projectId: process.env.GCLOUD_PROJECT || 'demo-icpc-pua', authDomain: 'localhost' });
const auth = getAuth(app);
connectAuthEmulator(auth, `http://${AUTH_HOST}`, { disableWarnings: true });
const db = getFirestore(app);
const [firestoreHost, firestorePort] = FIRESTORE_HOST.split(':');
connectFirestoreEmulator(db, firestoreHost, Number(firestorePort));
const clients = () => ({ app, auth, db });

const solved = new Map();
setCodeforcesFetcherForTests(async handle => {
  if (!solved.has(handle.toLowerCase())) throw new CodeforcesError('not_found', 'fixture: no such handle');
  return { handle, solvedCount: solved.get(handle.toLowerCase()), submissionsScanned: 1, truncated: false };
});

const get = (path, token) => handleSparkRequest(path, { token });
const post = (path, token, body = {}) => handleSparkRequest(path, { method: 'POST', token, body: JSON.stringify(body) });
const put = (path, token, body = {}) => handleSparkRequest(path, { method: 'PUT', token, body: JSON.stringify(body) });
const login = (email, password) => post('/auth/login', null, { email, password });
const remoteDoc = async (name, id) => {
  const snap = await getDoc(doc(db, name, id));
  return snap.exists() ? snap.data() : null;
};
const status = code => error => error.status === code;

function firebaseMode() {
  setSparkRemoteForTests(createFirestoreRemote(clients));
  setSparkAuthForTests(createFirebaseAuthClient(clients));
}
function localMode() {
  setSparkRemoteForTests(null);
  setSparkAuthForTests(null);
}
// A browser that has never opened the site: empty local state, nobody signed in, same Firebase project.
async function newBrowser() {
  await signOut(auth);
  storage.clear();
  resetSparkStoreForTests();
  firebaseMode();
}
function reloadPage() {
  reloadSparkStoreForTests();
  firebaseMode();
}
async function googleSignIn(sub, email, name, emailVerified = true) {
  const credential = GoogleAuthProvider.credential(JSON.stringify({ sub, email, email_verified: emailVerified, name }));
  const { user } = await signInWithCredential(auth, credential);
  return { uid: user.uid, email, name, provider: 'google' };
}

test.after(async () => {
  localMode();
  setCodeforcesFetcherForTests(null);
  await terminate(db);
  await deleteApp(app);
});

test('register, share, and sign in on a second device', async () => {
  solved.set('pass_cf', 12);
  await newBrowser();
  const registered = await post('/auth/register', null, { name: 'Pass Word', email: 'p@student.test', username: 'passw', password: 'password123' });
  const uid = auth.currentUser.uid;
  assert.equal(registered.user.id, uid, 'the account id is the Firebase uid');
  assert.equal(auth.currentUser.providerData[0].providerId, 'password');
  assert.equal(storedState().users.find(u => u.email === 'p@student.test').passwordHash, undefined);
  assert.equal((await remoteDoc('users', uid)).username, 'passw');
  assert.equal((await remoteDoc('users', uid)).email, undefined);
  assert.equal((await remoteDoc('usernames', 'passw')).uid, uid);
  assert.deepEqual(await remoteDoc('userSecrets', uid), { email: 'p@student.test', studentId: null });

  const saved = await post('/auth/codeforces-verification/generate', registered.token, { handle: 'pass_cf' });
  assert.deepEqual(saved.shared, { ok: true, reason: null, message: '' });
  assert.equal((await remoteDoc('codeforcesHandles', 'pass_cf')).uid, uid);

  // Second device, signed out: the student is on the leaderboard for everyone.
  await newBrowser();
  let rows = (await get('/events/leaderboard')).leaderboard;
  assert.deepEqual(rows.map(row => [row.name, row.points]), [['Pass Word', 240]]);

  // Duplicate email and username are refused with the real SDK error codes.
  await assert.rejects(
    () => post('/auth/register', null, { name: 'Copy', email: 'p@student.test', username: 'copycat', password: 'password123' }),
    error => error.status === 409 && error.field === 'email' && error.message === 'An account with this email already exists.',
  );
  await assert.rejects(
    () => post('/auth/register', null, { name: 'Copy', email: 'copy@student.test', username: 'passw', password: 'password123' }),
    error => error.status === 409 && error.field === 'username',
  );

  // Wrong password and unknown email: one sentence for both.
  for (const [email, password] of [['p@student.test', 'not-the-password'], ['nobody@student.test', 'password123']]) {
    await assert.rejects(() => login(email, password), error => error.status === 401 && error.message === 'Email or password is incorrect.');
  }
  assert.equal(auth.currentUser, null);

  // Right password: the shared record is adopted, not overwritten.
  const before = await remoteDoc('users', uid);
  const second = await login('p@student.test', 'password123');
  assert.equal(second.user.id, uid);
  assert.equal(second.user.username, 'passw');
  assert.equal(second.user.profile.codeforces.solvedCount, 12);
  assert.deepEqual(await remoteDoc('users', uid), before);

  // A profile save from the second device passes the rules.
  const saved2 = await put('/auth/profile', second.token, { bio: 'hello from device two' });
  assert.equal(saved2.user.profile.codeforces.solvedCount, 12);
  assert.equal((await remoteDoc('users', uid)).profile.bio, 'hello from device two');
});

test('password change, sign-out, and a lost Firebase session', async () => {
  await newBrowser();
  const session = await post('/auth/register', null, { name: 'Changer', email: 'c@student.test', username: 'changer', password: 'password123' });

  await assert.rejects(
    () => put('/auth/password', session.token, { currentPassword: 'not-the-password', newPassword: 'new-password-1' }),
    error => error.status === 401 && error.message === 'Your current password is incorrect.',
  );
  assert.deepEqual(await put('/auth/password', session.token, { currentPassword: 'password123', newPassword: 'new-password-1' }), { message: 'Password updated.' });
  assert.equal(storedState().users.find(u => u.email === 'c@student.test').passwordHash, undefined);

  // Sign-out signs out of Firebase Auth as well.
  assert.deepEqual(await post('/auth/logout', session.token), { signedOut: true });
  assert.equal(auth.currentUser, null);
  await assert.rejects(() => get('/auth/me', session.token), status(401));

  await assert.rejects(() => login('c@student.test', 'password123'), status(401));
  const again = await login('c@student.test', 'new-password-1');
  assert.equal(again.user.id, session.user.id);

  // Reload with the Firebase user present: still signed in.
  reloadPage();
  assert.equal((await get('/auth/me', again.token)).user.id, session.user.id);

  // The Firebase session disappears (site data cleared): the adapter session ends too.
  await signOut(auth);
  reloadPage();
  await assert.rejects(() => get('/auth/me', again.token), error => error.status === 401 && /sign in again/.test(error.message));
  await assert.rejects(() => put('/auth/profile', again.token, { bio: 'x' }), status(401));

  // A Google account has no password to change.
  await newBrowser();
  const google = await googleSignIn('sub-g1', 'g1@student.test', 'Google One');
  const googleSession = await post('/auth/oauth', null, google);
  await assert.rejects(
    () => put('/auth/password', googleSession.token, { currentPassword: 'x', newPassword: 'new-password-1' }),
    error => error.status === 400 && /signs in with Google/.test(error.message),
  );
});

test('a local-only account is moved onto Firebase Auth at its next login', async () => {
  solved.set('legacy_cf', 7);
  await signOut(auth);
  storage.clear();
  resetSparkStoreForTests();
  localMode();

  // Before the switch: everything lives in this browser.
  const legacy = await post('/auth/register', null, { name: 'Legacy Student', email: 'legacy@student.test', username: 'legacy_user', password: 'password123' });
  const oldId = legacy.user.id;
  assert.match(oldId, /^usr_/);
  await put('/auth/student-id', legacy.token, { studentId: '20249999' });
  await post('/auth/codeforces-verification/generate', legacy.token, { handle: 'legacy_cf' });
  const admin = await post('/auth/oauth', null, { email: 'enjoyplayax@gmail.com', name: 'Admin' });
  const now = Date.now();
  const { event } = await post('/admin/events', admin.token, {
    title: 'Local Event',
    description: 'Fixture event.',
    category: 'Contest',
    location: 'Lab 1',
    startsAt: new Date(now - 3600000).toISOString(),
    endsAt: new Date(now + 3600000).toISOString(),
    capacity: 50,
    attendancePoints: 25,
    status: 'published',
  });
  await post(`/events/${event.id}/registrations`, legacy.token);
  const slug = 'level-0-37e4fa';
  const { roadmap } = await get(`/roadmaps/${slug}`);
  await put(`/roadmaps/${slug}/progress`, legacy.token, { nodeId: roadmap.nodes[0].id, problemUrl: roadmap.nodes[0].problems[0].url, solved: true });
  const { cycles } = await get(`/roadmaps/${slug}/cycles`, legacy.token);
  await post(`/roadmaps/${slug}/cycles/${cycles[0]._id}/enroll`, legacy.token);

  // After the switch: the old session asks for a new sign-in, which moves the account.
  reloadPage();
  await assert.rejects(() => get('/auth/me', legacy.token), status(401));
  const moved = await login('legacy@student.test', 'password123');
  const uid = auth.currentUser.uid;
  assert.equal(moved.user.id, uid);
  assert.equal(moved.user.username, 'legacy_user');
  assert.equal(moved.user.studentId, '20249999');
  assert.equal(moved.user.profile.codeforces.solvedCount, 7);

  const state = storedState();
  assert.ok(!JSON.stringify(state).includes(oldId), 'no reference to the old id is left in local state');
  const record = state.users.find(u => u.email === 'legacy@student.test');
  assert.equal(record.passwordHash, undefined);
  assert.equal(record.pendingRemote, undefined, 'the rules accepted everything that was sent');

  assert.equal((await remoteDoc('users', uid)).username, 'legacy_user');
  assert.equal((await remoteDoc('users', uid)).profile.codeforces.solvedCount, 7);
  assert.equal((await remoteDoc('usernames', 'legacy_user')).uid, uid);
  assert.equal((await remoteDoc('studentIds', '20249999')).uid, uid);
  assert.equal((await remoteDoc('codeforcesHandles', 'legacy_cf')).uid, uid);
  assert.deepEqual(await remoteDoc('userSecrets', uid), { email: 'legacy@student.test', studentId: '20249999' });
  assert.equal((await remoteDoc('registrations', `${event.id}_${uid}`)).user, uid);
  assert.equal((await remoteDoc('roadmapEnrollments', `${cycles[0]._id}_${uid}`)).student, uid);
  assert.equal((await remoteDoc('roadmapProgress', `${roadmap.id}_${uid}`)).solvedProblems.length, 1);
  assert.equal((await get('/dashboard', moved.token)).dashboard.stats.registeredEvents, 1);

  // Signing in again changes nothing and no write is rejected.
  await post('/auth/logout', moved.token);
  reloadPage();
  const again = await login('legacy@student.test', 'password123');
  assert.equal(again.user.id, uid);
  assert.equal(storedState().users.filter(u => u.email === 'legacy@student.test').length, 1);
  assert.equal(storedState().users.find(u => u.email === 'legacy@student.test').pendingRemote, undefined);

  // The old local password hash is gone: after a password change only the new one works.
  await put('/auth/password', again.token, { currentPassword: 'password123', newPassword: 'new-password-1' });
  await post('/auth/logout', again.token);
  await assert.rejects(() => login('legacy@student.test', 'password123'), status(401));
  assert.equal((await login('legacy@student.test', 'new-password-1')).user.id, uid);

  // Another device sees the moved student.
  await newBrowser();
  const rows = (await get('/events/leaderboard')).leaderboard;
  assert.ok(rows.some(row => row.name === 'Legacy Student' && row.points === 140));
});

test('the email already belongs to a Google account', async () => {
  // The student used Google on another device first; that account has a shared record.
  await newBrowser();
  const google = await googleSignIn('sub-shared', 'both@student.test', 'Both Ways');
  const first = await post('/auth/oauth', null, google);
  await put('/auth/username', first.token, { username: 'both_ways' });
  const sharedBefore = await remoteDoc('users', google.uid);
  assert.equal(sharedBefore.username, 'both_ways');

  // This device: a local-only account with the same email and one registration.
  await signOut(auth);
  storage.clear();
  resetSparkStoreForTests();
  localMode();
  const local = await post('/auth/register', null, { name: 'Local Copy', email: 'both@student.test', username: 'local_copy', password: 'password123' });
  const admin = await post('/auth/oauth', null, { email: 'enjoyplayax@gmail.com', name: 'Admin' });
  const now = Date.now();
  const { event } = await post('/admin/events', admin.token, {
    title: 'Another Local Event',
    description: 'Fixture event.',
    category: 'Contest',
    location: 'Lab 1',
    startsAt: new Date(now - 3600000).toISOString(),
    endsAt: new Date(now + 3600000).toISOString(),
    capacity: 50,
    attendancePoints: 25,
    status: 'published',
  });
  await post(`/events/${event.id}/registrations`, local.token);
  reloadPage();

  // Password login cannot create a second Firebase account for this email.
  await assert.rejects(
    () => login('both@student.test', 'password123'),
    error => error.status === 409 && /signs in with Google, GitHub or a different password/.test(error.message),
  );
  assert.equal(auth.currentUser, null);
  assert.ok(storedState().users.find(u => u.id === local.user.id).passwordHash, 'the local account is untouched');

  // Google sign-in: the shared record wins, the local registration is added to it.
  const again = await googleSignIn('sub-shared', 'both@student.test', 'Both Ways');
  assert.equal(again.uid, google.uid);
  const session = await post('/auth/oauth', null, again);
  assert.equal(session.user.id, google.uid);
  assert.equal(session.user.username, 'both_ways');
  assert.deepEqual(await remoteDoc('users', google.uid), sharedBefore, 'the shared record was not overwritten');
  assert.equal(await remoteDoc('usernames', 'local_copy'), null);
  assert.ok(!JSON.stringify(storedState()).includes(local.user.id));
  assert.equal((await remoteDoc('registrations', `${event.id}_${google.uid}`)).user, google.uid);
});

test('firestore.rules: an unverified email never grants admin', async () => {
  // Anyone can type the owner's email into the sign-up form. The account is
  // created (nobody else holds the email in this emulator), but it is not an admin.
  await newBrowser();
  const impostor = await post('/auth/register', null, { name: 'Impostor', email: 'enjoyplayax@gmail.com', username: 'impostor', password: 'password123' });
  assert.equal(auth.currentUser.emailVerified, false);
  await assert.rejects(setDoc(doc(db, 'events', 'evt_forged'), { title: 'Forged', status: 'published' }));
  await assert.rejects(setDoc(doc(db, 'admins', auth.currentUser.uid), { email: 'enjoyplayax@gmail.com' }));
  await assert.rejects(setDoc(doc(db, 'users', 'someone-else'), { name: 'Overwritten' }, { merge: true }));
  assert.equal(await remoteDoc('users', impostor.user.id), null, 'a record that claims role admin is not accepted either');
  await signOut(auth);

  // The same email verified by Google is an admin. (The emulator's accounts are
  // cleared first so the email is free; this endpoint exists only in the emulator.)
  const cleared = await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${app.options.projectId}/accounts`, { method: 'DELETE' });
  assert.equal(cleared.ok, true);
  await googleSignIn('sub-owner', 'enjoyplayax@gmail.com', 'Owner');
  assert.equal(auth.currentUser.emailVerified, true);
  await setDoc(doc(db, 'events', 'evt_real'), { title: 'Real', status: 'published' });
  assert.equal((await remoteDoc('events', 'evt_real')).title, 'Real');
  await signOut(auth);
});
