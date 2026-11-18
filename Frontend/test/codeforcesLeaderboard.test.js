import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleSparkRequest,
  resetSparkStoreForTests,
  setCodeforcesFetcherForTests,
  setSparkRemoteForTests,
} from '../src/shared/services/sparkAdapter.js';
import { CodeforcesError } from '../src/shared/services/codeforcesApi.js';

const storage = new Map();
globalThis.localStorage = {
  getItem: key => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, val) => storage.set(key, String(val)),
  removeItem: key => storage.delete(key),
  clear: () => storage.clear(),
};

// Fake Codeforces: handle -> solved count. `outage` makes every call fail.
const codeforces = { accounts: new Map(), outage: null, calls: [] };
function installCodeforces() {
  codeforces.accounts.clear();
  codeforces.outage = null;
  codeforces.calls = [];
  setCodeforcesFetcherForTests(async handle => {
    codeforces.calls.push(handle);
    if (codeforces.outage) throw new CodeforcesError(codeforces.outage, 'fixture outage');
    const account = codeforces.accounts.get(handle.toLowerCase());
    if (!account) throw new CodeforcesError('not_found', 'fixture: no such handle');
    return { handle: account.handle, solvedCount: account.solved, submissionsScanned: account.solved, truncated: false };
  });
}
const cfAccount = (handle, solved) => codeforces.accounts.set(handle.toLowerCase(), { handle, solved });

const post = (path, token, body = {}) => handleSparkRequest(path, { method: 'POST', token, body: JSON.stringify(body) });
const put = (path, token, body = {}) => handleSparkRequest(path, { method: 'PUT', token, body: JSON.stringify(body) });

let counter = 0;
async function registerStudent(name) {
  counter += 1;
  const { token, user } = await post('/auth/register', null, {
    name,
    email: `student${counter}@pua.edu.eg`,
    username: `student_${counter}`,
    password: 'password123',
  });
  return { token, user };
}
const saveHandle = (token, handle) => post('/auth/codeforces-verification/generate', token, { handle });
const leaderboard = async () => (await handleSparkRequest('/events/leaderboard')).leaderboard;

function freshStore() {
  setSparkRemoteForTests(null);
  resetSparkStoreForTests();
  installCodeforces();
}

