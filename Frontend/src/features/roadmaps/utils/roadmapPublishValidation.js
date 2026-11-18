// Plain module (no JSX, no imports) so the admin page, the Spark adapter and node --test can all share it.

export function validateImportText(value, label, maxLength, { required = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if (required && !normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  return normalized;
}

export function validateImportUrl(value, label) {
  const normalized = validateImportText(value, label, 500, { required: true });
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL.`);
  }
  return url.toString();
}

export function validateRoadmapForPublish(roadmap, nodes) {
  if (!roadmap.title?.trim() || !roadmap.description?.trim()) {
    throw new Error('Add a roadmap title and description before publishing.');
  }
  if (!['beginner', 'intermediate', 'advanced'].includes(roadmap.difficulty)) {
    throw new Error('Choose a supported roadmap difficulty before publishing.');
  }
  if (roadmap.coverImageUrl) validateImportUrl(roadmap.coverImageUrl, 'Cover image URL');
  if (!Array.isArray(roadmap.objectives) || roadmap.objectives.length > 30) {
    throw new Error('Roadmap objectives must contain up to 30 items.');
  }
  roadmap.objectives.forEach((objective, index) => validateImportText(objective, `Objective ${index + 1}`, 160));
  if (!nodes.length) throw new Error('Add at least one learning topic before publishing.');
  const nodeIds = nodes.map(node => String(node._id));
  if (nodes.some(node => typeof node._id !== 'string' || !node._id.trim()) || new Set(nodeIds).size !== nodeIds.length) {
    throw new Error('Learning topics must have unique, valid server identifiers.');
  }
  const knownIds = new Set(nodeIds);
  const childrenById = new Map(nodes.map(node => [String(node._id), []]));
  const pending = new Map();
  for (const node of nodes) {
    const dependencies = (node.dependencies || []).map(String);
    if (dependencies.length > 100 || new Set(dependencies).size !== dependencies.length || dependencies.some(id => !knownIds.has(id) || id === String(node._id))) {
      throw new Error(`Fix missing or self-referencing prerequisites on "${node.title}".`);
    }
    for (const dependency of dependencies) childrenById.get(dependency).push(String(node._id));
    pending.set(String(node._id), dependencies.length);
    if (!node.title?.trim()) throw new Error('Every learning topic needs a title.');
    validateImportText(node.title, `Topic "${node.title}" title`, 140, { required: true });
    validateImportText(node.description || '', `Topic "${node.title}" description`, 3000);
    if (!Number.isInteger(node.position) || node.position < 0) throw new Error(`Topic "${node.title}" has an invalid order.`);
    if (node.estimatedHours !== null && node.estimatedHours !== undefined && (!Number.isFinite(Number(node.estimatedHours)) || Number(node.estimatedHours) < 0)) {
      throw new Error(`Topic "${node.title}" has invalid estimated hours.`);
    }
    if (!Array.isArray(node.resources) || node.resources.length > 30 || !Array.isArray(node.problems) || node.problems.length > 100) {
      throw new Error(`Topic "${node.title}" has too many or invalid learning links.`);
    }
    node.resources.forEach((resource, index) => {
      validateImportText(resource.title, `Topic "${node.title}" resource ${index + 1} title`, 140, { required: true });
      validateImportUrl(resource.url, `Topic "${node.title}" resource ${index + 1} URL`);
    });
    node.problems.forEach((problem, index) => {
      validateImportText(problem.title, `Topic "${node.title}" problem ${index + 1} title`, 140, { required: true });
      validateImportUrl(problem.url, `Topic "${node.title}" problem ${index + 1} URL`);
      if (!['easy', 'medium', 'hard'].includes(problem.difficulty || 'medium')) {
        throw new Error(`Topic "${node.title}" problem ${index + 1} has an unsupported difficulty.`);
      }
    });
  }
  const ready = [...pending].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length) {
    const id = ready.pop();
    visited += 1;
    for (const childId of childrenById.get(id)) {
      pending.set(childId, pending.get(childId) - 1);
      if (pending.get(childId) === 0) ready.push(childId);
    }
  }
  if (visited !== nodes.length) throw new Error('Fix the circular prerequisite relationships before publishing.');
}
