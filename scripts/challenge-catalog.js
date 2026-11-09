// Export public lesson metadata only; never include answers, tests or hints.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function readCatalog() {
  const html = fs.readFileSync(path.join(__dirname, '../cloud-test/index.html'), 'utf8');
  const source = html.slice(html.indexOf('const challengeCatalog ='), html.indexOf('const challengeState ='));
  return JSON.parse(JSON.stringify(vm.runInNewContext(`${source}; challengeCatalog.flatMap(g => g.levels.map(l => ({key:g.id+':'+l.id, group:g.title, title:l.title})))`, { rows: () => [], makeTruthRows: () => [] })));
}
if (require.main === module) fs.writeFileSync(path.join(__dirname, '../cloud-account/catalog.json'), JSON.stringify(readCatalog(), null, 2) + '\n');
module.exports = { readCatalog };
