const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

async function run(viewport) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const page = await browser.newPage({ viewport, serviceWorkers: "block" });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/config.js", route => route.fulfill({ contentType: "text/javascript", body: "window.SCI_RUVELON_CONFIG = {};" }));
    await page.goto("http://127.0.0.1:8796", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Mode apercu local" }).click();
    const nav = page.locator('[data-route="comptes-rendus"]');
    await nav.click();
    await page.getByRole("button", { name: "Ajouter un compte rendu" }).click();
    await page.getByLabel("Titre", { exact: true }).fill("Réunion de travail");
    await page.getByLabel("Date de réunion").fill("2026-11-07");
    const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
    await page.getByLabel("Document PDF").setInputFiles({ name: "reunion.pdf", mimeType: "application/pdf", buffer: pdf });
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await page.locator(".report-row").click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Télécharger le PDF" }).click();
    const result = await download;
    assert.equal(result.suggestedFilename(), "reunion.pdf");
    assert.deepEqual(await fs.readFile(await result.path()), pdf);
    for (const note of ["Complément : intervention à planifier.", "Point à confirmer : <img src=x onerror=alert(1)>"]) {
      await page.getByRole("button", { name: "Ajouter une annotation" }).click();
      await page.getByLabel("Annotation", { exact: true }).fill(note);
      await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
      await page.getByText(note, { exact: true }).waitFor();
    }
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Mode apercu local" }).click();
    await nav.click();
    assert.match(await page.locator(".report-row").innerText(), /2 annotations/);
    await page.locator(".report-row").click();
    assert.equal(await page.locator(".report-note").count(), 2);
    assert.equal(await page.locator(".report-note img").count(), 0);
    const records = await page.evaluate(() => JSON.parse(localStorage.getItem("ruvelon_v3_documents")));
    const report = records.find(r => r.categorie === "compte_rendu");
    assert.equal(report.url, "data:application/pdf;base64," + pdf.toString("base64"));
    assert.equal(records.filter(r => JSON.parse(r.observations).report_id === report.id).length, 2);
    assert.equal(await page.locator("#screen").evaluate(e => e.scrollWidth > e.clientWidth + 1), false);
    await page.screenshot({ path: path.join(os.tmpdir(), `ruvelon-comptes-rendus-${viewport.width}.png`) });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

(async () => {
  const server = spawn(process.execPath, ["dev-server.js"], { env: { ...process.env, PORT: "8796" } });
  try {
    await new Promise((resolve, reject) => { server.stdout.once("data", resolve); server.once("error", reject); });
    await run({ width: 1440, height: 900 });
    await run({ width: 390, height: 844 });
    console.log("OK - ajout, PDF identique, annotations separees, persistance et affichage desktop/mobile");
  } finally { server.kill(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
