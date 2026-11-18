import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  handleSparkRequest,
  reloadSparkStoreForTests,
  resetSparkStoreForTests,
  setCodeforcesFetcherForTests,
  setSparkAuthForTests,
  setSparkRemoteForTests,
} from '../src/shared/services/sparkAdapter.js';
import { CodeforcesError } from '../src/shared/services/codeforcesApi.js';
import { emailAuthError, isWrongCredentials } from '../src/features/auth/utils/emailAuthErrors.js';
import { authError, createFakeFirebase, installLocalStorage } from './helpers/fakeFirebase.js';

const storage = installLocalStorage();
const STORE_KEY = 'icpc_pua_spark_db_v1';
const ROADMAP_SLUG = 'level-0-37e4fa';
const EMAIL = 'legacy@pua.edu.eg';
const PASSWORD = 'password123';

const storedState = () => JSON.parse(storage.get(STORE_KEY));
const get = (path, token) => handleSparkRequest(path, { token });
const post = (path, token, body = {}) => handleSparkRequest(path, { method: 'POST', token, body: JSON.stringify(body) });
const put = (path, token, body = {}) => handleSparkRequest(path, { method: 'PUT', token, body: JSON.stringify(body) });
const login = (email, password) => post('/auth/login', null, { email, password });
const status = code => error => error.status === code;

// Fake Codeforces: handle -> solved count.
const codeforcesAccounts = new Map();
function installCodeforces() {
  codeforcesAccounts.clear();
  setCodeforcesFetcherForTests(async handle => {
    const account = codeforcesAccounts.get(handle.toLowerCase());
    if (!account) throw new CodeforcesError('not_found', 'fixture: no such handle');
    return { handle: account.handle, solvedCount: account.solved, submissionsScanned: account.solved, truncated: false };
  });
}
const cfAccount = (handle, solved) => codeforcesAccounts.set(handle.toLowerCase(), { handle, solved });

// Firebase not in use: accounts live in local state only.
function localMode() {
  setSparkRemoteForTests(null);
  setSparkAuthForTests(null);
}
// Firebase in use. Also what a page load does: hydration starts again.
function firebaseMode(firebase) {
  setSparkRemoteForTests(firebase.remote);
  setSparkAuthForTests(firebase.auth);
}
// A browser that has never opened the site. Firebase Auth has no user in it.
function freshBrowser(firebase = null) {
  storage.clear();
  resetSparkStoreForTests();
  installCodeforces();
  if (firebase) {
    firebase.auth.dropSession();
    firebaseMode(firebase);
  } else {
    localMode();
  }
}
// Same browser, page reloaded: state comes back from localStorage.
function reloadPage(firebase) {
  reloadSparkStoreForTests();
  if (firebase) firebaseMode(firebase);
  else localMode();
}

const registerBody = (overrides = {}) => ({ name: 'Legacy Student', email: EMAIL, username: 'legacy_user', password: PASSWORD, ...overrides });

// An account created before email-and-password sign-in moved onto Firebase Auth.
async function createLocalOnlyAccount(overrides = {}) {
  localMode();
  const session = await post('/auth/register', null, registerBody(overrides));
  assert.match(session.user.id, /^usr_/);
  return session;
}

const sharedRecord = (name, handle, solvedCount) => ({
  name,
  username: name.toLowerCase().replace(/\s+/g, '_'),
  role: 'user',
  profile: {
    links: { codeforcesHandle: handle },
    codeforces: { handle, solvedCount, syncedAt: '2026-11-18T07:00:00.000Z', truncated: false },
  },
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-18T07:00:00.000Z',
});

test.after(() => {
  setCodeforcesFetcherForTests(null);
  localMode();
});

test('email-and-password error messages', async t => {
  await t.test('a wrong password and an unknown email read the same', () => {
    const messages = ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-login-credentials'].map(
      code => emailAuthError(authError(code), 'login'),
    );
    for (const result of messages) assert.deepEqual(result, { message: 'Email or password is incorrect.', status: 401, field: '' });
    assert.equal(isWrongCredentials(authError('auth/invalid-credential')), true);
    assert.equal(isWrongCredentials(authError('auth/network-request-failed')), false);
    assert.equal(emailAuthError(authError('auth/wrong-password'), 'change-password').message, 'Your current password is incorrect.');
  });

  await t.test('each known code gets a plain sentence and the right form field', () => {
    assert.deepEqual(emailAuthError(authError('auth/email-already-in-use'), 'register'), {
      message: 'An account with this email already exists.',
      status: 409,
      field: 'email',
    });
    assert.equal(emailAuthError(authError('auth/invalid-email'), 'register').field, 'email');
    assert.equal(emailAuthError(authError('auth/weak-password'), 'register').field, 'password');
    assert.equal(emailAuthError(authError('auth/password-does-not-meet-requirements'), 'register').status, 400);
    assert.match(emailAuthError(authError('auth/too-many-requests'), 'login').message, /Too many attempts/);
    assert.equal(emailAuthError(authError('auth/too-many-requests'), 'login').status, 429);
    assert.match(emailAuthError(authError('auth/network-request-failed'), 'login').message, /could not reach the sign-in service/);
    assert.match(emailAuthError(authError('auth/operation-not-allowed'), 'login').message, /Use Google or GitHub/);
    assert.match(emailAuthError(authError('auth/requires-recent-login'), 'change-password').message, /sign in again/);
  });

  await t.test('nothing from the SDK leaks into the message', () => {
    for (const reason of [authError('auth/some-new-code'), new Error('Firebase: Error (auth/whatever).'), null, undefined, {}]) {
      const { message } = emailAuthError(reason, 'login');
      assert.equal(message, 'Sign-in could not be completed. Please try again.');
    }
    assert.equal(emailAuthError(authError('auth/x'), 'register').message, 'Your account could not be created. Please try again.');
  });
});

