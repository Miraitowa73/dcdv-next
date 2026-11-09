'use strict';
const { randomUUID } = require('node:crypto');
// Test/preview only. Production index.js always requires the Tablestore adapter.
function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async get(table, key) { return structuredClone(rows.get(`${table}:${key}`) || null); },
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
