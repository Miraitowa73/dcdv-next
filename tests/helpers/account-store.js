'use strict';
const { randomUUID } = require('node:crypto');
// Test/preview only. Production index.js always requires the Tablestore adapter.
function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async get(table, key) { return structuredClone(rows.get(`${table}:${key}`) || null); },
    async summary(key) { return structuredClone(rows.get(`progress:${key}`)?.value.summary || null); },
    async scan(table, prefix, cursor = null, limit = 100) {
      const matches = [...rows].filter(([key]) => key.startsWith(`${table}:${prefix}`) && (!cursor || key >= `${table}:${cursor}`)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return { rows: matches.slice(0, limit).map(([key, row]) => ({ key: key.slice(table.length + 1), ...structuredClone(row) })), cursor: matches[limit]?.[0].slice(table.length + 1) || null };
    },
    async put(table, key, value, expected, version = randomUUID()) {
      const id = `${table}:${key}`;
      if ((rows.get(id)?.version ?? null) !== expected) return false;
      rows.set(id, { value: structuredClone(value), version });
      return true;
    },
    async delete(table, key) { rows.delete(`${table}:${key}`); },
  };
}
module.exports = { memoryStore };
