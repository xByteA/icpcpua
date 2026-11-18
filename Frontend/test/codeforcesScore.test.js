import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CODEFORCES_POINTS_PER_PROBLEM,
  CODEFORCES_REFRESH_INTERVAL_MS,
  LEADERBOARD_INCLUDES_ATTENDANCE_POINTS,
  MAX_CODEFORCES_SOLVED_COUNT,
  codeforcesPoints,
  codeforcesProblemKey,
  countSolvedProblems,
  isCodeforcesSyncStale,
  isValidCodeforcesHandle,
  leaderboardPoints,
  sanitizeSolvedCount,
  solvedCountForHandle,
} from '../src/shared/utils/codeforcesScore.js';
import { CodeforcesError, fetchCodeforcesSolved } from '../src/shared/services/codeforcesApi.js';

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/codeforcesUserStatus.json'), 'utf8'),
);

const jsonResponse = (status, body) => ({ status, ok: status < 400, json: async () => body });
const noSleep = async () => {};

// A fake Codeforces: serves the fixture with the real from/count paging rules.
function fakeCodeforces(submissions, { failures = [] } = {}) {
  const calls = [];
  const queue = [...failures];
  const fetchImpl = async (url) => {
    const params = new URL(url).searchParams;
    calls.push({ handle: params.get('handle'), from: Number(params.get('from')), count: Number(params.get('count')) });
    if (queue.length) return queue.shift()();
    const from = Number(params.get('from'));
    const count = Number(params.get('count'));
    return jsonResponse(200, { status: 'OK', result: submissions.slice(from - 1, from - 1 + count) });
  };
  return { fetchImpl, calls };
}

test('Codeforces counting and scoring rules', async (t) => {
  await t.test('counts each accepted problem once and merges Div. 1 / Div. 2 twins', () => {
    assert.equal(countSolvedProblems(fixture.result), fixture.expectedSolvedCount);
    assert.equal(countSolvedProblems(fixture.result), 7);
  });

  await t.test('only verdict OK counts; missing or partial verdicts do not', () => {
    const only = (verdict) => [{ verdict, problem: { contestId: 1, index: 'A', name: 'X' } }];
    assert.equal(countSolvedProblems(only('OK')), 1);
    for (const verdict of ['PARTIAL', 'WRONG_ANSWER', 'CHALLENGED', 'SKIPPED', 'TESTING', undefined]) {
      assert.equal(countSolvedProblems(only(verdict)), 0, `verdict ${verdict}`);
    }
  });

  await t.test('same name in unrelated contests stays distinct; adjacent contest ids merge', () => {
    const ok = (contestId, index, name) => ({ verdict: 'OK', problem: { contestId, index, name } });
    assert.equal(countSolvedProblems([ok(1810, 'C', 'Card Game'), ok(2118, 'B', 'Card Game')]), 2);
    assert.equal(countSolvedProblems([ok(1900, 'C', 'Card Game'), ok(1901, 'A', 'Card Game')]), 1);
    assert.equal(countSolvedProblems([ok(1900, 'A', 'One'), ok(1901, 'A', 'Two')]), 2);
    assert.equal(countSolvedProblems([ok(1900, 'A', 'Same'), ok(1900, 'B', 'Same')]), 2);
  });

  await t.test('tolerates malformed input', () => {
    assert.equal(countSolvedProblems(null), 0);
    assert.equal(countSolvedProblems([null, {}, { verdict: 'OK' }, { verdict: 'OK', problem: { name: 'No index' } }]), 0);
    assert.equal(codeforcesProblemKey({ problemsetName: 'acmsguru', index: '100' }), 'p:acmsguru:100');
    assert.equal(codeforcesProblemKey({ contestId: 4, index: 'A' }), 'c:4:A');
  });

  await t.test('20 points per solved problem; attendance is not added for now', () => {
    assert.equal(CODEFORCES_POINTS_PER_PROBLEM, 20);
    assert.equal(LEADERBOARD_INCLUDES_ATTENDANCE_POINTS, false);
    assert.equal(codeforcesPoints(0), 0);
    assert.equal(codeforcesPoints(7), 140);
    assert.equal(leaderboardPoints({ solvedCount: 7, attendancePoints: 999 }), 140);
  });

  await t.test('stored counts are coerced to a bounded non-negative integer', () => {
    assert.equal(sanitizeSolvedCount(12.9), 12);
    assert.equal(sanitizeSolvedCount(-5), 0);
    assert.equal(sanitizeSolvedCount('40'), 0);
    assert.equal(sanitizeSolvedCount(Number.NaN), 0);
    assert.equal(sanitizeSolvedCount(Infinity), 0);
    assert.equal(sanitizeSolvedCount(10 ** 9), MAX_CODEFORCES_SOLVED_COUNT);
  });

  await t.test('a stored count only counts for the handle it was synced for', () => {
    const stats = { handle: 'Old_Handle', solvedCount: 300 };
    assert.equal(solvedCountForHandle(stats, 'old_handle'), 300);
    assert.equal(solvedCountForHandle(stats, 'new_handle'), 0);
    assert.equal(solvedCountForHandle(stats, ''), 0);
    assert.equal(solvedCountForHandle(null, 'old_handle'), 0);
  });

  await t.test('staleness and handle format', () => {
    const now = Date.parse('2026-11-18T12:00:00.000Z');
    assert.equal(isCodeforcesSyncStale('2026-11-18T11:00:00.000Z', now), false);
    assert.equal(isCodeforcesSyncStale(new Date(now - CODEFORCES_REFRESH_INTERVAL_MS).toISOString(), now), true);
    assert.equal(isCodeforcesSyncStale('', now), true);
    assert.equal(isCodeforcesSyncStale('2027-01-01T00:00:00.000Z', now), true);
    assert.equal(isValidCodeforcesHandle('tourist'), true);
    assert.equal(isValidCodeforcesHandle('a b'), false);
    assert.equal(isValidCodeforcesHandle('ab'), false);
  });
});

