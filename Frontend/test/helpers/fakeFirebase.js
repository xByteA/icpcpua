// In-memory stand-ins for Firebase Auth and Firestore, shaped like the clients
// the adapter takes (createFirebaseAuthClient / createFirestoreRemote). The
// remote applies the same conditions as firestore.rules for the paths the
// account tests use, so a write the real rules would reject is rejected here.

export function installLocalStorage() {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, val) => storage.set(key, String(val)),
    removeItem: key => storage.delete(key),
    clear: () => storage.clear(),
  };
  return storage;
}

export function authError(code) {
  return Object.assign(new Error(`Firebase: Error (${code}).`), { code, name: 'FirebaseError' });
}

function denied() {
  return Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
}

function unavailable() {
  return Object.assign(new Error('The service is currently unavailable.'), { code: 'unavailable' });
}

// One fake Firebase project: `auth` and `remote` share the signed-in user, as
// the real Auth and Firestore clients of one app do.
export function createFakeFirebase() {
  const accounts = new Map(); // email -> { uid, email, password, providers, disabled }
  const collections = new Map();
  const col = name => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  let current = null;
  let uidCounter = 0;

  const snapshot = account => (account ? { uid: account.uid, email: account.email, providers: [...account.providers] } : null);

  const auth = {
    accounts,
    calls: [],
    // Set to an auth error code to make every call that needs the network fail with it.
    outage: null,
    // Set to true to make currentUser() fail (auth state could not be read).
    stateUnknown: false,
    async currentUser() {
      if (auth.stateUnknown) throw authError('auth/internal-error');
      return snapshot(current);
    },
    async register(email, password) {
      auth.calls.push(`register:${email}`);
      if (auth.outage) throw authError(auth.outage);
      if (accounts.has(email)) throw authError('auth/email-already-in-use');
      if (password.length < 6) throw authError('auth/weak-password');
      uidCounter += 1;
      const account = { uid: `fbuid${uidCounter}`, email, password, providers: ['password'], disabled: false };
      accounts.set(email, account);
      current = account;
      return snapshot(account);
    },
    async signIn(email, password) {
      auth.calls.push(`signIn:${email}`);
      if (auth.outage) throw authError(auth.outage);
      const account = accounts.get(email);
      // Email enumeration protection: one code for an unknown email and a wrong password.
      if (!account || account.password === null || account.password !== password) throw authError('auth/invalid-credential');
      if (account.disabled) throw authError('auth/user-disabled');
      current = account;
      return snapshot(account);
    },
    async changePassword(currentPassword, newPassword) {
      auth.calls.push('changePassword');
      if (auth.outage) throw authError(auth.outage);
      if (!current) throw authError('auth/null-user');
      if (current.password !== currentPassword) throw authError('auth/invalid-credential');
      if (newPassword.length < 6) throw authError('auth/weak-password');
      current.password = newPassword;
    },
    async signOut() {
      auth.calls.push('signOut');
      current = null;
    },
    // --- test controls -----------------------------------------------------
    // A Google/GitHub account, as signInWithPopup would leave it: signed in, no password.
    signInWithProvider(email, providerId = 'google.com') {
      let account = accounts.get(email);
      if (!account) {
        uidCounter += 1;
        account = { uid: `fbuid${uidCounter}`, email, password: null, providers: [providerId], disabled: false };
        accounts.set(email, account);
      }
      current = account;
      return snapshot(account);
    },
    // Site data cleared or session revoked: Firebase Auth has no user, the adapter was not told.
    dropSession() {
      current = null;
    },
    get uid() {
      return current?.uid || null;
    },
  };

  const log = { writes: [], deniedWrites: [], removes: [], lists: [] };
  const statusReadable = { roadmaps: ['published', 'completed'], roadmapCycles: ['published', 'completed'], events: ['published'] };
  const ownedRows = { roadmapEnrollments: 'cycle', roadmapAttendance: 'session', roadmapProgress: 'roadmap' };

  function writeAllowed(name, id, data, existing) {
    const uid = auth.uid;
    if (remote.admin) return true;
    if (!uid) return false;
    switch (name) {
      case 'users': {
        const handle = String(data.profile?.links?.codeforcesHandle || '').toLowerCase();
        const previous = String(existing?.profile?.links?.codeforcesHandle || '').toLowerCase();
        const handleClaimed = !handle || (existing && handle === previous) || col('codeforcesHandles').get(handle)?.uid === uid;
        const roleOk = existing ? data.role === undefined || data.role === existing.role : data.role === undefined || data.role === 'user';
        return uid === id && roleOk && handleClaimed;
      }
      case 'userSecrets':
        return uid === id;
      case 'usernames':
        return existing ? existing.uid === uid : data.uid === uid;
      case 'codeforcesHandles':
        return data.uid === uid && (!existing || existing.uid === uid) && /^[a-z0-9._-]{3,24}$/.test(id);
      case 'studentIds':
        // Write-once: only an admin may update an existing lock.
        return !existing && data.uid === uid && /^[0-9]{4,20}$/.test(id);
      case 'registrations':
        if (existing) return existing.user === uid && existing.checkedInAt == null && data.checkedInAt != null;
        return data.user === uid && id === `${data.event}_${uid}` && data.checkedInAt == null && data.pointsAwarded === 0;
      case 'roadmapEnrollments':
        return !existing && data.student === uid && id === `${data.cycle}_${uid}`;
      case 'roadmapAttendance':
        return !existing && data.student === uid && id === `${data.session}_${uid}` && data.pointsReversed === 0;
      case 'roadmapProgress':
        return data.student === uid && id === `${data.roadmap}_${uid}`;
      default:
        return false;
    }
  }

  function readAllowed(name, existing) {
    const uid = auth.uid;
    if (['users', 'usernames', 'codeforcesHandles', 'registrations'].includes(name)) return true;
    if (remote.admin) return true;
    if (name === 'studentIds') return Boolean(uid);
    if (ownedRows[name]) return Boolean(uid) && (!existing || existing.student === uid);
    return false;
  }

  const remote = {
    admin: false,
    log,
    // true: every Firestore call fails as unreachable.
    offline: false,
    // true: reads work, every write fails as unreachable (connection lost mid-way).
    writesFail: false,
    seed(name, id, data) {
      col(name).set(id, structuredClone(data));
    },
    get(name, id) {
      return col(name).get(id) || null;
    },
    ids(name) {
      return [...col(name).keys()];
    },
    async currentUid() {
      return auth.uid;
    },
    async list(name, filter) {
      log.lists.push(filter ? `${name}:${filter.field}=${filter.value}` : name);
      if (remote.offline) throw unavailable();
      if (statusReadable[name] && !remote.admin) {
        if (!filter || filter.field !== 'status' || !statusReadable[name].includes(filter.value)) throw denied();
      }
      if (name === 'roadmapSessions' && !auth.uid) throw denied();
      if (!['roadmaps', 'roadmapCycles', 'events', 'roadmapNodes', 'users', 'registrations', 'roadmapSessions'].includes(name)) throw denied();
      return [...col(name)]
        .filter(([, data]) => !filter || data[filter.field] === filter.value)
        .map(([docId, data]) => ({ docId, data: structuredClone(data) }));
    },
    async read(name, id) {
      if (remote.offline) throw unavailable();
      const existing = col(name).get(id) || null;
      const allowed = name === 'userSecrets' ? remote.admin || auth.uid === id : readAllowed(name, existing);
      if (!allowed) throw denied();
      return structuredClone(existing);
    },
    async write(name, id, data) {
      if (remote.offline || remote.writesFail) throw unavailable();
      const existing = col(name).get(id);
      if (!writeAllowed(name, id, data, existing)) {
        log.deniedWrites.push(`${name}/${id}`);
        throw denied();
      }
      log.writes.push(`${name}/${id}`);
      col(name).set(id, { ...(existing || {}), ...structuredClone(data) });
    },
    async remove(name, id) {
      if (remote.offline || remote.writesFail) throw unavailable();
      log.removes.push(`${name}/${id}`);
      col(name).delete(id);
    },
  };

  return { auth, remote };
}
