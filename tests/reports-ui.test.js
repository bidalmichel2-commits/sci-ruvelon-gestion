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
    assert.equal(await page.evaluate(id => JSON.parse(localStorage.getItem("ruvelon_v3_contributions")).filter(r=>r.report_id===id).length,report.id),2);
    assert.equal(await page.locator("#screen").evaluate(e => e.scrollWidth > e.clientWidth + 1), false);
    await page.screenshot({ path: path.join(os.tmpdir(), `ruvelon-comptes-rendus-${viewport.width}.png`) });
    await page.evaluate(url => {
      const baux = JSON.parse(localStorage.getItem("ruvelon_v3_baux"));
      const docs = JSON.parse(localStorage.getItem("ruvelon_v3_documents"));
      const id = "12345678-1234-4321-8123-123456789abc";
      baux[0].document_url = "document:" + id;
      docs.push({id, bail_id:baux[0].id, categorie:"bail_pdf", nom_fichier:"bail-test.pdf", url});
      localStorage.setItem("ruvelon_v3_baux", JSON.stringify(baux));
      localStorage.setItem("ruvelon_v3_documents", JSON.stringify(docs));
    },report.url);
    await page.reload({ waitUntil:"networkidle" });
    await page.getByRole("button", {name:"Mode apercu local"}).click();
    await page.locator('[data-route="baux"]').click();
    const leaseDownload = page.waitForEvent("download");
    await page.getByRole("button", {name:"Télécharger le bail"}).click();
    const lease = await leaseDownload;
    assert.equal(lease.suggestedFilename(), "bail-test.pdf");
    assert.deepEqual(await fs.readFile(await lease.path()), pdf);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

async function runReader() {
  const browser = await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844},serviceWorkers:"block"});
    const email = "matthieu.lonchamp@gmail.com";
    const report = {id:"report",nom_fichier:"reunion.pdf",categorie:"compte_rendu",observations:JSON.stringify({title:"Réunion",date:"2026-11-07"})};
    const inserts = [];
    await page.exposeFunction("recordContribution", payload => { inserts.push(payload); });
    await page.route("**/config.js", route=>route.fulfill({contentType:"text/javascript",body:`window.SCI_RUVELON_CONFIG={supabaseUrl:"https://example.test",supabaseAnonKey:"test",readonlyEmail:${JSON.stringify(email)}};`}));
    await page.route("**/supabase-js@2",route=>route.fulfill({contentType:"text/javascript",body:`
      const rows = [];
      const email = ${JSON.stringify(email)};
      window.supabase={createClient:()=>({
        auth:{getSession:async()=>({data:{session:{user:{email}}}})},
        from(table){
          const result = ()=>({data:table==="documents"?[${JSON.stringify(report)}]:table==="contributions"?rows:[]});
          const q={select:()=>q,eq:()=>q,in:()=>q,order:()=>q,
            maybeSingle:async()=>({data:{email,nom:"Matthieu Lonchamp",role:"lecture",actif:true}}),
            then:(resolve,reject)=>Promise.resolve(result()).then(resolve,reject),
            insert:async payload=>{
              if(table!=="contributions") throw Error("Écriture inattendue");
              await window.recordContribution(payload);
              rows.push({...payload,author_email:email,created_at:"2026-11-12T12:00:00Z"});
              return {};
            }};
          return q;
        }
      })};`}));
    await page.goto("http://127.0.0.1:8796",{waitUntil:"networkidle"});
    await page.locator('[data-route="travaux"]').click();
    assert.equal(await page.getByRole("button",{name:"Ajouter",exact:true}).count(),0);
    await page.evaluate(()=>App.openTravaux());
    assert.equal(await page.locator("#modal").isVisible(),false);
    await page.locator('[data-route="comptes-rendus"]').click();
    assert.equal(await page.getByRole("button",{name:"Ajouter un compte rendu"}).count(),0);
    await page.locator(".report-row").click();
    await page.getByRole("button",{name:"Ajouter une annotation"}).click();
    await page.getByLabel("Annotation",{exact:true}).fill("Annotation de test");
    await page.getByRole("button",{name:"Enregistrer",exact:true}).click();
    await page.getByText("Annotation de test",{exact:true}).waitFor();
    await page.locator('[data-route="notes"]').click();
    await page.getByRole("button",{name:"Déposer une note"}).click();
    await page.getByLabel("Titre",{exact:true}).fill("Note test");
    await page.getByLabel("Note",{exact:true}).fill("Point à suivre.");
    await page.getByRole("button",{name:"Enregistrer",exact:true}).click();
    await page.getByText("Point à suivre.",{exact:true}).waitFor();
    assert.match(await page.locator(".report-note").innerText(),/Matthieu Lonchamp/);
    assert.doesNotMatch(await page.locator("#screen").innerText(),/Annotation de test/);
    assert.deepEqual(inserts,[{report_id:"report",title:"",body:"Annotation de test"},{report_id:null,title:"Note test",body:"Point à suivre."}]);
    assert.equal(await page.locator("#screen").evaluate(e=>e.scrollWidth>e.clientWidth+1),false);
  } finally { await browser.close(); }
}

(async () => {
  const server = spawn(process.execPath, ["dev-server.js"], { env: { ...process.env, PORT: "8796" } });
  try {
    await new Promise((resolve, reject) => { server.stdout.once("data", resolve); server.once("error", reject); });
    await run({ width: 1440, height: 900 });
    await run({ width: 390, height: 844 });
    await runReader();
    console.log("OK - PDF comptes rendus et baux, annotations, persistance desktop/mobile");
  } finally { server.kill(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
