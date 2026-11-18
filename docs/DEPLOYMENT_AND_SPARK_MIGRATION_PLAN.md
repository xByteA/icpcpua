# Comprehensive Plan: ICPC-PUA Firebase Spark Migration, Vercel Hosting & End-to-End Verification

> **Target Codebase:** `xByteA/ICPC-PUA` (`icpc-pua-upstream/`)
> **Backend Target:** Firebase Project `icpc-pua` (**Strict Spark $0 Free Tier** — Firebase Auth + Cloud Firestore + Security Rules, zero backend server, zero credit card)
> **Frontend Hosting Target:** Vercel Production (`https://icpcpua.vercel.app`) with rollback mirror (`https://icpcpua-legacy.vercel.app`) + Firebase Hosting mirror (`https://icpc-pua.web.app`)

---

## 1. Locked Architectural Decisions (`/grill-me` Alignment Matrix)

| # | Decision Area | Locked Choice | Architectural Consequence |
| :--- | :--- | :--- | :--- |
| **D1** | **Backend Compute & Database** | **100% Serverless Firebase Spark Migration** (`icpc-pua`) | Eliminates Express server, MongoDB Atlas runtime dependency, and `JWT_SECRET` exposure. Rewrites only `Frontend/src/shared/services/api.js` as a client-side Firestore + Firebase Auth adapter so all 77 frontend call sites and 13 UI feature modules remain untouched. |
| **D2** | **Legacy Atlas Data (`pua-icpc-community`)** | **Fresh Start + Read-Only Curriculum Seed** | No user PII or bcrypt password hashes migrated. One-time read-only export pulls `roadmaps`, `roadmapNodes`, `roadmapCycles`, `roadmapSessions`, and published `events` from `cluster0.iq3gjej.mongodb.net` into a static seed fixture (`Frontend/src/shared/data/seedFixture.json`) and seeds Firestore. |
| **D3** | **Codeforces Handle Verification** | **Self-Reported Handle (`unverified`)** | Drops server-side token-in-first-name polling against `codeforces.com/api/user.info`. Students enter their handle directly in Profile/Settings; stored as `unverified` with direct link to `https://codeforces.com/profile/<handle>`. |
| **D4** | **Authentication Providers** | **Google OAuth + GitHub OAuth (Firebase Auth v1)** | Unlimited and $0 on Firebase Spark. After first OAuth sign-in, users without a `username` or `studentId` complete the existing onboarding screen (`^[a-z0-9_]{3,20}$` username + `^\d{4,20}$` student ID). |
| **D5** | **Domain & Cutover Strategy** | **Replace Next.js on `icpcpua.vercel.app` after verification** | Current Next.js app moves to `icpcpua-legacy.vercel.app` as an instant rollback target. New Vite SPA deploys to a Vercel preview URL first, passes all automated + `/browser` gates, and then claims `icpcpua.vercel.app`. |
| **D6** | **Source Control & CI/CD** | **Fork `xByteA/ICPC-PUA` -> Auto-Deploy from `main`** | Working clone lives at `d:\Work\Instructing\prblmslving\icpc-pua-upstream`. GitHub Actions runs tests and builds on every push. |
| **D7** | **Verification Bar** | **3 Automated Gates + Mandatory Manual `/browser` Walkthrough** | (1) Firestore Rules unit tests, (2) 31-route Adapter contract tests, (3) Production Vite build & Playwright/Browser walkthrough of every student and admin flow. |

---

## 2. Environment Variables (`Frontend/.env` & Vercel Project Settings)

