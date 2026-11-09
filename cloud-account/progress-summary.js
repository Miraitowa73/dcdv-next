'use strict';
const catalog = require('./catalog.json');
function summarize(state, updatedAt = null) {
  const levels = catalog.map(level => ({
    ...level,
    completed: state?.completed?.[level.key] === true,
    latestResult: typeof state?.results?.[level.key]?.ok === 'boolean' ? (state.results[level.key].ok ? 'passed' : 'failed') : 'unattempted',
    hints: Number.isSafeInteger(state?.hints?.[level.key]) ? Math.max(0, Math.min(100000, state.hints[level.key])) : 0,
  }));
  const completed = levels.filter(level => level.completed).length;
  return { completed, total: catalog.length, rate: Math.round(100 * completed / catalog.length), updatedAt, levels };
}
module.exports = { summarize, catalog };