test('Codeforces API client (fixture responses, no network)', async (t) => {
  await t.test('single page: count, canonical handle spelling, request shape', async () => {
    const { fetchImpl, calls } = fakeCodeforces(fixture.result);
    const result = await fetchCodeforcesSolved('fixture_user', { fetchImpl, sleep: noSleep, spacing: false });
    assert.deepEqual(result, { handle: 'Fixture_User', solvedCount: 7, submissionsScanned: 14, truncated: false });
    assert.deepEqual(calls, [{ handle: 'fixture_user', from: 1, count: 5000 }]);
  });

  await t.test('large accounts are read page by page with a 1-based from', async () => {
    const { fetchImpl, calls } = fakeCodeforces(fixture.result);
    const result = await fetchCodeforcesSolved('Fixture_User', { fetchImpl, sleep: noSleep, spacing: false, pageSize: 4 });
    assert.equal(result.solvedCount, 7);
    assert.equal(result.submissionsScanned, 14);
    assert.deepEqual(calls.map((call) => call.from), [1, 5, 9, 13]);
  });

  await t.test('a full last page triggers one more (empty) request', async () => {
    const { fetchImpl, calls } = fakeCodeforces(fixture.result.slice(0, 8));
    const result = await fetchCodeforcesSolved('Fixture_User', { fetchImpl, sleep: noSleep, spacing: false, pageSize: 4 });
    assert.equal(result.submissionsScanned, 8);
    assert.deepEqual(calls.map((call) => call.from), [1, 5, 9]);
  });

  await t.test('stops at the page cap and says the count is truncated', async () => {
    const { fetchImpl } = fakeCodeforces(fixture.result);
    const result = await fetchCodeforcesSolved('Fixture_User', { fetchImpl, sleep: noSleep, spacing: false, pageSize: 4, maxPages: 2 });
    assert.equal(result.truncated, true);
    assert.equal(result.submissionsScanned, 8);
  });

  await t.test('account with no submissions counts 0', async () => {
    const { fetchImpl } = fakeCodeforces([]);
    const result = await fetchCodeforcesSolved('newcomer', { fetchImpl, sleep: noSleep, spacing: false });
    assert.deepEqual(result, { handle: 'newcomer', solvedCount: 0, submissionsScanned: 0, truncated: false });
  });

  await t.test('unknown handle (HTTP 400 FAILED) is reported as not_found', async () => {
    const { fetchImpl } = fakeCodeforces([], {
      failures: [() => jsonResponse(400, { status: 'FAILED', comment: 'handle: User with handle nobody_here not found' })],
    });
    await assert.rejects(
      () => fetchCodeforcesSolved('nobody_here', { fetchImpl, sleep: noSleep, spacing: false }),
      (error) => error instanceof CodeforcesError && error.code === 'not_found',
    );
  });

  await t.test('"Call limit exceeded" is retried once, then succeeds', async () => {
    const limited = () => jsonResponse(503, { status: 'FAILED', comment: 'Call limit exceeded' });
    const { fetchImpl, calls } = fakeCodeforces(fixture.result, { failures: [limited] });
    const result = await fetchCodeforcesSolved('Fixture_User', { fetchImpl, sleep: noSleep, spacing: false });
    assert.equal(result.solvedCount, 7);
    assert.equal(calls.length, 2);
  });

  await t.test('rate limited twice is reported as rate_limited', async () => {
    const limited = () => jsonResponse(503, { status: 'FAILED', comment: 'Call limit exceeded' });
    const { fetchImpl } = fakeCodeforces(fixture.result, { failures: [limited, limited] });
    await assert.rejects(
      () => fetchCodeforcesSolved('Fixture_User', { fetchImpl, sleep: noSleep, spacing: false }),
      (error) => error.code === 'rate_limited',
    );
  });

  await t.test('network failure and non-JSON error pages are reported as unavailable', async () => {
    const offline = fakeCodeforces([], { failures: [() => { throw new TypeError('Failed to fetch'); }] });
    await assert.rejects(
      () => fetchCodeforcesSolved('Fixture_User', { fetchImpl: offline.fetchImpl, sleep: noSleep, spacing: false }),
      (error) => error.code === 'unavailable',
    );
    const htmlPage = { status: 502, ok: false, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    const down = fakeCodeforces([], { failures: [() => htmlPage] });
    await assert.rejects(
      () => fetchCodeforcesSolved('Fixture_User', { fetchImpl: down.fetchImpl, sleep: noSleep, spacing: false }),
      (error) => error.code === 'unavailable',
    );
  });

  await t.test('a malformed handle never reaches the network', async () => {
    const { fetchImpl, calls } = fakeCodeforces([]);
    await assert.rejects(
      () => fetchCodeforcesSolved('not a handle', { fetchImpl, sleep: noSleep, spacing: false }),
      (error) => error.code === 'invalid',
    );
    assert.equal(calls.length, 0);
  });
});