test('email-and-password accounts on Firebase Auth', async t => {
  await t.test('register: the account id is the Firebase uid and the record is shared', async () => {
    const firebase = createFakeFirebase();
    freshBrowser(firebase);
    cfAccount('new_cf', 4);
    const session = await post('/auth/register', null, registerBody({ name: 'New Student', username: 'new_student' }));
    const uid = firebase.auth.accounts.get(EMAIL).uid;

    assert.deepEqual(Object.keys(session).sort(), ['token', 'user']);
    assert.equal(session.user.id, uid);
    assert.equal(session.user.username, 'new_student', 'the username step is not needed');
    assert.equal(session.user.email, EMAIL);
    assert.equal(session.user.role, 'user');
    assert.equal(firebase.auth.uid, uid, 'signed in to Firebase Auth');

    const record = storedState().users.find(u => u.email === EMAIL);
    assert.equal(record.id, uid);
    assert.equal(record.passwordHash, undefined, 'no password hash is kept in this browser');
    assert.equal(record.pendingRemote, undefined);
    assert.ok(!storage.get(STORE_KEY).includes(PASSWORD));

    assert.equal(firebase.remote.get('users', uid).username, 'new_student');
    assert.equal(firebase.remote.get('users', uid).email, undefined, 'the public record never carries the email');
    assert.equal(firebase.remote.get('usernames', 'new_student').uid, uid);
    assert.deepEqual(firebase.remote.get('userSecrets', uid), { email: EMAIL, studentId: null });

    // The point of the change: this member is on the shared leaderboard.
    const saved = await post('/auth/codeforces-verification/generate', session.token, { handle: 'new_cf' });
    assert.deepEqual(saved.shared, { ok: true, reason: null, message: '' });
    assert.equal(firebase.remote.get('users', uid).profile.codeforces.solvedCount, 4);

    freshBrowser(firebase);
    const { leaderboard } = await get('/events/leaderboard');
    assert.deepEqual(leaderboard.map(row => [row.name, row.points]), [['New Student', 80]]);
  });

  await t.test('register: duplicate email, taken username and weak password are refused with the field marked', async () => {
    const firebase = createFakeFirebase();
    freshBrowser(firebase);
    await post('/auth/register', null, registerBody({ username: 'first_user' }));

    // Same browser: the email is already in local state.
    await assert.rejects(
      () => post('/auth/register', null, registerBody({ username: 'second_user' })),
      error => error.status === 409 && error.field === 'email',
    );

    // Another device: only Firebase Auth knows the email.
    freshBrowser(firebase);
    await assert.rejects(
      () => post('/auth/register', null, registerBody({ username: 'second_user' })),
      error => error.status === 409 && error.field === 'email' && error.message === 'An account with this email already exists.',
    );
    assert.equal(storedState().users.filter(u => u.email === EMAIL).length, 0, 'nothing was created locally');

    // A device whose first load could not read the member list: local state does
    // not know the username, the lock in Firestore does. It is checked before a
    // Firebase Auth account is created.
    firebase.remote.offline = true;
    freshBrowser(firebase);
    await get('/roadmaps');
    firebase.remote.offline = false;
    const usersBefore = storedState().users.length;
    assert.equal(storedState().users.some(u => u.username === 'first_user'), false);
    await assert.rejects(
      () => post('/auth/register', null, registerBody({ email: 'other@pua.edu.eg', username: 'first_user' })),
      error => error.status === 409 && error.field === 'username',
    );
    assert.equal(firebase.auth.accounts.has('other@pua.edu.eg'), false);

    firebase.auth.register = async () => {
      throw authError('auth/weak-password');
    };
    await assert.rejects(
      () => post('/auth/register', null, registerBody({ email: 'weak@pua.edu.eg', username: 'weak_user' })),
      error => error.status === 400 && error.field === 'password',
    );
    assert.equal(storedState().users.length, usersBefore);
  });

  await t.test('login on a second device adopts the shared record instead of wiping it', async () => {
    const firebase = createFakeFirebase();
    freshBrowser(firebase);
    cfAccount('roaming_cf', 9);
    const first = await post('/auth/register', null, registerBody({ name: 'Roaming Student', username: 'roaming' }));
    await post('/auth/codeforces-verification/generate', first.token, { handle: 'roaming_cf' });
    const uid = first.user.id;
    const sharedBefore = structuredClone(firebase.remote.get('users', uid));

    freshBrowser(firebase);
    const second = await login(EMAIL, PASSWORD);
    assert.equal(second.user.id, uid);
    assert.equal(second.user.username, 'roaming');
    assert.equal(second.user.name, 'Roaming Student');
    assert.equal(second.user.email, EMAIL);
    assert.equal(second.user.profile.codeforces.solvedCount, 9);
    assert.deepEqual(firebase.remote.get('users', uid), sharedBefore, 'signing in wrote nothing over the shared record');
    assert.equal(storedState().users.find(u => u.id === uid).passwordHash, undefined);

    // The shared record is found even when the public list could not be read.
    freshBrowser(firebase);
    const realList = firebase.remote.list;
    firebase.remote.list = async () => {
      throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
    };
    const third = await login(EMAIL, PASSWORD);
    firebase.remote.list = realList;
    assert.equal(third.user.username, 'roaming');
    assert.deepEqual(firebase.remote.get('users', uid), sharedBefore);
  });

  await t.test('login: wrong password and unknown email get the same answer and no session', async () => {
    const firebase = createFakeFirebase();
    freshBrowser(firebase);
    await post('/auth/register', null, registerBody());
    await post('/auth/logout', null);
    const sessionsBefore = Object.keys(storedState().sessionsByToken).length;
    for (const [email, password] of [[EMAIL, 'not-the-password'], ['nobody@pua.edu.eg', PASSWORD]]) {
      await assert.rejects(
        () => login(email, password),
        error => error.status === 401 && error.message === 'Email or password is incorrect.',
      );
    }
    assert.equal(Object.keys(storedState().sessionsByToken).length, sessionsBefore);
    assert.equal(firebase.auth.uid, null);
  });

  await t.test('login: too many attempts, network failure and a disabled account are said plainly', async () => {
    const firebase = createFakeFirebase();
    freshBrowser(firebase);
    await post('/auth/register', null, registerBody());
    await post('/auth/logout', null);

    firebase.auth.outage = 'auth/too-many-requests';
    await assert.rejects(() => login(EMAIL, PASSWORD), error => error.status === 429 && /Too many attempts/.test(error.message));
    firebase.auth.outage = 'auth/network-request-failed';
    await assert.rejects(() => login(EMAIL, PASSWORD), error => error.status === 503 && /could not reach the sign-in service/.test(error.message));
    firebase.auth.outage = null;
    firebase.auth.accounts.get(EMAIL).disabled = true;
    await assert.rejects(() => login(EMAIL, PASSWORD), error => error.status === 403 && /disabled/.test(error.message));
  });
});

