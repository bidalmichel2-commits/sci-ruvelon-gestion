const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the real payload preparation without starting authentication or writing data.
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const context = { window: {}, console, Date, Intl, setTimeout, clearTimeout };
vm.createContext(context);
vm.runInContext(source.slice(0, source.lastIndexOf('  initInstall();')) +
  'window.test = { stripGenerated, travauxOrigin }; })();', context);
const clean = context.window.test.stripGenerated('travaux', { id: '', titre: 'Test', date_prevue: null });
assert.equal(Object.hasOwn(clean, 'id'), false);
assert.equal(clean.date_prevue, null);
assert.equal(context.window.test.stripGenerated('travaux', { id: 'existing' }).id, 'existing');
assert.equal(context.window.test.travauxOrigin({ observations: JSON.stringify({ version_travaux: 1, source_key: 'ruvelon_travaux_v2_1' }) }), 'base');
assert.equal(context.window.test.travauxOrigin({}), 'nouveau');
console.log('OK - UUID vide omis, identifiant existant conserve, origine historique reconnue');
