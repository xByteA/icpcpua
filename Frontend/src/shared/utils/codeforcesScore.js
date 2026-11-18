// Pure Codeforces counting and scoring rules. No network, no browser APIs:
// everything here is covered by test/codeforcesScore.test.js with fixture data.

// Scoring rule set by the club: 20 leaderboard points per solved Codeforces problem.
export const CODEFORCES_POINTS_PER_PROBLEM = 20;

// "For now" the leaderboard total is Codeforces points only. Attendance is still
// recorded and shown in the Events column; flip this to true to add attendance
// points back into the leaderboard total.
export const LEADERBOARD_INCLUDES_ATTENDANCE_POINTS = false;

// Upper bound for a stored solved count. firestore.rules enforces the same bound,
// so keep the two in step. It is a sanity limit, not proof the number is genuine.
export const MAX_CODEFORCES_SOLVED_COUNT = 50000;

// A stored count older than this is refreshed when the student opens the
// dashboard or the leaderboard.
export const CODEFORCES_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

const HANDLE_PATTERN = /^[A-Za-z0-9._-]{3,24}$/;

export function isValidCodeforcesHandle(handle) {
  return typeof handle === 'string' && HANDLE_PATTERN.test(handle);
}

export function normalizeCodeforcesHandle(handle) {
  return String(handle || '').trim().toLowerCase();
}

// Identity of a problem inside one contest or problemset.
// Regular and gym problems carry a numeric contestId; archive problems
// (for example acmsguru) carry only problemsetName.
export function codeforcesProblemKey(problem) {
  if (!problem || typeof problem !== 'object') return '';
  const index = String(problem.index ?? '').trim();
  if (!index) return '';
  if (Number.isInteger(problem.contestId)) return `c:${problem.contestId}:${index}`;
  const problemset = String(problem.problemsetName ?? '').trim();
  return problemset ? `p:${problemset}:${index}` : '';
}

export function createSolvedAccumulator() {
  return new Map();
}

// Adds every accepted submission of one user.status page to the accumulator.
// Only verdict "OK" counts (PARTIAL, CHALLENGED, SKIPPED, TESTING do not).
export function addAcceptedSubmissions(accumulator, submissions) {
  if (!Array.isArray(submissions)) return accumulator;
  for (const submission of submissions) {
    if (!submission || submission.verdict !== 'OK') continue;
    const key = codeforcesProblemKey(submission.problem);
    if (!key || accumulator.has(key)) continue;
    accumulator.set(key, {
      contestId: Number.isInteger(submission.problem.contestId) ? submission.problem.contestId : null,
      name: typeof submission.problem.name === 'string' ? submission.problem.name : '',
    });
  }
  return accumulator;
}

// The "distinct problem" rule:
//   1. A problem is identified by (contestId, index), or (problemsetName, index)
//      when it has no contest. Any number of accepted submissions to it count once.
//   2. The same problem is often published twice in the parallel Div. 1 / Div. 2
//      editions of one round, under two contest ids. Two accepted problems with the
//      same name whose contest ids differ by exactly 1 are counted as one problem.
// Names alone are not used as identity: unrelated problems reuse names
// ("Card Game", "Shuffle", ...) and would be undercounted.
export function countDistinctSolved(accumulator) {
  const contestIdsByName = new Map();
  for (const { contestId, name } of accumulator.values()) {
    if (contestId === null || !name) continue;
    if (!contestIdsByName.has(name)) contestIdsByName.set(name, new Set());
    contestIdsByName.get(name).add(contestId);
  }
  let twins = 0;
  for (const ids of contestIdsByName.values()) {
    if (ids.size < 2) continue;
    const sorted = Array.from(ids).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] - sorted[i - 1] === 1) twins += 1;
    }
  }
  return Math.max(0, accumulator.size - twins);
}

export function countSolvedProblems(submissions) {
  return countDistinctSolved(addAcceptedSubmissions(createSolvedAccumulator(), submissions));
}

// Coerces anything (including a value another client wrote to Firestore) to a
// safe non-negative integer within the stored bound.
export function sanitizeSolvedCount(value) {
  const number = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.floor(number), MAX_CODEFORCES_SOLVED_COUNT);
}

export function codeforcesPoints(solvedCount) {
  return sanitizeSolvedCount(solvedCount) * CODEFORCES_POINTS_PER_PROBLEM;
}

export function leaderboardPoints({ solvedCount = 0, attendancePoints = 0 } = {}) {
  const attendance = LEADERBOARD_INCLUDES_ATTENDANCE_POINTS ? Math.max(0, Number(attendancePoints) || 0) : 0;
  return codeforcesPoints(solvedCount) + attendance;
}

// The solved count stored for a user only counts while it belongs to the handle
// the user has now. After a handle change the old count is worth nothing.
export function solvedCountForHandle(stats, handle) {
  const current = normalizeCodeforcesHandle(handle);
  if (!current || !stats || typeof stats !== 'object') return 0;
  if (normalizeCodeforcesHandle(stats.handle) !== current) return 0;
  return sanitizeSolvedCount(stats.solvedCount);
}

export function isCodeforcesSyncStale(syncedAt, now = Date.now(), maxAgeMs = CODEFORCES_REFRESH_INTERVAL_MS) {
  const syncedMs = typeof syncedAt === 'string' ? Date.parse(syncedAt) : Number.NaN;
  if (!Number.isFinite(syncedMs)) return true;
  return now - syncedMs >= maxAgeMs || syncedMs > now + 60 * 1000;
}
