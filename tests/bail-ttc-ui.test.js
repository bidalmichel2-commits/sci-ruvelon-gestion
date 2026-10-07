const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");

async function run(viewport) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const page = await browser.newPage({ viewport });
    await page.route("**/config.js", route => route.fulfill({ contentType: "text/javascript", body: "window.SCI_RUVELON_CONFIG = {};" }));
    await page.goto("http://127.0.0.1:8791", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Mode apercu local" }).click();
    await page.evaluate(() => App.openBail());
    const form = page.locator("#edit-form");
    await form.locator('[name="total_ttc_charges"]').fill("200");
    await form.locator('[name="charges_mensuelles"]').fill("32.34");
    assert.equal(await form.locator('[name="loyer_ttc_calcule"]').inputValue(), "167.66");
    assert.equal(await form.locator('[name="loyer_ht"]').inputValue(), "139.72");
    assert.equal(await form.locator('[name="tva_montant_calcule"]').inputValue(), "27.94");
    await form.locator('[name="charges_mensuelles"]').fill("250");
    assert.equal(await form.evaluate(f => f.checkValidity()), false);
    await form.locator('[name="charges_mensuelles"]').fill("32.34");
    await form.locator('[name="date_debut"]').fill("2026-01-01");
    await form.getByRole("button", { name: "Enregistrer" }).click();
    await page.waitForFunction(() => document.getElementById("modal").hidden);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("ruvelon_v3_baux")).at(-1));
    assert.equal(saved.loyer_ht, 139.72);
    assert.equal(saved.tva, 20);
    assert.equal(saved.charges_mensuelles, 32.34);
    assert.equal("total_ttc_charges" in saved, false);
    await page.evaluate(() => { App.setMonth("2026-10"); App.go("pointage"); });
    await page.evaluate(() => App.generateRents());
    const rent = await page.evaluate(id => JSON.parse(localStorage.getItem("ruvelon_v3_loyers_mensuels")).find(r => r.bail_id === id), saved.id);
    assert.equal(rent.total_attendu, 200);
    assert.equal(rent.tva, 27.94);
  } finally {
    await browser.close();
  }
}

(async () => {
  const server = spawn(process.execPath, ["dev-server.js"], { env: { ...process.env, PORT: "8791" } });
  try {
    await new Promise((resolve, reject) => { server.stdout.once("data", resolve); server.once("error", reject); });
    await run({ width: 1440, height: 900 });
    await run({ width: 390, height: 844 });
    console.log("OK - bail TTC, validation et generation du pointage desktop/mobile");
  } finally { server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