test('moving a local-only account onto Firebase Auth', async t => {
  // A local-only student with every kind of row the adapter keeps, plus a local-only admin.
  async function seedLocalOnlyBrowser() {
    freshBrowser();
    cfAccount('legacy_cf', 7);
    const student = await createLocalOnlyAccount();
    const admin = await post('/auth/register', null, { name: 'Legacy Admin', email: 'admin@icpcpua.com', username: 'legacy_admin', password: 'adminpass123' });
    assert.equal(admin.user.role, 'admin');
    await put('/auth/student-id', student.token, { studentId: '20249999' });
    await post('/auth/codeforces-verification/generate', student.token, { handle: 'legacy_cf' });

    const now = Date.now();
    const eventBody = title => ({
      title,
      description: 'Fixture event.',
      category: 'Contest',
      location: 'Lab 1',
      startsAt: new Date(now - 3600000).toISOString(),
      endsAt: new Date(now + 3600000).toISOString(),
      capacity: 50,
      attendancePoints: 25,
      status: 'published',
    });
    const { event: openEvent } = await post('/admin/events', admin.token, eventBody('Open Event'));
    const { event: attendedEvent } = await post('/admin/events', admin.token, eventBody('Attended Event'));
    await post(`/events/${openEvent.id}/registrations`, student.token);
    await post(`/events/${attendedEvent.id}/registrations`, student.token);
    const qr = await post(`/admin/events/${attendedEvent.id}/check-in-qr`, admin.token);
    await post(`/events/${attendedEvent.id}/check-in`, student.token, { token: new URL(qr.checkInUrl).searchParams.get('token') });

    const { roadmap } = await get(`/roadmaps/${ROADMAP_SLUG}`);
    const node = roadmap.nodes[0];
    await put(`/roadmaps/${ROADMAP_SLUG}/progress`, student.token, { nodeId: node.id, problemUrl: node.problems[0].url, solved: true });
    const { cycles } = await get(`/roadmaps/${ROADMAP_SLUG}/cycles`, student.token);
    const cycleId = cycles[0]._id;
    await post(`/roadmaps/${ROADMAP_SLUG}/cycles/${cycleId}/enroll`, student.token);
    const cycle = await get(`/roadmaps/${ROADMAP_SLUG}/cycles/${cycleId}`, student.token);
    const sessionId = cycle.sessions[0]._id;
    await post(`/admin/roadmap-sessions/${sessionId}/attendance`, admin.token, { studentId: student.user.id });

    // Nothing in the adapter creates notifications yet, so one is placed in storage directly.
    const state = storedState();
    state.notifications.push({ id: 'ntf_1', _id: 'ntf_1', user: student.user.id, title: 'Welcome', message: 'Hello', readAt: null, createdAt: '2026-11-01T00:00:00.000Z' });
    storage.set(STORE_KEY, JSON.stringify(state));
    reloadSparkStoreForTests();

    return { student, admin, oldId: student.user.id, openEvent, attendedEvent, roadmapId: roadmap.id, cycleId, sessionId };
  }

  await t.test('first login after the switch: every reference follows the account to its Firebase uid', async () => {
    const seeded = await seedLocalOnlyBrowser();
    const { oldId, openEvent, attendedEvent, roadmapId, cycleId, sessionId } = seeded;
    const firebase = createFakeFirebase();
    reloadPage(firebase);

    // The session from before the switch is not backed by Firebase Auth: sign in again.
    await assert.rejects(() => get('/auth/me', seeded.student.token), status(401));
    // Signed-out pages still work with the stale token in the browser.
    assert.ok((await get('/roadmaps', seeded.student.token)).roadmaps.length >= 1);

    const session = await login(EMAIL, PASSWORD);
    const uid = firebase.auth.accounts.get(EMAIL).uid;
    assert.equal(session.user.id, uid);
    assert.equal(session.user.username, 'legacy_user', 'the username step is not shown again');
    assert.equal(session.user.name, 'Legacy Student');
    assert.equal(session.user.studentId, '20249999');
    assert.equal(session.user.profile.links.codeforcesHandle, 'legacy_cf');
    assert.equal(session.user.profile.codeforces.solvedCount, 7);
    assert.equal(firebase.auth.uid, uid);

    // Local state: the old id is gone from every place it was used.
    const state = storedState();
    assert.ok(!JSON.stringify(state).includes(oldId), 'no reference to the old id is left anywhere in local state');
    const record = state.users.find(u => u.email === EMAIL);
    assert.equal(record.id, uid);
    assert.equal(record._id, uid);
    assert.equal(record.passwordHash, undefined);
    assert.equal(record.pendingRemote, undefined, 'everything owed to Firestore was sent');
    assert.equal(state.users.filter(u => u.email === EMAIL).length, 1);
    const byId = (name, id) => state[name].find(row => row.id === id);
    assert.equal(byId('registrations', `${openEvent.id}_${uid}`).user, uid);
    assert.equal(byId('registrations', `${attendedEvent.id}_${uid}`).pointsAwarded, 25);
    assert.ok(byId('registrations', `${attendedEvent.id}_${uid}`).checkedInAt);
    assert.equal(byId('roadmapEnrollments', `${cycleId}_${uid}`).student, uid);
    assert.equal(byId('roadmapProgress', `${roadmapId}_${uid}`).solvedProblems.length, 1);
    assert.equal(byId('roadmapAttendance', `${sessionId}_${uid}`).student, uid);
    assert.equal(byId('notifications', 'ntf_1').user, uid);
    assert.equal(state.sessionsByToken[seeded.student.token], undefined);
    assert.deepEqual(Object.values(state.sessionsByToken).filter(id => id === uid).length, 1);

    // What the student sees is unchanged.
    const { dashboard } = await get('/dashboard', session.token);
    assert.equal(dashboard.stats.registeredEvents, 2);
    assert.equal(dashboard.stats.trainingCycles, 1);
    assert.equal(dashboard.stats.eventsAttended, 2);
    assert.equal(dashboard.stats.points, 140);
    assert.equal((await get('/events/my', session.token)).events.length, 2);
    assert.equal((await get('/notifications', session.token)).notifications.length, 1);
    assert.equal((await get(`/roadmaps/${ROADMAP_SLUG}/progress`, session.token)).solvedProblems.length, 1);
    assert.equal((await get(`/roadmaps/${ROADMAP_SLUG}/cycles/${cycleId}`, session.token)).enrolled, true);

    // Firestore: record, locks and rows are there under the uid, nothing under the old id.
    const { remote } = firebase;
    assert.equal(remote.get('users', uid).username, 'legacy_user');
    assert.equal(remote.get('users', uid).profile.codeforces.solvedCount, 7);
    assert.equal(remote.get('users', uid).email, undefined);
    assert.equal(remote.get('users', uid).passwordHash, undefined);
    assert.equal(remote.get('usernames', 'legacy_user').uid, uid);
    assert.equal(remote.get('codeforcesHandles', 'legacy_cf').uid, uid);
    assert.equal(remote.get('studentIds', '20249999').uid, uid);
    assert.deepEqual(remote.get('userSecrets', uid), { email: EMAIL, studentId: '20249999' });
    assert.equal(remote.get('registrations', `${openEvent.id}_${uid}`).user, uid);
    assert.equal(remote.get('roadmapEnrollments', `${cycleId}_${uid}`).student, uid);
    assert.equal(remote.get('roadmapProgress', `${roadmapId}_${uid}`).student, uid);
    assert.equal(remote.get('roadmapAttendance', `${sessionId}_${uid}`).student, uid);
    // The rules take a new registration only before check-in, so this one stays on the device.
    assert.equal(remote.get('registrations', `${attendedEvent.id}_${uid}`), null);
    for (const name of ['users', 'userSecrets', 'usernames', 'registrations', 'roadmapEnrollments', 'roadmapProgress', 'roadmapAttendance']) {
      assert.ok(remote.ids(name).every(id => !id.includes(oldId)), `${name} has nothing under the old id`);
    }

    // Other members now see this student.
    freshBrowser(firebase);
    const { leaderboard } = await get('/events/leaderboard');
    assert.deepEqual(leaderboard.map(row => [row.name, row.points]), [['Legacy Student', 140]]);
  });

  await t.test('a second login changes nothing: one Firebase account, one record, the same rows', async () => {
    await seedLocalOnlyBrowser();
    const firebase = createFakeFirebase();
    reloadPage(firebase);
    const first = await login(EMAIL, PASSWORD);
    const stateAfterFirst = storedState();
    const remoteWrites = firebase.remote.log.writes.length;

    await post('/auth/logout', first.token);
    reloadPage(firebase);
    const second = await login(EMAIL, PASSWORD);
    assert.equal(second.user.id, first.user.id);
    assert.deepEqual(firebase.auth.calls.filter(call => call.startsWith('register:')), [`register:${EMAIL}`]);
    const state = storedState();
    assert.equal(state.users.filter(u => u.email === EMAIL).length, 1);
    for (const name of ['registrations', 'roadmapEnrollments', 'roadmapProgress', 'roadmapAttendance', 'notifications']) {
      assert.deepEqual(state[name], stateAfterFirst[name], `${name} unchanged`);
    }
    assert.equal(firebase.remote.log.writes.length, remoteWrites, 'nothing was written to Firestore again');
    assert.deepEqual(second.user, first.user);
  });

  await t.test('a local-only admin is moved too: createdBy follows the account', async () => {
    const seeded = await seedLocalOnlyBrowser();
    const firebase = createFakeFirebase();
    reloadPage(firebase);
    const admin = await login('admin@icpcpua.com', 'adminpass123');
    const adminUid = firebase.auth.accounts.get('admin@icpcpua.com').uid;
    assert.equal(admin.user.id, adminUid);
    assert.equal(admin.user.role, 'admin');
    const state = storedState();
    assert.ok(!JSON.stringify(state).includes(seeded.admin.user.id));
    assert.equal(state.events.find(event => event.id === seeded.openEvent.id).createdBy, adminUid);
    assert.equal((await get('/admin/events', admin.token)).events.some(event => event.id === seeded.openEvent.id), true);
  });

  await t.test('interrupted after the Firebase account was created, before anything reached Firestore', async () => {
    const seeded = await seedLocalOnlyBrowser();
    const firebase = createFakeFirebase();
    reloadPage(firebase);
    firebase.remote.writesFail = true;

    const session = await login(EMAIL, PASSWORD);
    const uid = firebase.auth.accounts.get(EMAIL).uid;
    assert.equal(session.user.id, uid, 'the student is in, on the moved account');
    assert.equal(firebase.remote.get('users', uid), null);
    let record = storedState().users.find(u => u.email === EMAIL);
    assert.equal(record.pendingRemote.account, true);
    // Four rows wait for Firestore; the checked-in registration is not sent (see above).
    assert.equal(record.pendingRemote.records.length, 4);
    assert.ok(!JSON.stringify(storedState()).includes(seeded.oldId));

    // Next page load with the connection back: the rest is sent, nothing is asked of the student.
    firebase.remote.writesFail = false;
    reloadPage(firebase);
    const me = await get('/auth/me', session.token);
    assert.equal(me.user.id, uid);
    assert.equal(firebase.remote.get('users', uid).username, 'legacy_user');
    assert.equal(firebase.remote.get('usernames', 'legacy_user').uid, uid);
    assert.equal(firebase.remote.get('codeforcesHandles', 'legacy_cf').uid, uid);
    assert.equal(firebase.remote.get('studentIds', '20249999').uid, uid);
    assert.equal(firebase.remote.get('registrations', `${seeded.openEvent.id}_${uid}`).user, uid);
    assert.equal(firebase.remote.get('roadmapProgress', `${seeded.roadmapId}_${uid}`).student, uid);
    record = storedState().users.find(u => u.email === EMAIL);
    assert.equal(record.pendingRemote, undefined);

    // A further load sends nothing more (the student ID lock is write-once and is not written twice).
    const writes = firebase.remote.log.writes.length;
    const deniedWrites = firebase.remote.log.deniedWrites.length;
    reloadPage(firebase);
    await get('/auth/me', session.token);
    assert.equal(firebase.remote.log.writes.length, writes);
    assert.equal(firebase.remote.log.deniedWrites.length, deniedWrites);
  });

  await t.test('interrupted between creating the Firebase account and moving the local data', async () => {
    const seeded = await seedLocalOnlyBrowser();
    const firebase = createFakeFirebase();
    // The earlier attempt got as far as creating the Firebase Auth account, nothing else.
    const created = await firebase.auth.register(EMAIL, PASSWORD);
    firebase.auth.dropSession();
    firebase.auth.calls.length = 0;
    reloadPage(firebase);

    const session = await login(EMAIL, PASSWORD);
    assert.equal(session.user.id, created.uid);
    assert.equal(session.user.username, 'legacy_user', 'the local account was moved, not replaced by a blank one');
    assert.deepEqual(firebase.auth.calls, [`signIn:${EMAIL}`]);
    assert.ok(!JSON.stringify(storedState()).includes(seeded.oldId));
    assert.equal(firebase.remote.get('users', created.uid).username, 'legacy_user');
    assert.equal(storedState().users.filter(u => u.email === EMAIL).length, 1);
  });

  await t.test('Firestore cannot say whether a shared record exists: nothing is moved, the next login does it', async () => {
    const seeded = await seedLocalOnlyBrowser();
    const firebase = createFakeFirebase();
    reloadPage(firebase);
    firebase.remote.offline = true;

    const session = await login(EMAIL, PASSWORD);
    assert.equal(session.user.id, seeded.oldId, 'still the local account, usable on this device');
    assert.ok(storedState().users.find(u => u.id === seeded.oldId).passwordHash);
    assert.deepEqual(firebase.remote.log.writes, []);
    assert.equal((await get('/auth/me', session.token)).user.id, seeded.oldId);
    // Not silent: the student is told the score is on this device only.
    const cf = await post('/auth/codeforces/sync', session.token, { force: true });
    assert.equal(cf.shared.ok, false);
    assert.match(cf.shared.message, /Saved on this device only/);
    assert.match(cf.shared.message, /Sign out and sign in again/);

    firebase.remote.offline = false;
    await post('/auth/logout', session.token);
    reloadPage(firebase);
    const moved = await login(EMAIL, PASSWORD);
    const uid = firebase.auth.accounts.get(EMAIL).uid;
    assert.equal(moved.user.id, uid);
    assert.ok(!JSON.stringify(storedState()).includes(seeded.oldId));
    assert.equal(firebase.remote.get('users', uid).username, 'legacy_user');
  });

  await t.test('sign-in service unreachable or email sign-in not switched on: the local account keeps working', async t2 => {
    const start = Date.parse('2026-11-18T08:00:00.000Z');
    t2.mock.timers.enable({ apis: ['Date'], now: start });
    const seeded = await seedLocalOnlyBrowser();
    const firebase = createFakeFirebase();
    reloadPage(firebase);

    for (const outage of ['auth/network-request-failed', 'auth/operation-not-allowed']) {
      firebase.auth.outage = outage;
      const session = await login(EMAIL, PASSWORD);
      assert.equal(session.user.id, seeded.oldId, outage);
      assert.equal((await get('/dashboard', session.token)).dashboard.stats.registeredEvents, 2);
    }
    // A wrong password is still refused while the service is down.
    await assert.rejects(() => login(EMAIL, 'not-the-password'), status(503));
    assert.equal(firebase.auth.accounts.has(EMAIL), false);

    // The local session lasts a day, then the student signs in again and the move is retried.
    const session = await login(EMAIL, PASSWORD);
    reloadPage(firebase);
    assert.equal((await get('/auth/me', session.token)).user.id, seeded.oldId);
    t2.mock.timers.setTime(start + 25 * 3600 * 1000);
    reloadPage(firebase);
    await assert.rejects(() => get('/auth/me', session.token), status(401));

    firebase.auth.outage = null;
    const moved = await login(EMAIL, PASSWORD);
    assert.equal(moved.user.id, firebase.auth.accounts.get(EMAIL).uid);
    assert.ok(!JSON.stringify(storedState()).includes(seeded.oldId));
  });

  await t.test('a clash with another member: the username step is shown again, the handle is dropped, the rest is shared', async () => {
    await seedLocalOnlyBrowser();
    const firebase = createFakeFirebase();
    // Since this account was created, another member took the same username and handle.
    firebase.remote.seed('users', 'uid_other', { ...sharedRecord('Other Member', 'legacy_cf', 30), username: 'legacy_user' });
    firebase.remote.seed('usernames', 'legacy_user', { uid: 'uid_other' });
    firebase.remote.seed('codeforcesHandles', 'legacy_cf', { uid: 'uid_other', handle: 'legacy_cf' });
    reloadPage(firebase);

    const session = await login(EMAIL, PASSWORD);
    const uid = firebase.auth.accounts.get(EMAIL).uid;
    assert.equal(session.user.username, null, 'AuthPage sends an account without a username to the username step');
    assert.equal(session.user.profile.links.codeforcesHandle, '');
    assert.equal(session.user.profile.codeforces, null);
    assert.equal(session.user.name, 'Legacy Student');
    assert.equal(firebase.remote.get('usernames', 'legacy_user').uid, 'uid_other', 'the other member keeps the username');
    assert.equal(firebase.remote.get('codeforcesHandles', 'legacy_cf').uid, 'uid_other');
    assert.equal(firebase.remote.get('users', 'uid_other').profile.codeforces.solvedCount, 30);
    assert.equal(firebase.remote.get('users', uid).name, 'Legacy Student');
    assert.equal(firebase.remote.get('users', uid).username, null);
    const chosen = await put('/auth/username', session.token, { username: 'legacy_user_2' });
    assert.equal(chosen.user.username, 'legacy_user_2');
    assert.equal(firebase.remote.get('usernames', 'legacy_user_2').uid, uid);
  });

  await t.test('the seeded demo account stays local and is never given a Firebase account', async () => {
    const firebase = createFakeFirebase();
    freshBrowser(firebase);
    // Only the hash of the demo password is in the seed, so a known one is set here.
    const state = storedState();
    const demo = state.users.find(u => u.id === 'usr_demo_student');
    demo.passwordHash = createHash('sha256').update(PASSWORD).digest('hex');
    storage.set(STORE_KEY, JSON.stringify(state));
    reloadPage(firebase);

    const session = await login(demo.email, PASSWORD);
    assert.equal(session.user.id, 'usr_demo_student');
    assert.equal(firebase.auth.accounts.has(demo.email), false);
    reloadPage(firebase);
    assert.equal((await get('/auth/me', session.token)).user.id, 'usr_demo_student');
  });
});

