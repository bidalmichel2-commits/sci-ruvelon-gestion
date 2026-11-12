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
    await page.getByRole("button", { name: "Ajouter une taxe foncière" }).click();
    const form = page.locator("#edit-form");
    await form.locator('[name="locataire_id"]').selectOption({ index: 1 });
    assert.ok(await form.locator('[name="local_id"]').inputValue(), "Le local doit être renseigné automatiquement depuis le bail.");
    const currentYear = String(new Date().getFullYear());
    await form.locator('[name="annee"]').fill(currentYear);
    await form.locator('[name="date_facturation"]').fill(currentYear + "-09-01");
    await form.locator('[name="montant"]').fill("1250.50");
    await form.locator('[name="transmise"]').check();
    await form.locator('[name="base_contractuelle"]').fill("Clause de refacturation de la taxe foncière prévue au bail.");
    await form.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("modal").hidden);
    const screen = page.locator(".property-tax-panel");
    assert.match(await screen.innerText(), /1250,50 €/);
    assert.match(await screen.innerText(), /Transmise : Oui/);
    assert.match(await screen.innerText(), /Acquittée : Non/);
    assert.match(await screen.innerText(), /Clause de refacturation/);
    let saved = await page.evaluate(() => JSON.parse(localStorage.getItem("ruvelon_v3_documents")).find(row => row.categorie === "taxe_fonciere"));
    let details = JSON.parse(saved.observations);
    assert.equal(details.montant, 1250.5);
    assert.equal(details.transmise, true);
    assert.equal(details.acquittee, false);
    assert.ok(saved.local_id);
    assert.ok(saved.locataire_id);

    await screen.getByRole("button", { name: "Modifier", exact: true }).click();
    await page.locator('[name="acquittee"]').check();
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("modal").hidden);
    assert.match(await screen.innerText(), /Acquittée : Oui/);
    saved = await page.evaluate(() => JSON.parse(localStorage.getItem("ruvelon_v3_documents")).find(row => row.categorie === "taxe_fonciere"));
    details = JSON.parse(saved.observations);
    assert.equal(details.acquittee, true);
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
    console.log("OK - taxes foncières : liaison preneur/local, transmission, acquittement, desktop/mobile");
  } finally {
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
