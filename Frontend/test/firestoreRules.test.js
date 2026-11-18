import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rulesPath = path.resolve(import.meta.dirname, '../../firestore.rules');

test('Firestore Security Rules Structural & Security Invariants Verification', async t => {
  const rules = fs.readFileSync(rulesPath, 'utf8');

  await t.test('1. Enforces rules_version = 2 and cloud.firestore service block', () => {
    assert.match(rules, /rules_version\s*=\s*'2';/);
    assert.match(rules, /service\s+cloud\.firestore\s*\{/);
  });

  await t.test('2. Protects user role and points from client-side privilege escalation', () => {
    assert.match(rules, /request\.resource\.data\.role\s*==\s*'user'/);
    assert.match(rules, /request\.resource\.data\.attendancePoints\s*==\s*0/);
    assert.match(rules, /request\.resource\.data\.role\s*==\s*resource\.data\.role/);
  });

  await t.test('3. Enforces uniqueness lock collections for usernames and studentIds', () => {
    assert.match(rules, /match\s+\/usernames\/\{username\}/);
    assert.match(rules, /match\s+\/studentIds\/\{studentId\}/);
    assert.match(rules, /allow\s+create:\s+if\s+isSignedIn\(\)/);
  });

  await t.test('4. Protects userSecrets and enforces default-deny on unmatched paths', () => {
    assert.match(rules, /match\s+\/userSecrets\/\{uid\}/);
    assert.match(rules, /function\s+isAdmin\(\)/);
    assert.match(rules, /match\s+\/\{document=\*\*\}\s*\{\s*allow\s+read,\s*write:\s*if\s*false;/);
  });

  await t.test('5. Bounds the client-reported Codeforces solved count and locks handles per account', () => {
    assert.match(rules, /function\s+codeforcesStatsValid\(data\)/);
    assert.match(rules, /stats\.get\('solvedCount',\s*0\)\s+is\s+int/);
    assert.match(rules, /stats\.get\('solvedCount',\s*0\)\s*>=\s*0/);
    assert.match(rules, /stats\.get\('solvedCount',\s*0\)\s*<=\s*50000/);
    assert.match(rules, /match\s+\/codeforcesHandles\/\{handle\}/);
    assert.match(rules, /getAfter\(\/databases\/\$\(database\)\/documents\/codeforcesHandles\/\$\(handle\.lower\(\)\)\)\.data\.uid\s*==\s*uid/);
    // Both the create and the update rule for users/{uid} apply the two checks.
    assert.equal(rules.match(/&&\s*codeforcesStatsValid\(request\.resource\.data\)/g)?.length, 2);
    assert.equal(rules.match(/&&\s*codeforcesHandleClaimed\(uid,\s*request\.resource\.data,/g)?.length, 2);
  });

  await t.test('6. The stored-count bound matches the client constant', async () => {
    const { MAX_CODEFORCES_SOLVED_COUNT } = await import('../src/shared/utils/codeforcesScore.js');
    assert.ok(rules.includes(`<= ${MAX_CODEFORCES_SOLVED_COUNT}`));
  });

  await t.test('7. The owner email grants admin only when the sign-in provider verified it', () => {
    // Email-and-password sign-up accepts any email unverified, so the email alone must not be enough.
    assert.match(
      rules,
      /request\.auth\.token\.email\s*==\s*'enjoyplayax@gmail\.com'\s*&&\s*request\.auth\.token\.email_verified\s*==\s*true/,
    );
    assert.equal(rules.match(/request\.auth\.token\.email\s*==/g)?.length, 1, 'no other rule trusts the email claim');
  });
});