test('the email already has a Firebase Auth account', async t => {
  // A local-only account with one registration and its own handle.
  async function seedLocalOnlyStudent() {
    freshBrowser();
    cfAccount('local_cf', 3);
    const student = await createLocalOnlyAccount();
    await post('/auth/codeforces-verification/generate', student.token, { handle: 'local_cf' });
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
    await post(`/events/${event.id}/registrations`, student.token);
    return { student, oldId: student.user.id, event };
  }

  await t.test('Google account, no shared record yet: password login is refused plainly, Google sign-in moves the local account', async () => {
    const seeded = await seedLocalOnlyStudent();
    const firebase = createFakeFirebase();
    const google = firebase.auth.signInWithProvider(EMAIL);
    firebase.auth.dropSession();
    reloadPage(firebase);

    await assert.rejects(
      () => login(EMAIL, PASSWORD),
      error => error.status === 409 && /signs in with Google, GitHub or a different password/.test(error.message),
    );
    // Nothing was touched: the local account is exactly as it was.
    const untouched = storedState().users.find(u => u.id === seeded.oldId);
    assert.ok(untouched.passwordHash);
    assert.equal(storedState().registrations[0].user, seeded.oldId);
    assert.deepEqual(firebase.remote.log.writes, []);

    firebase.auth.signInWithProvider(EMAIL);
    const session = await post('/auth/oauth', null, { uid: google.uid, email: EMAIL, name: 'Legacy Student', provider: 'google' });
    assert.equal(session.user.id, google.uid);
    assert.equal(session.user.username, 'legacy_user');
    assert.equal(session.user.profile.links.codeforcesHandle, 'local_cf');
    assert.ok(!JSON.stringify(storedState()).includes(seeded.oldId));
    assert.equal(storedState().users.find(u => u.id === google.uid).passwordHash, undefined);
    assert.equal(firebase.remote.get('users', google.uid).username, 'legacy_user');
    assert.equal(firebase.remote.get('registrations', `${seeded.event.id}_${google.uid}`).user, google.uid);
  });

  await t.test('Google account with a shared record: the shared record wins, local rows are added, the local profile is not merged', async () => {
    const seeded = await seedLocalOnlyStudent();
    const firebase = createFakeFirebase();
    const google = firebase.auth.signInWithProvider(EMAIL);
    firebase.remote.seed('users', google.uid, sharedRecord('Shared Student', 'shared_cf', 55));
    firebase.remote.seed('codeforcesHandles', 'shared_cf', { uid: google.uid, handle: 'shared_cf' });
    const sharedBefore = structuredClone(firebase.remote.get('users', google.uid));
    firebase.auth.dropSession();
    reloadPage(firebase);

    await assert.rejects(() => login(EMAIL, PASSWORD), status(409));

    firebase.auth.signInWithProvider(EMAIL);
    const session = await post('/auth/oauth', null, { uid: google.uid, email: EMAIL, name: 'Shared Student', provider: 'google' });
    assert.equal(session.user.id, google.uid);
    assert.equal(session.user.name, 'Shared Student');
    assert.equal(session.user.username, 'shared_student');
    assert.equal(session.user.profile.links.codeforcesHandle, 'shared_cf');
    assert.equal(session.user.profile.codeforces.solvedCount, 55);
    assert.deepEqual(firebase.remote.get('users', google.uid), sharedBefore, 'the shared record was not overwritten');
    assert.equal(firebase.remote.get('codeforcesHandles', 'local_cf'), null);
    assert.equal(firebase.remote.get('usernames', 'legacy_user'), null);

    const state = storedState();
    assert.ok(!JSON.stringify(state).includes(seeded.oldId), 'the local-only record is gone');
    assert.equal(state.users.filter(u => u.email === EMAIL).length, 1);
    assert.equal(state.registrations.find(row => row.id === `${seeded.event.id}_${google.uid}`).user, google.uid);
    assert.equal(firebase.remote.get('registrations', `${seeded.event.id}_${google.uid}`).user, google.uid);
    assert.equal((await get('/events/my', session.token)).events.length, 1);
  });

  await t.test('registered on another device with the same password: the shared record wins, local rows are added', async () => {
    const seeded = await seedLocalOnlyStudent();
    const firebase = createFakeFirebase();
    const other = await firebase.auth.register(EMAIL, PASSWORD);
    firebase.remote.seed('users', other.uid, sharedRecord('Shared Student', 'shared_cf', 55));
    const sharedBefore = structuredClone(firebase.remote.get('users', other.uid));
    firebase.auth.dropSession();
    reloadPage(firebase);

    const session = await login(EMAIL, PASSWORD);
    assert.equal(session.user.id, other.uid);
    assert.equal(session.user.username, 'shared_student');
    assert.equal(session.user.profile.codeforces.solvedCount, 55);
    assert.deepEqual(firebase.remote.get('users', other.uid), sharedBefore);
    assert.ok(!JSON.stringify(storedState()).includes(seeded.oldId));
    assert.equal(firebase.remote.get('registrations', `${seeded.event.id}_${other.uid}`).user, other.uid);
  });

  await t.test('registered on another device with a different password: accounts are not merged', async () => {
    const seeded = await seedLocalOnlyStudent();
    const firebase = createFakeFirebase();
    const other = await firebase.auth.register(EMAIL, 'another-password');
    firebase.remote.seed('users', other.uid, sharedRecord('Shared Student', 'shared_cf', 55));
    const sharedBefore = structuredClone(firebase.remote.get('users', other.uid));
    firebase.auth.dropSession();
    reloadPage(firebase);

    // The local password proves the local account only: Firebase Auth does not accept it.
    await assert.rejects(() => login(EMAIL, PASSWORD), status(409));
    assert.equal(firebase.auth.uid, null);

    // The Firebase password proves the Firebase account only: the local rows are left alone.
    const session = await login(EMAIL, 'another-password');
    assert.equal(session.user.id, other.uid);
    assert.equal(session.user.username, 'shared_student');
    assert.deepEqual(firebase.remote.get('users', other.uid), sharedBefore);
    const state = storedState();
    const localOnly = state.users.find(u => u.id === seeded.oldId);
    assert.ok(localOnly.passwordHash, 'the local-only account is still on this device, untouched');
    assert.equal(localOnly.username, 'legacy_user');
    assert.equal(state.registrations.find(row => row.event === seeded.event.id).user, seeded.oldId);
    assert.equal(firebase.remote.get('registrations', `${seeded.event.id}_${other.uid}`), null);
    assert.equal((await get('/events/my', session.token)).events.length, 0);
  });
});