```dotenv
VITE_DATA_BACKEND=firebase
VITE_FIREBASE_API_KEY=AIzaSyDI9zgWc5_f_9z2-aRixG4MCr9gxBBY8BA
VITE_FIREBASE_AUTH_DOMAIN=icpc-pua.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=icpc-pua
VITE_FIREBASE_STORAGE_BUCKET=icpc-pua.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=610084876739
VITE_FIREBASE_APP_ID=1:610084876739:web:b2020d1317a7fcb2858d76
VITE_FIREBASE_MEASUREMENT_ID=G-VP3J196SB4
VITE_GOOGLE_CLIENT_ID=173832367605-5uq9g0igndfll5t4386d8njjqbvuphga.apps.googleusercontent.com
VITE_ACPC_TARGET_DATE=2027-08-01T00:00:00+03:00
VITE_ADMIN_EMAILS=enjoyplayax@gmail.com
```

`VITE_FIRESTORE_ENABLED=true` (not set by default) turns on sharing through Firestore. Without it every
browser keeps its own data and the leaderboard shows only accounts created in that browser. Deploy
`firestore.rules` before setting it.

### Email-and-password accounts (Firebase Authentication)

With `VITE_FIRESTORE_ENABLED=true`, email-and-password sign-up and login go through Firebase Authentication,
the same as Google and GitHub. The account id is the Firebase uid, the member's record is shared through
Firestore, and the password is held by Firebase only (no hash is kept in the browser). With the flag off,
email-and-password accounts stay in the browser they were created in, as before.

**Before turning the flag on (or before deploying this change if the flag is already on):**

1. Firebase console → Authentication → Sign-in method → enable **Email/Password**. Leave "Email link
   (passwordless sign-in)" off. Until this is done, sign-up with email shows "Email sign-in is not available
   right now", and existing email accounts keep working in their own browser only.
2. Firebase console → Authentication → Settings → User account linking: keep **Link accounts that use the
   same email** (the default). The app relies on one account per email.
3. Sign in to the live site once with Google as `enjoyplayax@gmail.com`, so that email is already taken in
   Firebase Authentication and nobody can sign up with it using a password.
4. Deploy the rules: `npx firebase-tools deploy --only firestore:rules`. `isAdmin()` now needs the owner email
   to be verified by the sign-in provider (Google does this). Any other admin (an email in `VITE_ADMIN_EMAILS`,
   or an admin who signs in with GitHub or with a password) needs an `admins/{uid}` document to be an admin
   in Firestore; without it they see the admin pages but their changes stay in their own browser.

**What existing members see:** an email-and-password member who was signed in is asked to log in once more.
Logging in with the same email and password creates their Firebase account and moves everything they had in
that browser (profile, username, student ID, Codeforces handle, registrations, training enrolments, progress,
attendance) onto it. Nothing else is asked of them.

**Rules the move follows:**

- The email is not registered in Firebase yet: the account in the browser is moved as it is.
- The email is already registered (the member used Google or GitHub with it, or signed up on another device):
  the record already shared through Firestore is kept and is never overwritten from the browser. The
  member's registrations, enrolments, progress and attendance from the browser are added to it when they
  proved both accounts are theirs: the same password opens both, or they sign in with Google/GitHub using
  that email. If the passwords differ, the two accounts are left separate and the browser's data stays in
  that browser.
- Password login is refused with "This email already has an account that signs in with Google, GitHub or a
  different password" when the browser's password does not open the Firebase account.
- The demo account (`demo@pua.edu.eg`) is never moved.

**Do not turn `VITE_FIRESTORE_ENABLED` off again after members have moved.** A moved account has no password
hash in the browser, so with the flag off it could not log in with email and password (Google and GitHub
sign-in are not affected).

**Local testing without touching the real project:** set `VITE_FIREBASE_EMULATORS=true`,
`VITE_FIRESTORE_ENABLED=true` and `VITE_FIREBASE_PROJECT_ID=demo-icpc-pua` in `Frontend/.env.local`, then run
`npx firebase-tools emulators:start --only auth,firestore --project demo-icpc-pua` next to `npm run dev`.
`npm run test:emulators --prefix Frontend` runs the adapter end to end against the emulators (needs Java 21).

---

## 3. Architecture Reference

See [`docs/architecture/graphify-index.md`](./architecture/graphify-index.md) for all five Graphify architecture diagrams and the Gate Report.
