import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { handleSparkRequest, resetSparkStoreForTests } from '../src/shared/services/sparkAdapter.js';
import { ADMIN_EMAILS } from '../src/shared/services/firebase.js';
import { validateRoadmapForPublish } from '../src/features/roadmaps/utils/roadmapPublishValidation.js';

const storage = new Map();
globalThis.localStorage = {
  getItem: key => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, val) => storage.set(key, String(val)),
  removeItem: key => storage.delete(key),
  clear: () => storage.clear(),
};

// Every test starts from the seeded store with a fresh admin session.
async function startAdmin() {
  resetSparkStoreForTests();
  const { token, user } = await handleSparkRequest('/auth/oauth', {
    method: 'POST',
    body: JSON.stringify({
      uid: 'admin-uid-roadmap-publish',
      email: [...ADMIN_EMAILS][0],
      name: 'Publish Admin',
      provider: 'google',
    }),
  });
  assert.equal(user.role, 'admin');
  // The adapter hands back its live store objects; snapshot them so later writes cannot rewrite what a test captured.
  return async (path, method = 'GET', body) =>
    structuredClone(
      await handleSparkRequest(path, { method, token, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    );
}

async function createDraft(admin, overrides = {}) {
  const { roadmap } = await admin('/admin/roadmaps', 'POST', {
    title: 'Graphs Track',
    description: 'Breadth-first search, depth-first search and shortest paths.',
    coverImageUrl: '',
    difficulty: 'intermediate',
    estimatedDuration: '4 weeks',
    objectives: ['Traverse graphs confidently'],
    audience: 'Level 2 trainees',
    prerequisites: 'Level 1',
    status: 'draft',
    ...overrides,
  });
  return roadmap;
}

async function addNode(admin, roadmapId, overrides = {}) {
  const { node } = await admin(`/admin/roadmaps/${roadmapId}/nodes`, 'POST', {
    title: 'Topic',
    description: '',
    dependencies: [],
    position: 0,
    estimatedHours: null,
    resources: [],
    problems: [{ title: 'Warm-up', url: 'https://codeforces.com/problemset/problem/4/A', difficulty: 'easy' }],
    isRequired: true,
    ...overrides,
  });
  return node;
}

// What the admin page hands to the validator: the list row and the node list.
async function adminView(admin, roadmapId) {
  const { roadmaps } = await admin('/admin/roadmaps');
  const { nodes } = await admin(`/admin/roadmaps/${roadmapId}/nodes`);
  return { roadmap: roadmaps.find(item => item._id === roadmapId), nodes };
}

async function publicIds() {
  const { roadmaps } = await handleSparkRequest('/roadmaps');
  return roadmaps.map(item => item._id);
}

const cycleBody = (overrides = {}) => ({
  order: 1,
  title: 'Autumn cohort',
  description: 'Weekly sessions.',
  startDate: '2027-01-10',
  endDate: '2027-02-10',
  capacity: 30,
  status: 'draft',
  ...overrides,
});

test('A. a roadmap whose topics were created by the adapter can be validated and published', async () => {
  const admin = await startAdmin();
  const draft = await createDraft(admin);
  const basics = await addNode(admin, draft._id, { title: 'Graph basics', position: 0 });
  const bfs = await addNode(admin, draft._id, { title: 'BFS', position: 1, dependencies: [basics._id] });

  // The ids the adapter mints are not Mongo ObjectIds, which is what the old check demanded.
  for (const node of [basics, bfs]) assert.doesNotMatch(node._id, /^[a-f\d]{24}$/i);

  const { roadmap, nodes } = await adminView(admin, draft._id);
  assert.equal(nodes.length, 2);
  assert.doesNotThrow(() => validateRoadmapForPublish(roadmap, nodes));

  const published = await admin(`/admin/roadmaps/${draft._id}`, 'PUT', { status: 'published' });
  assert.equal(published.roadmap.status, 'published');
  assert.ok((await publicIds()).includes(draft._id), 'published roadmap must appear in the public catalog');
});

test('A. the validator still rejects missing and duplicate topic identifiers', () => {
  const roadmap = { title: 'T', description: 'D', difficulty: 'beginner', objectives: [] };
  const node = _id => ({ _id, title: 'Topic', description: '', dependencies: [], position: 0, resources: [], problems: [] });
  const identifierError = /missing or duplicated/;

  assert.throws(() => validateRoadmapForPublish(roadmap, [node('node_a'), node('node_a')]), identifierError);
  assert.throws(() => validateRoadmapForPublish(roadmap, [node('')]), identifierError);
  assert.throws(() => validateRoadmapForPublish(roadmap, [node(undefined)]), identifierError);
  assert.doesNotThrow(() => validateRoadmapForPublish(roadmap, [node('node_a'), node('6ae1370f4a1f1597c4ed1f4f')]));
});

test('B. deleting a prerequisite topic removes the link from the topics that depended on it', async () => {
  const admin = await startAdmin();
  const draft = await createDraft(admin);
  const basics = await addNode(admin, draft._id, { title: 'Graph basics', position: 0 });
  const bfs = await addNode(admin, draft._id, { title: 'BFS', position: 1, dependencies: [basics._id] });
  const unrelated = await addNode(admin, draft._id, { title: 'Bit tricks', position: 2 });
  const shortestPaths = await addNode(admin, draft._id, {
    title: 'Shortest paths',
    position: 3,
    dependencies: [basics._id, bfs._id],
  });

  await delay(5);
  assert.equal(await admin(`/admin/roadmaps/${draft._id}/nodes/${basics._id}`, 'DELETE'), null);

  const { roadmap, nodes } = await adminView(admin, draft._id);
  const byId = new Map(nodes.map(node => [node._id, node]));
  assert.deepEqual([...byId.keys()].sort(), [bfs._id, unrelated._id, shortestPaths._id].sort());
  assert.deepEqual(byId.get(bfs._id).dependencies, []);
  assert.deepEqual(byId.get(shortestPaths._id).dependencies, [bfs._id], 'other prerequisites must be kept');
  assert.notEqual(byId.get(bfs._id).updatedAt, bfs.updatedAt, 'a topic that lost a prerequisite is marked updated');
  assert.equal(byId.get(unrelated._id).updatedAt, unrelated.updatedAt, 'a topic without the link is left untouched');

  assert.doesNotThrow(() => validateRoadmapForPublish(roadmap, nodes));
  const published = await admin(`/admin/roadmaps/${draft._id}`, 'PUT', { status: 'published' });
  assert.equal(published.roadmap.status, 'published');
  assert.ok((await publicIds()).includes(draft._id));
});

test('B. deleting a topic does not touch topics of another roadmap', async () => {
  const admin = await startAdmin();
  const first = await createDraft(admin);
  const second = await createDraft(admin, { title: 'Other track' });
  const doomed = await addNode(admin, first._id, { title: 'Doomed' });
  const outsider = await addNode(admin, second._id, { title: 'Outsider' });

  await delay(5);
  await admin(`/admin/roadmaps/${first._id}/nodes/${doomed._id}`, 'DELETE');

  const { nodes } = await admin(`/admin/roadmaps/${second._id}/nodes`);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].updatedAt, outsider.updatedAt);
  assert.deepEqual((await admin(`/admin/roadmaps/${first._id}/nodes`)).nodes, []);
});