test('password change, sign-out and reload', async t => {
  await t.test('password change goes to Firebase Auth and needs the current password', async () => {
    const firebase = createFakeFirebase();
    freshBrowser(firebase);
    const session = await post('/auth/register', null, registerBody());

    await assert.rejects(
      () => put('/auth/password', session.token, { currentPassword: 'not-the-password', newPassword: 'new-password-1' }),
      error => error.status === 401 && error.message === 'Your current password is incorrect.',
    );
    await assert.rejects(() => put('/auth/password', session.token, { currentPassword: PASSWORD, newPassword: 'short' }), status(400));
    await assert.rejects(() => put('/auth/password', session.token, { currentPassword: PASSWORD, newPassword: PASSWORD }), status(400));
    assert.equal(firebase.auth.accounts.get(EMAIL).password, PASSWORD);

    const changed = await put('/auth/password', session.token, { currentPassword: PASSWORD, newPassword: 'new-password-1' });
    assert.deepEqual(changed, { message: 'Password updated.' });
    assert.equal(firebase.auth.accounts.get(EMAIL).password, 'new-password-1');
    assert.equal(storedState().users.find(u => u.email === EMAIL).passwordHash, undefined);

    await post('/auth/logout', session.token);
    await assert.rejects(() => login(EMAIL, PASSWORD), status(401));
    assert.equal((await login(EMAIL, 'new-password-1')).user.id, session.user.id);
  });

  await t.test('after a moved account changes its password the old one opens nothing, here or on another device', async () => {
    freshBrowser();
    await createLocalOnlyAccount();
    const firebase = createFakeFirebase();
    reloadPage(firebase);
    const session = await login(EMAIL, PASSWORD);
    await put('/auth/password', session.token, { currentPassword: PASSWORD, newPassword: 'new-password-1' });
    assert.equal(storedState().users.find(u => u.email === EMAIL).passwordHash, undefined);

    await post('/auth/logout', session.token);
    reloadPage(firebase);
    await assert.rejects(() => login(EMAIL, PASSWORD), error => error.status === 401 && error.message === 'Email or password is incorrect.');
    // Even with the sign-in service down there is no local hash to fall back to.
    firebase.auth.outage = 'auth/network-request-failed';
    await assert.rejects(() => login(EMAIL, PASSWORD), status(503));
    await assert.rejects(() => login(EMAIL, 'new-password-1'), status(503));
    firebase.auth.outage = null;
    assert.equal((await login(EMAIL, 'new-password-1')).user.id, session.user.id);
  });

  await t.test('a Google or GitHub account has no password to change', async () => {
    const firebase = createFakeFirebase();
    freshBrowser(firebase);
    const google = firebase.auth.signInWithProvider('google@student.test');
    const session = await post('/auth/oauth', null, { uid: google.uid, email: 'google@student.test', name: 'Google Student', provider: 'google' });
    await assert.rejects(
      () => put('/auth/password', session.token, { currentPassword: 'anything', newPassword: 'new-password-1' }),
      error => error.status === 400 && error.message === 'This account signs in with Google, so it has no password to change here.',
    );
    assert.equal(storedState().users.find(u => u.id === google.uid).passwordHash, undefined);
    assert.equal(firebase.auth.calls.includes('changePassword'), false);
  });

  await t.test('a password set on a Google account before the switch is no longer a way in, and says so', async () => {
    // Before the switch the settings page stored a local password on any account.
    freshBrowser();
    const before = await post('/auth/oauth', null, { uid: 'fbuid_google', email: 'google@student.test', name: 'Google Student', provider: 'google' });
    await put('/auth/password', before.token, { currentPassword: 'anything', newPassword: 'local-password-1' });
    assert.equal((await login('google@student.test', 'local-password-1')).user.id, 'fbuid_google', 'worked while Firebase was not in use');

    const firebase = createFakeFirebase();
    reloadPage(firebase);
    await assert.rejects(
      () => login('google@student.test', 'local-password-1'),
      error => error.status === 401 && error.message === 'This account signs in with Google. Use Continue with Google instead.',
    );
    await assert.rejects(() => login('google@student.test', 'some-other-guess'), error => error.message === 'Email or password is incorrect.');
    assert.equal(firebase.auth.accounts.size, 0, 'no Firebase Auth account was created for it');
  });

  await t.test('sign-out ends the adapter session and the Firebase Auth session', async () => {
    const firebase = createFakeFirebase();
    freshBrowser(firebase);
    const session = await post('/auth/register', null, registerBody());
    assert.ok(firebase.auth.uid);
    assert.deepEqual(await post('/auth/logout', session.token), { signedOut: true });
    assert.equal(firebase.auth.uid, null);
    assert.equal(storedState().sessionsByToken[session.token], undefined);
    await assert.rejects(() => get('/auth/me', session.token), status(401));
    // Signing out twice, or with no session at all, is not an error.
    assert.deepEqual(await post('/auth/logout', session.token), { signedOut: true });
    assert.deepEqual(await post('/auth/logout', null), { signedOut: true });
  });

  await t.test('reload with the Firebase user still signed in: the session carries on', async () => {
    const firebase = createFakeFirebase();
    freshBrowser(firebase);
    cfAccount('reload_cf', 2);
    const session = await post('/auth/register', null, registerBody());
    reloadPage(firebase);
    assert.equal((await get('/auth/me', session.token)).user.id, session.user.id);
    const saved = await post('/auth/codeforces-verification/generate', session.token, { handle: 'reload_cf' });
    assert.equal(saved.shared.ok, true);
  });

  await t.test('reload without a Firebase user: the session is ended instead of writes failing quietly', async () => {
    const firebase = createFakeFirebase();
    freshBrowser(firebase);
    cfAccount('reload_cf', 2);
    const session = await post('/auth/register', null, registerBody());
    firebase.auth.dropSession();
    reloadPage(firebase);

    await assert.rejects(
      () => get('/auth/me', session.token),
      error => error.status === 401 && error.message === 'Your session has expired. Please sign in again.',
    );
    await assert.rejects(() => post('/auth/codeforces-verification/generate', session.token, { handle: 'reload_cf' }), status(401));
    await assert.rejects(() => put('/auth/profile', session.token, { bio: 'x' }), status(401));
    assert.equal(storedState().sessionsByToken[session.token], undefined);
    assert.equal(firebase.remote.get('users', session.user.id).profile.links.codeforcesHandle, '', 'nothing was written');
    // Pages that need no account still load with the stale token in the browser.
    assert.ok((await get('/events/leaderboard', session.token)).leaderboard);

    const again = await login(EMAIL, PASSWORD);
    assert.equal(again.user.id, session.user.id);
    assert.equal((await post('/auth/codeforces-verification/generate', again.token, { handle: 'reload_cf' })).shared.ok, true);
  });

  await t.test('a different Firebase user in this browser also ends the session; an unreadable auth state does not', async () => {
    const firebase = createFakeFirebase();
    freshBrowser(firebase);
    const session = await post('/auth/register', null, registerBody());

    firebase.auth.stateUnknown = true;
    reloadPage(firebase);
    assert.equal((await get('/auth/me', session.token)).user.id, session.user.id);
    firebase.auth.stateUnknown = false;

    firebase.auth.signInWithProvider('someone-else@student.test');
    reloadPage(firebase);
    await assert.rejects(() => get('/auth/me', session.token), status(401));
  });

  await t.test('Firebase not in use: accounts stay local, with a hash, exactly as before', async () => {
    const firebase = createFakeFirebase();
    freshBrowser();
    const session = await post('/auth/register', null, registerBody());
    assert.match(session.user.id, /^usr_/);
    assert.ok(storedState().users.find(u => u.email === EMAIL).passwordHash);
    await assert.rejects(() => login(EMAIL, 'not-the-password'), error => error.status === 401 && error.message === 'Email or password is incorrect.');
    assert.equal((await login(EMAIL, PASSWORD)).user.id, session.user.id);

    await assert.rejects(() => put('/auth/password', session.token, { currentPassword: 'not-the-password', newPassword: 'new-password-1' }), status(401));
    await put('/auth/password', session.token, { currentPassword: PASSWORD, newPassword: 'new-password-1' });
    await assert.rejects(() => login(EMAIL, PASSWORD), status(401));
    assert.equal((await login(EMAIL, 'new-password-1')).user.id, session.user.id);

    reloadPage(null);
    assert.equal((await get('/auth/me', session.token)).user.id, session.user.id);
    assert.deepEqual(await post('/auth/logout', session.token), { signedOut: true });
    await assert.rejects(() => get('/auth/me', session.token), status(401));
    assert.deepEqual(firebase.auth.calls, []);
  });
});
