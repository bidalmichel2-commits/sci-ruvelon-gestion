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
  await page.getByRole("button", { name: "Plus" }).click();

  const qr = page.locator(".install-qr");
  await qr.waitFor();
  assert.equal(await qr.evaluate((image) => image.complete && image.naturalWidth > 0), true, "Le QR code ne se charge pas");
  assert.equal(await page.locator(".install-link").getAttribute("href"), "http://127.0.0.1:8790/");

  const overflow = await page.locator(".install-panel").evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  assert.equal(overflow, false, `Le panneau d'installation deborde en ${viewport.width}px`);
  await browser.close();
}

(async () => {
  await run({ width: 1440, height: 900 });
  await run({ width: 390, height: 844 });
  console.log("OK - QR installation desktop et mobile");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