test('H. publishing a roadmap that fails validation is rejected with 400 and changes nothing', async () => {
  const admin = await startAdmin();
  const empty = await createDraft(admin);

  await assert.rejects(
    () => admin(`/admin/roadmaps/${empty._id}`, 'PUT', { status: 'published' }),
    error => error.status === 400 && error.message === 'Add at least one learning topic before publishing.',
  );
  await assert.rejects(
    () => admin(`/admin/roadmaps/${empty._id}`, 'PUT', { title: 'Renamed while publishing', status: 'published' }),
    error => error.status === 400,
  );

  const { roadmap } = await adminView(admin, empty._id);
  assert.equal(roadmap.status, 'draft');
  assert.equal(roadmap.title, 'Graphs Track', 'a rejected publish must not save the other fields either');
  assert.ok(!(await publicIds()).includes(empty._id));

  // A stored prerequisite that points at a topic which does not exist blocks publishing too.
  await addNode(admin, empty._id, { title: 'Dangling', dependencies: ['node_does_not_exist'] });
  await assert.rejects(
    () => admin(`/admin/roadmaps/${empty._id}`, 'PUT', { status: 'published' }),
    error => error.status === 400 && /missing or self-referencing prerequisites on "Dangling"/.test(error.message),
  );
});

test('H. publishedAt is set the first time a roadmap is published and kept afterwards', async () => {
  const admin = await startAdmin();
  const draft = await createDraft(admin);
  await addNode(admin, draft._id);
  assert.ok(!draft.publishedAt, 'a draft has no publish date');

  const saved = await admin(`/admin/roadmaps/${draft._id}`, 'PUT', { description: 'Edited while still a draft.' });
  assert.ok(!saved.roadmap.publishedAt, 'saving a draft does not set a publish date');

  const before = Date.now();
  const { roadmap: published } = await admin(`/admin/roadmaps/${draft._id}`, 'PUT', { status: 'published' });
  const publishedAt = Date.parse(published.publishedAt);
  assert.ok(publishedAt >= before && publishedAt <= Date.now(), `publishedAt should be the publish time, got ${published.publishedAt}`);

  await delay(5);
  const { roadmap: edited } = await admin(`/admin/roadmaps/${draft._id}`, 'PUT', { title: 'Graphs Track (revised)' });
  assert.equal(edited.title, 'Graphs Track (revised)');
  assert.equal(edited.status, 'published');
  assert.equal(edited.publishedAt, published.publishedAt);

  // A published roadmap cannot be edited into a state that would fail publishing.
  await assert.rejects(
    () => admin(`/admin/roadmaps/${draft._id}`, 'PUT', { title: '   ' }),
    error => error.status === 400 && error.message === 'Add a roadmap title and description before publishing.',
  );
  assert.equal((await adminView(admin, draft._id)).roadmap.title, 'Graphs Track (revised)');
});

