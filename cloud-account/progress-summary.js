'use strict';
const catalog = require('./catalog.json');
const validCounter = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
function summarize(state, updatedAt = null) {
  const levels = catalog.map(level => {
    const metric = state?.metrics?.[level.key];
    const known = metric?.version === 1 && validCounter(metric.elapsedMs, 365 * 86400000) && validCounter(metric.errors, 100000);
    const completed = state?.completed?.[level.key] === true;
    const completedAt = known && typeof metric.completedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(metric.completedAt) && Number.isFinite(Date.parse(metric.completedAt)) ? new Date(metric.completedAt).toISOString() : null;
    return {
      ...level,
      completed,
      latestResult: typeof state?.results?.[level.key]?.ok === 'boolean' ? (state.results[level.key].ok ? 'passed' : 'failed') : 'unattempted',
      hints: Number.isSafeInteger(state?.hints?.[level.key]) ? Math.max(0, Math.min(100000, state.hints[level.key])) : 0,
      elapsedMs: known ? metric.elapsedMs : null,
      completionTimeMs: known && completed && completedAt ? metric.elapsedMs : null,
      errorCount: known ? metric.errors : null,
      metricsPartial: known ? metric.partial !== false : true,
      completedAt: completed ? completedAt : null,
    };
  });
  const completed = levels.filter(level => level.completed).length;
  const measured = levels.filter(level => level.errorCount !== null);
  const timed = levels.filter(level => level.completionTimeMs !== null);
  const unmeasuredHistory = catalog.some(level => !measured.some(item => item.key === level.key) && ['completed', 'results', 'practice', 'hints', 'compileResults', 'schematicDrafts', 'fsmDrafts'].some(field => Object.hasOwn(state?.[field] || {}, level.key)));
  return { version: 2, completed, total: catalog.length, rate: Math.round(100 * completed / catalog.length), updatedAt, levels,
    completionTimeMs: timed.length ? timed.reduce((sum, level) => sum + level.completionTimeMs, 0) : null,
    completionTimeRecorded: timed.length,
    completionTimePartial: timed.some(level => level.metricsPartial) || timed.length < completed,
    errorCount: measured.length ? measured.reduce((sum, level) => sum + level.errorCount, 0) : null,
    errorsPartial: unmeasuredHistory || measured.some(level => level.metricsPartial),
  };
}
module.exports = { summarize, catalog };