test('Codeforces leaderboard through the adapter', async t => {
  t.after(() => {
    setCodeforcesFetcherForTests(null);
    setSparkRemoteForTests(null);
  });

  await t.test('membership: handle required, 0 points listed, admins and the demo account excluded', async () => {
    freshStore();
    cfAccount('zero_solver', 0);
    cfAccount('admin_handle', 500);
    const withHandle = await registerStudent('Has Handle');
    await registerStudent('No Handle');
    await saveHandle(withHandle.token, 'zero_solver');
    const admin = await post('/auth/oauth', null, { email: 'enjoyplayax@gmail.com', name: 'Admin', uid: 'admin_uid' });
    assert.equal(admin.user.role, 'admin');
    await saveHandle(admin.token, 'admin_handle');

    const rows = await leaderboard();
    assert.deepEqual(rows.map(row => row.name), ['Has Handle']);
    assert.equal(rows[0].points, 0);
    assert.equal(rows[0].problemsSolved, 0);
    assert.equal(rows[0].rank, 1);
    assert.equal(rows[0].codeforcesHandle, 'zero_solver');
  });

  await t.test('scoring and deterministic order: 20 per problem, ties share a rank and sort by name', async () => {
    freshStore();
    cfAccount('h_carol', 10);
    cfAccount('h_alice', 10);
    cfAccount('h_bob', 3);
    cfAccount('h_dave', 0);
    for (const [name, handle] of [['Carol', 'h_carol'], ['Dave', 'h_dave'], ['Bob', 'h_bob'], ['alice', 'h_alice']]) {
      const student = await registerStudent(name);
      await saveHandle(student.token, handle);
    }
    const first = await leaderboard();
    assert.deepEqual(
      first.map(row => [row.rank, row.name, row.problemsSolved, row.points]),
      [[1, 'alice', 10, 200], [1, 'Carol', 10, 200], [2, 'Bob', 3, 60], [3, 'Dave', 0, 0]],
    );
    assert.deepEqual(await leaderboard(), first);
  });

  await t.test('attendance points are recorded but not added to the leaderboard total', async () => {
    freshStore();
    cfAccount('h_attender', 2);
    const student = await registerStudent('Attender');
    await saveHandle(student.token, 'h_attender');
    const admin = await post('/auth/oauth', null, { email: 'enjoyplayax@gmail.com', name: 'Admin', uid: 'admin_uid' });
    const now = Date.now();
    const { event } = await post('/admin/events', admin.token, {
      title: 'Attendance Check',
      description: 'Fixture event for the attendance flag.',
      category: 'Contest',
      location: 'Lab 1',
      startsAt: new Date(now - 3600000).toISOString(),
      endsAt: new Date(now + 3600000).toISOString(),
      capacity: 50,
      attendancePoints: 25,
      status: 'published',
    });
    await post(`/events/${event.id}/registrations`, student.token);
    const qr = await post(`/admin/events/${event.id}/check-in-qr`, admin.token);
    const qrToken = new URL(qr.checkInUrl).searchParams.get('token');
    await post(`/events/${event.id}/check-in`, student.token, { token: qrToken });

    const [row] = await leaderboard();
    assert.equal(row.points, 40);
    assert.equal(row.eventsAttended, 1);
    assert.equal(row.attendancePoints, 25);

    const { standing } = await handleSparkRequest('/events/leaderboard/me', { token: student.token });
    assert.equal(standing.points, 40);
    assert.equal(standing.rank, 1);
    const { dashboard } = await handleSparkRequest('/dashboard', { token: student.token });
    assert.equal(dashboard.stats.points, 40);
    assert.equal(dashboard.stats.problemsSolved, 2);
    assert.equal(dashboard.stats.eventsAttended, 1);
    assert.equal(dashboard.stats.attendancePoints, 25);
    assert.equal(dashboard.codeforces.handle, 'h_attender');
  });

  await t.test('a member without a handle still gets their own standing with 0 points', async () => {
    freshStore();
    const student = await registerStudent('No Handle');
    const { standing } = await handleSparkRequest('/events/leaderboard/me', { token: student.token });
    assert.deepEqual(standing, { rank: null, points: 0, problemsSolved: 0, eventsAttended: 0, attendancePoints: 0 });
    const { dashboard } = await handleSparkRequest('/dashboard', { token: student.token });
    assert.equal(dashboard.stats.points, 0);
    assert.equal(dashboard.codeforces, null);
    assert.deepEqual(await leaderboard(), []);
  });

  await t.test('unknown handle is rejected on save and nothing is stored', async () => {
    freshStore();
    const student = await registerStudent('Typo');
    await assert.rejects(
      () => saveHandle(student.token, 'no_such_handle'),
      error => error.status === 404 && /no user with the handle/.test(error.message),
    );
    const { user } = await handleSparkRequest('/auth/me', { token: student.token });
    assert.equal(user.profile.links.codeforcesHandle, '');
    assert.equal(user.profile.codeforces, null);
    assert.deepEqual(await leaderboard(), []);
  });

  await t.test('handle already used by another member is rejected', async () => {
    freshStore();
    cfAccount('Shared_Handle', 5);
    const first = await registerStudent('First');
    const second = await registerStudent('Second');
    await saveHandle(first.token, 'shared_handle');
    await assert.rejects(() => saveHandle(second.token, 'SHARED_HANDLE'), error => error.status === 409);
    assert.deepEqual(codeforces.calls, ['shared_handle']);
  });

  await t.test('handle change: the old count does not linger', async () => {
    freshStore();
    cfAccount('Old_Handle', 300);
    cfAccount('new_handle', 4);
    const student = await registerStudent('Changer');
    const saved = await saveHandle(student.token, 'old_handle');
    assert.equal(saved.user.profile.links.codeforcesHandle, 'Old_Handle', 'keeps the spelling Codeforces uses');
    assert.equal((await leaderboard())[0].points, 6000);

    const changed = await saveHandle(student.token, 'new_handle');
    assert.equal(changed.codeforces.solvedCount, 4);
    assert.equal(changed.user.profile.codeforces.handle, 'new_handle');
    const [row] = await leaderboard();
    assert.equal(row.codeforcesHandle, 'new_handle');
    assert.equal(row.problemsSolved, 4);
    assert.equal(row.points, 80);

    // A handle swapped through the generic profile route (no Codeforces lookup)
    // scores 0 until it is synced: the previous handle's count is never reused.
    await put('/auth/profile', student.token, { links: { codeforcesHandle: 'Old_Handle' } });
    const [afterProfileEdit] = await leaderboard();
    assert.equal(afterProfileEdit.codeforcesHandle, 'Old_Handle');
    assert.equal(afterProfileEdit.problemsSolved, 0);
    assert.equal(afterProfileEdit.points, 0);
  });

  await t.test('Codeforces down while changing handle: change refused, old handle and count kept', async () => {
    freshStore();
    cfAccount('steady_one', 12);
    cfAccount('other_one', 99);
    const student = await registerStudent('Steady');
    await saveHandle(student.token, 'steady_one');
    codeforces.outage = 'unavailable';
    await assert.rejects(
      () => saveHandle(student.token, 'other_one'),
      error => error.status === 503 && /was not saved/.test(error.message),
    );
    const [row] = await leaderboard();
    assert.equal(row.codeforcesHandle, 'steady_one');
    assert.equal(row.points, 240);
  });

  await t.test('refresh: fresh counts are not refetched, stale ones are, failures keep the last count', async t2 => {
    freshStore();
    const start = Date.parse('2026-11-18T08:00:00.000Z');
    t2.mock.timers.enable({ apis: ['Date'], now: start });
    cfAccount('grinder', 10);
    const student = await registerStudent('Grinder');
    await saveHandle(student.token, 'grinder');
    assert.equal(codeforces.calls.length, 1);

    // Opening the dashboard or leaderboard soon after: nothing to do.
    let res = await post('/auth/codeforces/sync', student.token);
    assert.equal(res.sync.attempted, false);
    assert.equal(res.changed, false);
    assert.equal(codeforces.calls.length, 1);

    // Stale (older than the refresh interval): refetched automatically.
    cfAccount('grinder', 14);
    t2.mock.timers.setTime(start + 7 * 3600 * 1000);
    res = await post('/auth/codeforces/sync', student.token);
    assert.equal(res.sync.attempted, true);
    assert.equal(res.sync.ok, true);
    assert.equal(res.changed, true);
    assert.equal(res.codeforces.solvedCount, 14);
    assert.equal(res.codeforces.points, 280);
    assert.equal(res.codeforces.syncedAt, new Date(start + 7 * 3600 * 1000).toISOString());

    // Manual refresh while Codeforces is rate limiting: last count kept, said plainly.
    codeforces.outage = 'rate_limited';
    t2.mock.timers.setTime(start + 8 * 3600 * 1000);
    res = await post('/auth/codeforces/sync', student.token, { force: true });
    assert.equal(res.sync.attempted, true);
    assert.equal(res.sync.ok, false);
    assert.equal(res.sync.reason, 'rate_limited');
    assert.match(res.sync.message, /last synced count \(14\)/);
    assert.equal(res.codeforces.solvedCount, 14);
    assert.equal(res.codeforces.syncedAt, new Date(start + 7 * 3600 * 1000).toISOString());
    assert.equal((await leaderboard())[0].points, 280);

    // Stale auto-refresh during an outage: one attempt, then it backs off.
    t2.mock.timers.setTime(start + 20 * 3600 * 1000);
    codeforces.outage = 'unavailable';
    const callsBefore = codeforces.calls.length;
    res = await post('/auth/codeforces/sync', student.token);
    assert.equal(res.sync.ok, false);
    res = await post('/auth/codeforces/sync', student.token);
    assert.equal(res.sync.attempted, false);
    assert.equal(res.sync.ok, false);
    assert.equal(codeforces.calls.length, callsBefore + 1);
    assert.equal(res.codeforces.solvedCount, 14);

    // Codeforces back: manual refresh works again.
    codeforces.outage = null;
    cfAccount('grinder', 15);
    res = await post('/auth/codeforces/sync', student.token, { force: true });
    assert.equal(res.sync.ok, true);
    assert.equal(res.codeforces.solvedCount, 15);
  });

  await t.test('privacy opt-out hides a member from the leaderboard', async () => {
    freshStore();
    cfAccount('private_one', 9);
    const student = await registerStudent('Private');
    await saveHandle(student.token, 'private_one');
    assert.equal((await leaderboard()).length, 1);
    await put('/auth/privacy', student.token, { leaderboardVisible: false });
    assert.deepEqual(await leaderboard(), []);
  });

  await t.test('without Firestore the result says the score is on this device only', async () => {
    freshStore();
    cfAccount('local_only', 1);
    const student = await registerStudent('Local');
    const saved = await saveHandle(student.token, 'local_only');
    assert.equal(saved.shared.ok, false);
    assert.equal(saved.shared.reason, 'disabled');
    assert.match(saved.shared.message, /this device only/);
  });
});