test('H. identifiers and unknown keys in the update body are ignored', async () => {
  const admin = await startAdmin();
  const draft = await createDraft(admin);

  const { roadmap: updated } = await admin(`/admin/roadmaps/${draft._id}`, 'PUT', {
    _id: 'rm_hijacked',
    id: 'rm_hijacked',
    slug: 'hijacked-slug',
    createdBy: 'someone-else',
    createdAt: '2000-01-01T00:00:00.000Z',
    cycles: [{ _id: 'cyc_fake' }],
    notAField: true,
    title: 'Renamed',
    audience: 'Everyone',
  });

  assert.equal(updated._id, draft._id);
  assert.equal(updated.id, draft.id);
  assert.equal(updated.slug, draft.slug);
  assert.equal(updated.createdBy, draft.createdBy);
  assert.equal(updated.createdAt, draft.createdAt);
  assert.ok(!('notAField' in updated));
  assert.ok(!('cycles' in updated));
  assert.equal(updated.title, 'Renamed');
  assert.equal(updated.audience, 'Everyone');

  const { roadmaps } = await admin('/admin/roadmaps');
  assert.equal(roadmaps.filter(item => item._id === draft._id).length, 1);
  assert.ok(!roadmaps.some(item => item._id === 'rm_hijacked' || item.id === 'rm_hijacked'));
  assert.deepEqual(roadmaps.find(item => item._id === draft._id).cycles, []);
});

test('H. archiving and completing skip publish validation; the seeded roadmap stays editable', async () => {
  const admin = await startAdmin();

  // The archive dialog sends only { status: 'archived' }, for drafts as well as published roadmaps.
  const empty = await createDraft(admin);
  const archivedDraft = await admin(`/admin/roadmaps/${empty._id}`, 'PUT', { status: 'archived' });
  assert.equal(archivedDraft.roadmap.status, 'archived');

  const live = await createDraft(admin, { title: 'Live track' });
  await addNode(admin, live._id);
  await admin(`/admin/roadmaps/${live._id}`, 'PUT', { status: 'published' });
  const completed = await admin(`/admin/roadmaps/${live._id}`, 'PUT', { status: 'completed' });
  assert.equal(completed.roadmap.status, 'completed');
  assert.ok((await publicIds()).includes(live._id));
  const archived = await admin(`/admin/roadmaps/${live._id}`, 'PUT', { status: 'archived' });
  assert.equal(archived.roadmap.status, 'archived');
  assert.ok(!(await publicIds()).includes(live._id));

  // The roadmap shipped in the seed fixture is already published; saving its settings must keep working.
  const { roadmaps } = await admin('/admin/roadmaps');
  const seeded = roadmaps.find(item => item.slug === 'level-0-37e4fa');
  assert.equal(seeded.status, 'published');
  const { roadmap: resaved } = await admin(`/admin/roadmaps/${seeded._id}`, 'PUT', {
    title: seeded.title,
    description: seeded.description,
    coverImageUrl: seeded.coverImageUrl || '',
    difficulty: seeded.difficulty,
    estimatedDuration: seeded.estimatedDuration || '',
    objectives: seeded.objectives,
    audience: seeded.audience || '',
    prerequisites: seeded.prerequisites || '',
  });
  assert.equal(resaved.status, 'published');
  assert.ok(!resaved.publishedAt, 'a roadmap that was already published is not given a new publish date');
});

