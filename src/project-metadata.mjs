const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read project provenance only from structured transcript metadata. */
export function recordProjectPaths(record) {
  if (!isObject(record)) return [];
  const payload = isObject(record.payload) ? record.payload : null;
  const message = isObject(record.message) ? record.message : null;
  const item = record.type === 'response_item' && payload ? payload : message ?? payload ?? record;
  return [...new Set([
    record.cwd, record.projectPath, record.project_path, record.workspace,
    payload?.cwd, payload?.projectPath, payload?.project_path,
    item.cwd
  ].filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

/** Both collection and semantic projection retain the first project identity. */
export function observeProjectMetadata(state, record) {
  state._projectPathsSeen ??= new Set(state.projectPaths);
  for (const project of recordProjectPaths(record)) {
    if (!state._projectPathsSeen.has(project)) {
      state._projectPathsSeen.add(project);
      state.projectPaths.push(project);
    }
    state.project ??= project;
  }
}
