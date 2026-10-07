const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");

async function run(viewport) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const page = await browser.newPage({ viewport, serviceWorkers: "block" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/config.js", route => route.fulfill({ contentType: "text/javascript", body: "window.SCI_RUVELON_CONFIG = {};" }));
    await page.goto("http://127.0.0.1:8792", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Mode apercu local" }).click();
    await page.evaluate(() => {
      localStorage.setItem("ruvelon_v3_travaux", JSON.stringify([
        { id: "one", titre: "Réfection toiture", priorite: "P1", statut: "0 - À chiffrer", montant_estime: 1000, montant_reel: 0, observations: JSON.stringify({ version_travaux: 1, annee: 2027, devis_ht: 900, notes: "Note conservée", ppi: { 2028: 1000 }, source_key: "test-one" }) },
        { id: "two", titre: "Éclairage", priorite: "P2", statut: "5 - En cours", montant_estime: 100, montant_reel: 50, observations: JSON.stringify({ version_travaux: 1, annee: 2026 }) }
      ]));
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Mode apercu local" }).click();
    await page.locator('button[data-route="travaux"]').click();
    assert.match(await page.locator("#screen").innerText(), /1100.00 EUR/);
    await page.getByLabel("Année travaux").selectOption("2027");
    const visibleList = viewport.width < 768 ? page.locator(".works-panel .mobile-list") : page.locator(".works-table");
    assert.match(await visibleList.innerText(), /Réfection toiture/);
    assert.doesNotMatch(await visibleList.innerText(), /Éclairage/);
    await page.evaluate(() => App.openTravaux("one"));
    const form = page.locator("#edit-form");
    await form.locator('[name="annee_cible"]').fill("2028");
    await form.locator('[name="montant_estime"]').fill("1200");
    await form.locator('[name="devis_ht_travaux"]').fill("1100");
    assert.equal(await page.locator("#modal-body").evaluate(e => e.scrollWidth > e.clientWidth + 1), false);
    await form.getByRole("button", { name: "Enregistrer" }).click();
    await page.waitForFunction(() => document.getElementById("modal").hidden);
    const row = await page.evaluate(() => JSON.parse(localStorage.getItem("ruvelon_v3_travaux")).find(t => t.id === "one"));
    const detail = JSON.parse(row.observations);
    assert.equal(detail.annee, 2028);
    assert.equal(detail.devis_ht, 1100);
    assert.equal(detail.source_key, "test-one");
    assert.equal(detail.notes, "Note conservée");
    assert.equal(row.montant_estime, 1200);
    await page.getByLabel("Année travaux").selectOption("");
    assert.equal(await page.locator("#screen").evaluate(e => e.scrollWidth > e.clientWidth + 1), false);
    await page.screenshot({ path: path.join(os.tmpdir(), `ruvelon-travaux-${viewport.width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

(async () => {
  const server = spawn(process.execPath, ["dev-server.js"], { env: { ...process.env, PORT: "8792" } });
  try {
    await new Promise((resolve, reject) => { server.stdout.once("data", resolve); server.once("error", reject); });
    await run({ width: 1440, height: 900 });
    await run({ width: 390, height: 844 });
    console.log("OK - synthese, filtres, saisie travaux et conservation des details desktop/mobile");
  } finally { server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