test('I. a new roadmap is always created as a draft', async () => {
  const admin = await startAdmin();

  const sneaky = await createDraft(admin, { status: 'published' });
  assert.equal(sneaky.status, 'draft');
  assert.ok(!sneaky.publishedAt);
  assert.ok(!(await publicIds()).includes(sneaky._id));

  // The import flow posts the validated roadmap with status 'draft' and needs the new id back.
  const imported = await createDraft(admin, { title: 'Imported track', status: 'draft' });
  assert.equal(imported.status, 'draft');
  assert.equal(imported.title, 'Imported track');
  assert.equal(typeof imported._id, 'string');
  const node = await addNode(admin, imported._id, { title: 'Imported topic' });
  assert.equal(typeof node._id, 'string');

  const { roadmaps } = await admin('/admin/roadmaps');
  for (const id of [sneaky._id, imported._id]) assert.equal(roadmaps.find(item => item._id === id).status, 'draft');
});

test('J. a cycle cannot be published while its roadmap is not published', async () => {
  const admin = await startAdmin();
  const draft = await createDraft(admin);
  await addNode(admin, draft._id);
  const cyclesOf = async () => (await adminView(admin, draft._id)).roadmap.cycles;
  const notPublished = error => error.status === 409 && error.message === 'Publish the roadmap before publishing its cycle.';

  await assert.rejects(() => admin(`/admin/roadmaps/${draft._id}/cycles`, 'POST', cycleBody({ status: 'published' })), notPublished);
  assert.deepEqual(await cyclesOf(), [], 'a rejected cycle must not be stored');

  const { cycle } = await admin(`/admin/roadmaps/${draft._id}/cycles`, 'POST', cycleBody());
  assert.equal(cycle.status, 'draft');

  await assert.rejects(() => admin(`/admin/roadmap-cycles/${cycle._id}`, 'PUT', { status: 'published', capacity: 99 }), notPublished);
  const [stored] = await cyclesOf();
  assert.equal(stored.status, 'draft');
  assert.equal(stored.capacity, 30, 'a rejected update must not save the other fields either');

  // Everything else about cycle editing is unchanged.
  const edited = await admin(`/admin/roadmap-cycles/${cycle._id}`, 'PUT', { capacity: 40 });
  assert.equal(edited.cycle.capacity, 40);
  assert.equal(edited.cycle.status, 'draft');

  await admin(`/admin/roadmaps/${draft._id}`, 'PUT', { status: 'published' });
  const published = await admin(`/admin/roadmap-cycles/${cycle._id}`, 'PUT', { status: 'published' });
  assert.equal(published.cycle.status, 'published');
  const second = await admin(`/admin/roadmaps/${draft._id}/cycles`, 'POST', cycleBody({ order: 2, status: 'published' }));
  assert.equal(second.cycle.status, 'published');

  // Once the roadmap is completed, a published cycle can still be closed out but not re-saved as published.
  await admin(`/admin/roadmaps/${draft._id}`, 'PUT', { status: 'completed' });
  await assert.rejects(() => admin(`/admin/roadmap-cycles/${cycle._id}`, 'PUT', { status: 'published' }), notPublished);
  const closed = await admin(`/admin/roadmap-cycles/${cycle._id}`, 'PUT', { status: 'completed' });
  assert.equal(closed.cycle.status, 'completed');
});
