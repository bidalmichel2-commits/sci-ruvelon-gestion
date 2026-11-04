const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

async function run(viewport) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const page = await browser.newPage({ viewport, serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/config.js', route => route.fulfill({ contentType: 'text/javascript', body: 'window.SCI_RUVELON_CONFIG = {};' }));
    await page.goto('http://127.0.0.1:8795', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Mode apercu local' }).click();
    await page.evaluate(() => {
      localStorage.setItem('ruvelon_v3_loyers_mensuels', JSON.stringify([
        { id: 'full', mois: '2026-11-01', facture_meg_faite: true, loyer_ht: 1000, tva: 200, loyer_ttc: 1200, charges_mensuelles: 100, total_attendu: 1300, total_paye: 1300 },
        { id: 'partial', mois: '2026-11-01', facture_meg_faite: true, loyer_ht: 1000, tva: 200, loyer_ttc: 1200, total_attendu: 1200, total_paye: 600 },
        { id: 'unpaid', mois: '2026-11-01', loyer_ht: 1000, total_attendu: 1200, total_paye: 0 },
        { id: 'dec', mois: '2026-12-01', loyer_ht: 100, total_attendu: 120, total_paye: 120 }
      ]));
      localStorage.setItem('ruvelon_v3_remuneration_gerant', JSON.stringify([{ id: 'old-month', annee: 2026, mois: '2026-11-01', encaissements_ht: 50, observations: JSON.stringify({ version: 1, encaissements_source: 'manuel', encaissements: [{ loyer_ht: 50, encaissement_ht: 50 }] }) }]));
      localStorage.setItem('ruvelon_v3_baux', JSON.stringify([
        { id: 'usual', statut: 'Actif', date_debut: '2027-01-01', date_fin: '2027-12-31', loyer_ht: 600 },
        { id: 'future', statut: 'Actif', date_debut: '2027-05-01', loyer_ht: 150 },
        { id: 'secondary', statut: 'Actif', date_debut: '2027-01-01', loyer_ht: 600, observations: '[LOCAL_SECONDAIRE]' }
      ]));
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Mode apercu local' }).click();
    await page.evaluate(() => { App.setMonth('2026-11'); App.setYear('2026'); App.go('remuneration'); App.openRemuneration(); });
    const form = page.locator('#edit-form');
    const ht = () => form.locator('[data-recap="encaissements"]').innerText();
    assert.equal(await ht(), '1500.00 EUR');
    assert.equal(await form.locator('[name="encaissements_source"]').inputValue(), 'pointage');
    assert.deepEqual(await form.locator('[data-field="loyer_ht"]').evaluateAll(els => els.map(e=>Number(e.value))), [3000]);
    assert.deepEqual(await form.locator('[data-field="encaissement_ht"]').evaluateAll(els => els.map(e=>Number(e.value))), [1500]);
    assert.equal(await form.locator('[data-recap="factures_ht"]').innerText(), '3000.00 EUR');
    await form.locator('.monthly-receipt').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(os.tmpdir(), `ruvelon-totaux-${viewport.width}.png`) });
    assert.equal(await form.locator('[data-field="encaissement_ht"]').first().isEditable(), false);
    await form.locator('[name="mois"]').fill('2026-12');
    await form.locator('[name="mois"]').dispatchEvent('change');
    assert.equal(await ht(), '100.00 EUR');
    await form.locator('[name="mois"]').fill('2027-01');
    await form.locator('[name="mois"]').dispatchEvent('change');
    assert.equal(await ht(), '600.00 EUR');
    assert.equal(await form.locator('[data-field="loyer_ht"]').inputValue(), '600.00');
    assert.match(await form.locator('[data-detail-list="encaissements"]').innerText(), /Sans pointage/);
    await form.locator('[name="mois"]').fill('2026-11');
    await form.locator('[name="mois"]').dispatchEvent('change');
    assert.equal(await ht(), '1500.00 EUR');
    assert.equal(await page.locator('#modal-body').evaluate(e => e.scrollWidth > e.clientWidth + 1), false);
    await form.getByRole('button', { name: 'Enregistrer le mois' }).click();
    await page.waitForFunction(() => document.getElementById('modal').hidden);
    let row = await page.evaluate(() => JSON.parse(localStorage.getItem('ruvelon_v3_remuneration_gerant')).find(r => r.mois === '2026-11-01'));
    assert.equal(row.encaissements_ht, 1500);
    assert.equal(JSON.parse(row.observations).encaissements_source, 'pointage');
    assert.equal(JSON.parse(row.observations).encaissements.length, 1);
    await page.evaluate(() => App.toggleLoyer('partial', 'paiement_controle'));
    row = await page.evaluate(() => JSON.parse(localStorage.getItem('ruvelon_v3_remuneration_gerant')).find(r => r.mois === '2026-11-01'));
    assert.equal(row.encaissements_ht, 2000);
    assert.equal(row.total_compte_courant, 98);
    await page.evaluate(() => App.toggleLoyer('partial', 'paiement_controle'));
    row = await page.evaluate(() => JSON.parse(localStorage.getItem('ruvelon_v3_remuneration_gerant')).find(r => r.mois === '2026-11-01'));
    assert.equal(row.encaissements_ht, 1000);
    await page.evaluate(id => App.openRemuneration(id), row.id);
    await form.locator('[name="encaissements_source"]').selectOption('manuel');
    await form.locator('[data-field="encaissement_ht"]').first().fill('200');
    await form.getByRole('button', { name: 'Enregistrer le mois' }).click();
    await page.waitForFunction(() => document.getElementById('modal').hidden);
    await page.evaluate(() => App.toggleLoyer('partial', 'paiement_controle'));
    row = await page.evaluate(() => JSON.parse(localStorage.getItem('ruvelon_v3_remuneration_gerant')).find(r => r.mois === '2026-11-01'));
    assert.equal(row.encaissements_ht, 200);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

(async () => {
  const server = spawn(process.execPath, ['dev-server.js'], { env: { ...process.env, PORT: '8795' } });
  try {
    await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });
    await run({ width: 1440, height: 900 });
    await run({ width: 390, height: 844 });
    console.log('OK - pointage HT, prorata, changement mois, synchronisation, mode manuel desktop/mobile');
  } finally { server.kill(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
