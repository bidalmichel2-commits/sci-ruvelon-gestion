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
      records.push({id:"compteurs-test",categorie:"compteurs_energie",observations:JSON.stringify({compteurs:{compteur_2:"123456789",compteur_1:"987654321"}})});
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
    assert.match(await content(),/Prévision 2026 TTC/i);
    assert.match(await content(),/1 150,00 €/);
    assert.match(await content(),/Compteur 1/);
    assert.match(await content(),/RC4, RC5, RC6, RC7 et RC8 · Compteur n° 123456789/);
    assert.match(await content(),/E2, E3, E5, E6 et E7 · Compteur n° 987654321/);
    const listing = await content();
    assert.ok(listing.indexOf("Électricité · Compteur 1") < listing.indexOf("Électricité · Compteur 2"));
    await page.getByRole("button",{name:"Saisir le réel : Eau potable"}).click();
    assert.equal(await page.locator('[name="eau_prevision"]').inputValue(),"100");
    assert.match(await page.locator('[name="eau_prevision"]').evaluate(e=>e.closest("label").textContent),/€ TTC/);
    assert.equal(await page.locator('[name="eau_reel"]').inputValue(),"");
    assert.equal(await page.locator('[name="compteur_1_reel"]').count(),0);
    await page.locator('[name="eau_reel"]').fill("42.50");
    await page.getByRole("button",{name:"Enregistrer",exact:true}).click();
    await page.waitForFunction(() => document.getElementById("modal").hidden);
    await page.getByRole("button",{name:"Modifier 2026"}).waitFor();
    assert.match(await content(),/42,50 €/);
    assert.match(await content(),/1 150,00 €/);
    const records = await page.evaluate(() => JSON.parse(localStorage.getItem("ruvelon_v3_documents")));
    assert.equal(records.length,3);
    assert.equal(JSON.parse(records[0].observations).postes.eau.reel,100);
    assert.equal(JSON.parse(records[1].observations).postes.eau.prevision,100);
    assert.deepEqual(JSON.parse(records[1].observations).postes.compteur_1,{prevision:500});
    await page.getByRole("button",{name:"Modifier : Eau potable"}).click();
    assert.equal(await page.locator('[name="eau_reel"]').inputValue(),"42.5");
    await page.getByRole("button",{name:"Annuler",exact:true}).click();
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
    await page.getByRole("button",{name:"Ajouter une dépense"}).click();
    await page.locator('[name="annee"]').fill("2026");
    await page.locator('[name="date"]').fill("2026-10-15");
    await page.locator('[name="libelle"]').fill("Éclairage parties communes");
    await page.locator('[name="fournisseur"]').fill("Fournisseur test");
    await page.locator('[name="montant_ttc"]').fill("84.20");
    await page.getByRole("button",{name:"Enregistrer",exact:true}).click();
    await page.waitForFunction(() => document.getElementById("modal").hidden);
    const energyExpenses = page.locator(".energy-expenses");
    assert.match(await energyExpenses.innerText(),/Éclairage parties communes/);
    assert.match(await energyExpenses.innerText(),/84,20 €/);
    let expense = await page.evaluate(() => JSON.parse(localStorage.getItem("ruvelon_v3_documents")).find(r=>r.categorie==="depense_energie_ligne"));
    assert.equal(JSON.parse(expense.observations).annee,2026);
    assert.equal(JSON.parse(expense.observations).montant_ttc,84.2);
    await energyExpenses.getByRole("button",{name:"Modifier",exact:true}).click();
    await page.locator('[name="montant_ttc"]').fill("90");
    await page.getByRole("button",{name:"Enregistrer",exact:true}).click();
    await page.waitForFunction(() => document.getElementById("modal").hidden);
    assert.match(await energyExpenses.innerText(),/90,00 €/);
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
