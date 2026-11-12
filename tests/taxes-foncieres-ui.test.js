const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");

async function run(viewport, port) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const page = await browser.newPage({ viewport, serviceWorkers: "block" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/config.js", route => route.fulfill({ contentType: "text/javascript", body: "window.SCI_RUVELON_CONFIG = {};" }));
    await page.goto("http://127.0.0.1:" + port, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Mode apercu local" }).click();
    await page.locator('[data-route="taxes-foncieres"]').click();

    await page.getByRole("button", { name: "Ajouter l’avis SCI" }).click();
    let form = page.locator("#edit-form");
    const year = String(new Date().getFullYear());
    await form.locator('[name="annee"]').fill(year);
    await form.locator('[name="date_facturation"]').fill(year + "-09-01");
    await form.locator('[name="montant_total"]').fill("2000");
    await form.locator('[name="tva_taux"]').fill("20");
    await form.locator('[name="surface_reference"]').fill("100");
    await form.locator('[name="acquittee_sci"]').check();
    await form.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("modal").hidden);

    const screen = page.locator(".property-tax-panel");
    assert.match(await screen.innerText(), /2\s?000,00 €/);
    assert.match(await screen.innerText(), /Acquittée par la SCI : Oui/);
    await screen.getByRole("button", { name: "Ajouter une refacturation" }).click();
    form = page.locator("#edit-form");
    await form.locator('[name="locataire_id"]').selectOption({ index: 1 });
    assert.ok(await form.locator('[name="local_id"]').inputValue(), "Le local du bail doit être repris automatiquement.");
    await form.locator('[name="methode"]').selectOption("surface");
    await form.locator('[name="surface_m2"]').fill("16");
    await form.locator('[name="base_contractuelle"]').fill("Quote-part de surface prévue au bail.");
    await form.locator('[name="statut"]').selectOption("Facture transmise");
    assert.equal(await form.locator('[name="jours"]').inputValue(), "365");
    assert.equal(await form.locator('[name="montant_ht"]').inputValue(), "320.00");
    assert.equal(await form.locator('[name="montant_tva"]').inputValue(), "64.00");
    assert.equal(await form.locator('[name="montant_ttc"]').inputValue(), "384.00");
    await form.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("modal").hidden);
    assert.match(await screen.innerText(), /Transmis : 384,00 €/);
    assert.match(await screen.innerText(), /Base contractuelle/);

    let saved = await page.evaluate(() => JSON.parse(localStorage.getItem("ruvelon_v3_documents")));
    const bill = saved.find(row => row.categorie === "taxe_fonciere_sci");
    const allocation = saved.find(row => row.categorie === "taxe_fonciere");
    assert.ok(bill, "L’avis payé par la SCI est enregistré séparément.");
    assert.ok(allocation?.local_id && allocation?.locataire_id, "La refacturation garde ses liens preneur/local.");
    let details = JSON.parse(allocation.observations);
    assert.equal(details.montant_ht, 320);
    assert.equal(details.montant_tva, 64);
    assert.equal(details.montant_ttc, 384);
    assert.equal(details.jours, 365);
    assert.equal(details.transmise, true);

    await screen.getByRole("button", { name: "Modifier", exact: true }).click();
    await page.locator('[name="statut"]').selectOption("Payé");
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("modal").hidden);
    assert.match(await screen.innerText(), /Payé par preneurs : 384,00 €/);
    saved = await page.evaluate(() => JSON.parse(localStorage.getItem("ruvelon_v3_documents")));
    details = JSON.parse(saved.find(row => row.categorie === "taxe_fonciere").observations);
    assert.equal(details.payee_preneur, true);
    assert.equal(await page.locator("#screen").evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

(async () => {
  const port = "8798";
  const server = spawn(process.execPath, ["dev-server.js"], { env: { ...process.env, PORT: port } });
  try {
    await new Promise((resolve, reject) => { server.stdout.once("data", resolve); server.once("error", reject); });
    await run({ width: 1440, height: 900 }, port);
    await run({ width: 390, height: 844 }, port);
    console.log("OK - avis SCI, quote-part contractuelle, calcul HT/TVA/TTC, statut preneur, desktop/mobile");
  } finally {
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
