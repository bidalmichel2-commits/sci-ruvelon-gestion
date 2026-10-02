const assert = require("node:assert/strict");
const { chromium } = require("playwright");

async function run(viewport) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined
  });
  const page = await browser.newPage({ viewport });
  await page.route("**/config.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: "window.SCI_RUVELON_CONFIG = {};"
  }));
  await page.goto(process.argv[2] || "http://127.0.0.1:8790", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Mode apercu local" }).click();
  await page.getByRole("button", { name: /Rémunération/ }).click();
  await page.getByRole("button", { name: "Saisir un mois" }).click();

  await page.locator('[data-detail-kind="encaissements"] [data-field="encaissement_ht"]').first().fill("1000");
  await page.locator('[data-detail-kind="interventions"] [data-field="heures"]').first().fill("2");
  await page.locator('[data-detail-kind="interventions"] [data-field="km"]').first().fill("10");
  await page.locator('[data-detail-kind="interventions"] [data-field="autres_frais"]').first().fill("25");
  await page.locator('[data-detail-kind="primes"] [data-field="loyer_reference"]').first().fill("400");

  assert.equal(await page.locator('[data-recap="encaissements"]').innerText(), "1000.00 EUR");
  assert.equal(await page.locator('[data-recap="nette"]').innerText(), "49.00 EUR");
  assert.equal(await page.locator('[data-recap="frais_km"]').innerText(), "6.36 EUR");
  assert.equal(await page.locator('[data-recap="primes"]').innerText(), "400.00 EUR");
  assert.equal(await page.locator('[data-recap="autres"]').innerText(), "25.00 EUR");
  assert.equal(await page.locator('[data-recap="total"]').innerText(), "455.36 EUR");

  const overflow = await page.locator("#modal-body").evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  assert.equal(overflow, false, `Le formulaire deborde horizontalement en ${viewport.width}px`);
  await browser.close();
}

(async () => {
  await run({ width: 1440, height: 900 });
  await run({ width: 390, height: 844 });
  console.log("OK - formulaire remuneration desktop et mobile");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