// ---------------------------------------------------------------------------
// Firestore sharing, against a fake remote that applies the same read/write
// conditions as firestore.rules for the paths used here.
// ---------------------------------------------------------------------------
function denied() {
  return Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
}

function createFakeRemote({ uid = null, admin = false } = {}) {
  const collections = new Map();
  const col = name => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  const log = { lists: [], writes: [], deniedWrites: [], removes: [] };
  const statusReadable = { roadmaps: ['published', 'completed'], roadmapCycles: ['published', 'completed'], events: ['published'] };
  const remote = {
    uid,
    admin,
    log,
    seed(name, id, data) {
      col(name).set(id, structuredClone(data));
    },
    get(name, id) {
      return col(name).get(id) || null;
    },
    async currentUid() {
      return remote.uid;
    },
    async list(name, filter) {
      log.lists.push(filter ? `${name}:${filter.field}=${filter.value}` : name);
      if (statusReadable[name] && !remote.admin) {
        // Rules are not filters: only a query constrained to a readable status is allowed.
        if (!filter || filter.field !== 'status' || !statusReadable[name].includes(filter.value)) throw denied();
      }
      if (name === 'roadmapSessions' && !remote.uid) throw denied();
      if (!['roadmaps', 'roadmapCycles', 'events', 'roadmapNodes', 'users', 'registrations', 'roadmapSessions'].includes(name)) throw denied();
      return [...col(name)]
        .filter(([, data]) => !filter || data[filter.field] === filter.value)
        .map(([docId, data]) => ({ docId, data: structuredClone(data) }));
    },
    async read(name, id) {
      if (name !== 'codeforcesHandles') throw denied();
      return structuredClone(col(name).get(id) || null);
    },
    async write(name, id, data) {
      const existing = col(name).get(id);
      let allowed = remote.admin;
      if (name === 'users') {
        const handle = String(data.profile?.links?.codeforcesHandle || '').toLowerCase();
        const previous = String(existing?.profile?.links?.codeforcesHandle || '').toLowerCase();
        const reserved = !handle || handle === previous || col('codeforcesHandles').get(handle)?.uid === remote.uid;
        allowed = allowed || (remote.uid === id && reserved);
      } else if (name === 'codeforcesHandles') {
        allowed = Boolean(remote.uid) && data.uid === remote.uid && (!existing || existing.uid === remote.uid);
      } else if (name === 'userSecrets') {
        allowed = allowed || remote.uid === id;
      } else if (name === 'usernames') {
        allowed = Boolean(remote.uid) && data.uid === remote.uid && (!existing || existing.uid === remote.uid);
      }
      if (!allowed) {
        log.deniedWrites.push(`${name}/${id}`);
        throw denied();
      }
      log.writes.push(`${name}/${id}`);
      col(name).set(id, { ...(existing || {}), ...structuredClone(data) });
    },
    async remove(name, id) {
      log.removes.push(`${name}/${id}`);
      col(name).delete(id);
    },
  };
  return remote;
}

