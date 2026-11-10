(function (root, factory) {
  const api = factory();
  if (typeof module === 'object') module.exports = api;
  if (root) root.DcdvChallengeMetrics = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  const MAX_MS = 365 * 24 * 60 * 60 * 1000;
  function valid(value) {
    return value?.version === 1 && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= MAX_MS
      && Number.isSafeInteger(value.errors) && value.errors >= 0 && value.errors <= 100000;
  }
  // The clock is local to a page. Only accumulated milliseconds are saved, so
  // reopening a page/device never counts the time spent away from that page.
  function createTracker({ getState, now = () => performance.now(), wallNow = () => Date.now(), onChange = () => {} }) {
    let activeKey = null, lastTick = null;
    const historyKeys = () => new Set(['completed', 'results', 'practice', 'hints', 'compileResults', 'schematicDrafts', 'fsmDrafts'].flatMap(field => Object.keys(getState()[field] || {})));
    let legacyKeys = historyKeys();
    function ensure(key) {
      const state = getState();
      if (state.completed?.[key]) return null;
      state.metrics ||= {};
      if (!valid(state.metrics[key])) {
        state.metrics[key] = { version: 1, elapsedMs: 0, errors: 0, partial: legacyKeys.has(key), completedAt: null };
        onChange();
      }
      return state.metrics[key];
    }
    function checkpoint() {
      const tick = now();
      const metric = activeKey && getState().metrics?.[activeKey];
      if (valid(metric) && !metric.completedAt && !getState().completed?.[activeKey] && lastTick !== null) {
        const delta = Math.round(tick - lastTick);
        // A suspended browser/computer can skip heartbeats for hours; do not
        // interpret that gap as study time. Normal heartbeats run every 15 s.
        if (delta > 0 && delta <= 60000) { metric.elapsedMs = Math.min(MAX_MS, metric.elapsedMs + delta); onChange(); }
      }
      lastTick = tick;
    }
    return {
      checkpoint,
      sync(key, enabled) {
        checkpoint();
        activeKey = enabled && key && ensure(key) ? key : null;
        lastTick = now();
      },
      pause() { checkpoint(); activeKey = null; lastTick = null; },
      reset() { activeKey = null; lastTick = null; legacyKeys = historyKeys(); },
      record(key, ok) {
        if (typeof ok !== 'boolean') return;
        checkpoint();
        const metric = ensure(key);
        if (!metric || metric.completedAt) return;
        if (ok) { metric.completedAt = new Date(wallNow()).toISOString(); if (activeKey === key) activeKey = null; }
        else metric.errors = Math.min(100000, metric.errors + 1);
        onChange();
      }
    };
  }
  return { createTracker, valid };
});
