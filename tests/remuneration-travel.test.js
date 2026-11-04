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
    await page.goto('http://127.0.0.1:8794', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Mode apercu local' }).click();
    await page.evaluate(() => App.go('remuneration'));
    await page.evaluate(() => App.openRemuneration());
    const form = page.locator('#edit-form');
    await form.locator('[name="encaissements_source"]').selectOption('manuel');
    await form.locator('[data-field="encaissement_ht"]').fill('1000');
    const first = form.locator('[data-detail-kind="interventions"]').first();
    await first.locator('[data-field="activite"]').selectOption('Visite de local');
    await first.locator('[data-field="km"]').fill('40');
    assert.equal(await first.locator('[data-field="non_facturable"]').isChecked(), true);
    assert.equal(await first.locator('[data-field="non_facturable"]').isDisabled(), true);
    await page.evaluate(() => App.addRemunerationLine('interventions', document.getElementById('edit-form')));
    const second = form.locator('[data-detail-kind="interventions"]').nth(1);
    await second.locator('[data-field="activite"]').selectOption('Gestion entreprise travaux');
    await second.locator('[data-field="km"]').fill('20');
    const recap = name => form.locator(`[data-recap="${name}"]`).innerText();
    assert.equal(await recap('frais_km'), '12.72 EUR');
    assert.equal(await recap('frais_perso'), '18.80 EUR');
    assert.equal(await recap('km_perso'), '40.0');
    assert.equal(await recap('cout_deplacements'), '28.20 EUR');
    assert.equal(await first.locator('[data-travel="perso"]').innerText(), '18.80 EUR');
    assert.equal(await recap('total'), '61.72 EUR');
    await second.locator('[data-field="non_facturable"]').check();
    assert.equal(await recap('frais_km'), '0.00 EUR');
    assert.equal(await recap('frais_perso'), '28.20 EUR');
    assert.equal(await recap('km_perso'), '60.0');
    await second.locator('[data-field="non_facturable"]').uncheck();
    await second.locator('[data-field="motif_deplacement"]').selectOption('visite');
    assert.equal(await recap('frais_km'), '0.00 EUR');
    await second.locator('[data-field="motif_deplacement"]').selectOption('autre');
    assert.equal(await recap('frais_km'), '12.72 EUR');
    assert.equal(await page.locator('#modal-body').evaluate(e => e.scrollWidth > e.clientWidth + 1), false);
    const positions = await first.locator('.intervention-inline input:not([type="checkbox"]), .intervention-inline select').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().bottom)));
    assert.equal(new Set(positions).size, 1, 'Tous les champs doivent etre alignes sur une ligne');
    await form.getByRole('button', { name: 'Enregistrer le mois' }).click();
    await page.waitForFunction(() => document.getElementById('modal').hidden);
    const row = await page.evaluate(() => JSON.parse(localStorage.getItem('ruvelon_v3_remuneration_gerant'))[0]);
    assert.equal(row.km, 20);
    assert.equal(row.frais_km, 12.72);
    assert.equal(row.total_compte_courant, 61.72);
    const details = JSON.parse(row.observations);
    assert.equal(details.interventions[0].km, 40);
    assert.equal(details.interventions[0].non_facturable, true);
    assert.match(await page.locator('#screen').innerText(), /18.80 EUR/);
    assert.match(await page.locator('#screen').innerText(), /40.0 km/);
    await page.evaluate(id => App.openRemuneration(id), row.id);
    assert.equal(await recap('frais_km'), '12.72 EUR');
    assert.equal(await recap('frais_perso'), '18.80 EUR');
    assert.equal(await recap('km_perso'), '40.0');
    await first.scrollIntoViewIfNeeded();
    await page.locator('[data-detail-list="interventions"]').evaluate(e => e.scrollLeft = 0);
    await page.screenshot({ path: path.join(os.tmpdir(), `ruvelon-deplacements-${viewport.width}.png`) });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

(async () => {
  const server = spawn(process.execPath, ['dev-server.js'], { env: { ...process.env, PORT: '8794' } });
  try {
    await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });
    await run({ width: 1440, height: 900 });
    await run({ width: 390, height: 844 });
    console.log('OK - visites exclues, frais SCI/personnels, sauvegarde et reouverture desktop/mobile');
  } finally { server.kill(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