const remoteStudent = (name, handle, solvedCount, extra = {}) => ({
  name,
  username: name.toLowerCase(),
  role: 'user',
  profile: {
    links: { codeforcesHandle: handle },
    codeforces: { handle, solvedCount, syncedAt: '2026-11-18T07:00:00.000Z', truncated: false },
  },
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-18T07:00:00.000Z',
  ...extra,
});

function freshStoreWithRemote(remote) {
  resetSparkStoreForTests();
  installCodeforces();
  setSparkRemoteForTests(remote);
}

test('Sharing through Firestore (fake remote enforcing the rules)', async t => {
  t.after(() => {
    setCodeforcesFetcherForTests(null);
    setSparkRemoteForTests(null);
  });

  await t.test('a signed-out visitor hydrates with rule-compliant queries and sees other members', async () => {
    const remote = createFakeRemote();
    remote.seed('users', 'uid_remote_a', remoteStudent('Amina', 'amina_cf', 30));
    remote.seed('users', 'uid_remote_b', remoteStudent('Basel', 'basel_cf', 45));
    remote.seed('events', 'ev_pub', { title: 'Remote Published', description: 'x', category: 'Contest', status: 'published', startsAt: '2027-01-01T10:00:00.000Z', endsAt: '2027-01-01T12:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z' });
    remote.seed('events', 'ev_draft', { title: 'Remote Draft', description: 'x', category: 'Contest', status: 'draft', startsAt: '2027-01-01T10:00:00.000Z', endsAt: '2027-01-01T12:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z' });
    freshStoreWithRemote(remote);

    const rows = await leaderboard();
    assert.deepEqual(rows.map(row => [row.rank, row.name, row.points]), [[1, 'Basel', 900], [2, 'Amina', 600]]);

    // Never lists a status-gated collection unfiltered, never lists what a visitor cannot read.
    assert.ok(!remote.log.lists.includes('roadmaps'));
    assert.ok(!remote.log.lists.includes('roadmapCycles'));
    assert.ok(!remote.log.lists.includes('events'));
    assert.ok(!remote.log.lists.includes('roadmapSessions'));
    assert.ok(remote.log.lists.includes('events:status=published'));
    assert.ok(remote.log.lists.includes('roadmaps:status=completed'));

    const { events } = await handleSparkRequest('/events?sort=latest');
    const titles = events.map(event => event.title);
    assert.ok(titles.includes('Remote Published'));
    assert.ok(!titles.includes('Remote Draft'));
  });

  await t.test('one rejected read does not stop the other collections or later writes', async () => {
    const remote = createFakeRemote({ uid: 'uid_google' });
    remote.seed('users', 'uid_remote_a', remoteStudent('Amina', 'amina_cf', 30));
    const originalList = remote.list;
    remote.list = async (name, filter) => {
      if (name === 'registrations' || name === 'roadmaps') throw denied();
      return originalList(name, filter);
    };
    freshStoreWithRemote(remote);
    cfAccount('google_cf', 5);

    assert.equal((await leaderboard()).length, 1, 'users still hydrated although other reads were rejected');
    const session = await post('/auth/oauth', null, { email: 'google@student.test', name: 'Google Student', uid: 'uid_google', provider: 'google' });
    const saved = await saveHandle(session.token, 'google_cf');
    assert.equal(saved.shared.ok, true);
    assert.equal(remote.get('users', 'uid_google').profile.codeforces.solvedCount, 5);
  });

  await t.test('Google/GitHub member: record and handle reservation are written and shared', async () => {
    const remote = createFakeRemote({ uid: 'uid_google' });
    freshStoreWithRemote(remote);
    cfAccount('Google_CF', 8);
    cfAccount('second_cf', 2);
    const session = await post('/auth/oauth', null, { email: 'google@student.test', name: 'Google Student', uid: 'uid_google', provider: 'google' });
    const saved = await saveHandle(session.token, 'google_cf');
    assert.deepEqual(saved.shared, { ok: true, reason: null, message: '' });
    assert.equal(remote.get('codeforcesHandles', 'google_cf').uid, 'uid_google');
    const doc = remote.get('users', 'uid_google');
    assert.equal(doc.profile.links.codeforcesHandle, 'Google_CF');
    assert.deepEqual(Object.keys(doc.profile.codeforces).sort(), ['handle', 'solvedCount', 'syncedAt', 'truncated']);
    assert.equal(doc.profile.codeforces.solvedCount, 8);
    assert.equal(doc.email, undefined, 'the public record never carries the email');
    assert.equal(doc.passwordHash, undefined);

    // Changing the handle releases the old reservation and replaces the count.
    await saveHandle(session.token, 'second_cf');
    assert.equal(remote.get('codeforcesHandles', 'google_cf'), null);
    assert.equal(remote.get('codeforcesHandles', 'second_cf').uid, 'uid_google');
    assert.equal(remote.get('users', 'uid_google').profile.codeforces.handle, 'second_cf');
    assert.equal(remote.get('users', 'uid_google').profile.codeforces.solvedCount, 2);
  });

  await t.test('no Firebase Auth user in this browser: saved locally, told plainly it is not shared, later writes still work', async () => {
    const remote = createFakeRemote({ uid: null });
    freshStoreWithRemote(remote);
    cfAccount('password_cf', 6);
    const student = await registerStudent('Password Student');
    const saved = await saveHandle(student.token, 'password_cf');
    assert.equal(saved.codeforces.solvedCount, 6);
    assert.equal(saved.shared.ok, false);
    assert.equal(saved.shared.reason, 'not-signed-in');
    assert.match(saved.shared.message, /Saved on this device only\. Your sign-in is no longer active in this browser/);
    assert.doesNotMatch(saved.shared.message, /Email-and-password/);
    assert.equal(remote.get('users', student.user.id), null);
    assert.equal((await leaderboard())[0].points, 120, 'still listed in this browser');

    // The same browser later signs in with Google: sharing works, nothing was latched off.
    remote.uid = 'uid_google';
    cfAccount('google_cf', 5);
    const session = await post('/auth/oauth', null, { email: 'google@student.test', name: 'Google Student', uid: 'uid_google', provider: 'google' });
    assert.equal((await saveHandle(session.token, 'google_cf')).shared.ok, true);
  });

  await t.test('a failed share is retried on the next sync and reported until it succeeds', async () => {
    const remote = createFakeRemote({ uid: 'uid_google' });
    freshStoreWithRemote(remote);
    cfAccount('google_cf', 5);
    const session = await post('/auth/oauth', null, { email: 'google@student.test', name: 'Google Student', uid: 'uid_google', provider: 'google' });
    const realWrite = remote.write;
    remote.write = async () => {
      throw denied();
    };
    const saved = await saveHandle(session.token, 'google_cf');
    assert.equal(saved.shared.ok, false);
    assert.equal(saved.shared.reason, 'permission-denied');
    assert.equal(saved.codeforces.solvedCount, 5, 'kept locally');
    const status = await handleSparkRequest('/auth/codeforces-verification', { token: session.token });
    assert.equal(status.shared.ok, false);

    remote.write = realWrite;
    const retry = await post('/auth/codeforces/sync', session.token);
    assert.equal(retry.sync.attempted, false, 'count is fresh, no Codeforces call needed');
    assert.equal(retry.shared.ok, true);
    assert.equal(remote.get('users', 'uid_google').profile.codeforces.solvedCount, 5);
  });

  await t.test('handle reserved by another member in Firestore is rejected across browsers', async () => {
    const remote = createFakeRemote({ uid: 'uid_google' });
    remote.seed('codeforcesHandles', 'taken_cf', { uid: 'uid_someone_else', handle: 'taken_cf' });
    freshStoreWithRemote(remote);
    cfAccount('taken_cf', 50);
    const session = await post('/auth/oauth', null, { email: 'google@student.test', name: 'Google Student', uid: 'uid_google', provider: 'google' });
    await assert.rejects(() => saveHandle(session.token, 'Taken_CF'), error => error.status === 409);
    assert.deepEqual(codeforces.calls, []);
    assert.equal(remote.get('users', 'uid_google').profile.links.codeforcesHandle, '');
  });

  await t.test('signing in on a second browser adopts the shared record instead of wiping it', async () => {
    const remote = createFakeRemote({ uid: 'uid_google' });
    remote.seed('users', 'uid_google', remoteStudent('Google Student', 'google_cf', 77));
    remote.seed('codeforcesHandles', 'google_cf', { uid: 'uid_google', handle: 'google_cf' });
    freshStoreWithRemote(remote);
    const session = await post('/auth/oauth', null, { email: 'google@student.test', name: 'Google Student', uid: 'uid_google', provider: 'google' });
    assert.equal(session.user.profile.links.codeforcesHandle, 'google_cf');
    assert.equal(session.user.profile.codeforces.solvedCount, 77);
    assert.equal(session.user.email, 'google@student.test');
    assert.equal(remote.get('users', 'uid_google').profile.codeforces.solvedCount, 77);
    const rows = await leaderboard();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].points, 1540);
  });

  await t.test('records read from Firestore are treated as untrusted', async () => {
    const remote = createFakeRemote();
    remote.seed('users', 'uid_negative', remoteStudent('Negative', 'neg_cf', -40));
    remote.seed('users', 'uid_text', remoteStudent('Texty', 'text_cf', '9999'));
    remote.seed('users', 'uid_huge', remoteStudent('Huge', 'huge_cf', 10 ** 12));
    remote.seed('users', 'uid_other_handle', remoteStudent('Mismatch', 'now_cf', 500, {
      profile: { links: { codeforcesHandle: 'now_cf' }, codeforces: { handle: 'before_cf', solvedCount: 500 } },
    }));
    // A document whose fields claim to be someone else is still filed under its own id.
    remote.seed('users', 'uid_impostor', { ...remoteStudent('Impostor', 'imp_cf', 1), id: 'uid_negative', _id: 'uid_negative', email: 'x@y.z', passwordHash: 'abc' });
    remote.seed('users', 'uid_noname', { profile: { links: { codeforcesHandle: 'anon_cf' } } });
    freshStoreWithRemote(remote);

    const rows = await leaderboard();
    const byId = new Map(rows.map(row => [row.userId, row]));
    assert.equal(byId.get('uid_negative').points, 0);
    assert.equal(byId.get('uid_negative').name, 'Negative');
    assert.equal(byId.get('uid_text').points, 0);
    assert.equal(byId.get('uid_huge').problemsSolved, 50000);
    assert.equal(byId.get('uid_other_handle').points, 0);
    assert.equal(byId.get('uid_impostor').points, 20);
    assert.equal(byId.get('uid_noname').name, 'ICPC Member');
    await assert.rejects(
      () => post('/auth/login', null, { email: 'x@y.z', password: 'whatever' }),
      error => error.status === 401,
    );
  });

  await t.test('an admin signed in to Firebase also hydrates drafts', async () => {
    const remote = createFakeRemote({ uid: 'admin_uid', admin: true });
    remote.seed('events', 'ev_draft', { title: 'Remote Draft', description: 'x', category: 'Contest', status: 'draft', startsAt: '2027-01-01T10:00:00.000Z', endsAt: '2027-01-01T12:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z' });
    freshStoreWithRemote(remote);
    const admin = await post('/auth/oauth', null, { email: 'enjoyplayax@gmail.com', name: 'Admin', uid: 'admin_uid' });
    const { events } = await handleSparkRequest('/admin/events', { token: admin.token });
    assert.ok(events.some(event => event.title === 'Remote Draft'));
    assert.ok(remote.log.lists.includes('roadmapSessions'));
  });
});
