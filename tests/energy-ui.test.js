const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

async function run(viewport) {
  const browser = await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
  try {
    const page = await browser.newPage({viewport,serviceWorkers:"block"});
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/config.js", route => route.fulfill({contentType:"text/javascript",body:"window.SCI_RUVELON_CONFIG = {};"}));
    await page.goto("http://127.0.0.1:8797", {waitUntil:"networkidle"});
    const login = () => page.getByRole("button",{name:"Mode apercu local"}).click();
    await login();
    await page.evaluate(() => {
      const values = {eau:100,edf_communs:250,compteur_2:300,compteur_1:500};
      const records = [2025,2026].map(annee=>({
        id:"energie-"+annee,categorie:"depense_energie",
        observations:JSON.stringify({annee,postes:Object.fromEntries(Object.entries(values).map(([key,amount])=>[key,annee===2025?{reel:amount}:{prevision:amount}]))})
      }));
      localStorage.setItem("ruvelon_v3_documents",JSON.stringify(records));
    });
    await page.reload({waitUntil:"networkidle"});
    await login();
    const nav = page.locator('[data-route="energie"]');
    await nav.click();
    const select = page.getByLabel("Année énergie");
    await select.selectOption("2026");
    const screen = page.locator("#screen");
    const content = async () => (await screen.innerText()).replace(/\s/g," ");
    assert.match(await content(),/Réel 2025/i);
    assert.match(await content(),/Prévision 2026/i);
    assert.match(await content(),/1 150,00 €/);
    assert.match(await content(),/Compteur 1/);
    await page.getByRole("button",{name:"Modifier 2026"}).click();
    assert.equal(await page.locator('[name="eau_prevision"]').inputValue(),"100");
    assert.equal(await page.locator('[name="eau_reel"]').inputValue(),"");
    await page.locator('[name="eau_reel"]').fill("42.50");
    await page.getByRole("button",{name:"Enregistrer",exact:true}).click();
    await page.waitForFunction(() => document.getElementById("modal").hidden);
    await page.getByRole("button",{name:"Modifier 2026"}).waitFor();
    assert.match(await content(),/42,50 €/);
    assert.match(await content(),/1 150,00 €/);
    const records = await page.evaluate(() => JSON.parse(localStorage.getItem("ruvelon_v3_documents")));
    assert.equal(records.length,2);
    assert.equal(JSON.parse(records[0].observations).postes.eau.reel,100);
    assert.equal(JSON.parse(records[1].observations).postes.eau.prevision,100);
    await page.getByRole("button",{name:"Ajouter une année"}).click();
    await page.locator('[name="annee"]').fill("2026");
    await page.getByRole("button",{name:"Enregistrer",exact:true}).click();
    await page.getByText("Cette année existe déjà. Ouvrez sa fiche pour la modifier.").waitFor();
    await page.locator('[name="annee"]').fill("2027");
    await page.locator('[name="eau_prevision"]').fill("110");
    await page.getByRole("button",{name:"Enregistrer",exact:true}).click();
    await page.getByRole("button",{name:"Modifier 2027"}).waitFor();
    assert.equal(await select.inputValue(),"2027");
    assert.match(await content(),/110,00 €/);
    await select.selectOption("2026");
    assert.equal(await screen.evaluate(e=>e.scrollWidth>e.clientWidth+1),false);
    await page.screenshot({path:path.join(os.tmpdir(),`ruvelon-energie-${viewport.width}.png`)});
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
}

(async () => {
  const server = spawn(process.execPath,["dev-server.js"],{env:{...process.env,PORT:"8797"}});
  try {
    await new Promise((resolve,reject)=>{server.stdout.once("data",resolve);server.once("error",reject);});
    await run({width:1440,height:900});
    await run({width:390,height:844});
    console.log("OK - énergie : comparaison annuelle, totaux, édition, ajout sans doublon, desktop/mobile");
  } finally { server.kill(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
