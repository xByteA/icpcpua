// Browser client for the official Codeforces API (https://codeforces.com/apiHelp).
//
// Method used: user.status?handle=<handle>&from=<1-based index>&count=<n>
// It returns { status: "OK", result: Submission[] } newest first, or
// { status: "FAILED", comment } (HTTP 400 for an unknown handle). Responses carry
// "Access-Control-Allow-Origin: *", so the call works straight from the browser.
// Codeforces allows one API request per two seconds; requests are spaced here
// and a "Call limit exceeded" answer is retried once.
import {
  addAcceptedSubmissions,
  countDistinctSolved,
  createSolvedAccumulator,
  isValidCodeforcesHandle,
  normalizeCodeforcesHandle,
} from '../utils/codeforcesScore.js';

const API_BASE = 'https://codeforces.com/api';
export const CODEFORCES_PAGE_SIZE = 5000;
// 40 pages x 5000 = 200,000 submissions; beyond that the count is marked truncated.
export const CODEFORCES_MAX_PAGES = 40;
const MIN_REQUEST_SPACING_MS = 2100;
const REQUEST_TIMEOUT_MS = 25000;

export class CodeforcesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CodeforcesError';
    // 'not_found' | 'rate_limited' | 'unavailable' | 'invalid'
    this.code = code;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastRequestAt = 0;
let requestChain = Promise.resolve();

// Serialises every Codeforces request made from this tab and keeps them two seconds apart.
function scheduleRequest(task, sleep) {
  const run = requestChain.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  requestChain = run.catch(() => {});
  return run;
}

async function requestPage(handle, from, count, { fetchImpl, sleep, spacing }) {
  const url = `${API_BASE}/user.status?handle=${encodeURIComponent(handle)}&from=${from}&count=${count}`;
  const task = async () => {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    let response;
    try {
      response = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
    } catch {
      throw new CodeforcesError('unavailable', 'Codeforces could not be reached.');
    } finally {
      if (timer) clearTimeout(timer);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (payload && payload.status === 'OK' && Array.isArray(payload.result)) return payload.result;
    const comment = payload && typeof payload.comment === 'string' ? payload.comment : '';
    if (/not found/i.test(comment)) {
      throw new CodeforcesError('not_found', `Codeforces has no user with the handle "${handle}".`);
    }
    if (/limit exceeded/i.test(comment) || response.status === 429) {
      throw new CodeforcesError('rate_limited', 'Codeforces is rate limiting requests right now.');
    }
    if (response.status === 400 && comment) {
      throw new CodeforcesError('invalid', `Codeforces rejected the request: ${comment}`);
    }
    throw new CodeforcesError('unavailable', 'Codeforces is not responding properly right now.');
  };
  return spacing ? scheduleRequest(task, sleep) : task();
}

// Fetches every submission of the handle page by page and returns the number of
// distinct solved problems (see countDistinctSolved for the rule).
export async function fetchCodeforcesSolved(handle, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    pageSize = CODEFORCES_PAGE_SIZE,
    maxPages = CODEFORCES_MAX_PAGES,
    spacing = true,
  } = options;
  const requested = String(handle || '').trim();
  if (!isValidCodeforcesHandle(requested)) {
    throw new CodeforcesError('invalid', 'Enter a valid Codeforces handle (3–24 characters).');
  }
  if (typeof fetchImpl !== 'function') {
    throw new CodeforcesError('unavailable', 'Codeforces could not be reached.');
  }
  const accumulator = createSolvedAccumulator();
  let canonicalHandle = requested;
  let submissionsScanned = 0;
  let truncated = false;
  const context = { fetchImpl, sleep, spacing };

  for (let page = 0; ; page += 1) {
    if (page >= maxPages) {
      truncated = true;
      break;
    }
    const from = page * pageSize + 1;
    let submissions;
    try {
      submissions = await requestPage(requested, from, pageSize, context);
    } catch (error) {
      if (!(error instanceof CodeforcesError) || error.code !== 'rate_limited') throw error;
      await sleep(MIN_REQUEST_SPACING_MS + 400);
      submissions = await requestPage(requested, from, pageSize, context);
    }
    submissionsScanned += submissions.length;
    addAcceptedSubmissions(accumulator, submissions);
    if (page === 0) {
      // Codeforces matches handles case-insensitively; keep its own spelling.
      const member = submissions
        .flatMap((submission) => submission?.author?.members || [])
        .find((item) => normalizeCodeforcesHandle(item?.handle) === normalizeCodeforcesHandle(requested));
      if (member && isValidCodeforcesHandle(member.handle)) canonicalHandle = member.handle;
    }
    if (submissions.length < pageSize) break;
  }

  return {
    handle: canonicalHandle,
    solvedCount: countDistinctSolved(accumulator),
    submissionsScanned,
    truncated,
  };
}
