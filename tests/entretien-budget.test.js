const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const context = {window:{}};
vm.createContext(context);
vm.runInContext(source.slice(0, source.lastIndexOf("  initInstall();")) +
  "window.test = entretienForecast; })();",context);
const forecast = context.window.test([
  {titre:"Chaudière", montant_estime:148.33, detail:{entretien_frequence:"Annuel",date_document:"2026-11-10"}},
  {titre:"Relevage", montant_estime:512.99, detail:{entretien_frequence:"Annuel",budget_indique:650}},
  {titre:"Ménage", detail:{budget_indique:600}},
  {titre:"Ancienne estimation ménage", montant_estime:2400, detail:{annee:2026,entretien_exclure_budget:true}},
  {titre:"Tonte facturée", montant_estime:1700, montant_reel:1829, detail:{date_document:"2026-06-02",entretien_frequence:"Ponctuel",annee:2026}},
  {titre:"Incendie 2025", montant_reel:120, detail:{date_document:"2025-03-31"}},
  {titre:"Autre entretien", montant_estime:40, detail:{annee:2027}},
  {titre:"Reporté", montant_estime:800, statut:"X - Reporté", detail:{annee:2027}},
  {titre:"Contrat partiellement facturé", montant_estime:200, montant_reel:80, detail:{entretien_frequence:"Annuel",date_document:"2026-11-01"}},
  {titre:"Contrat futur", montant_estime:90, date_prevue:"2028-01-01", detail:{entretien_frequence:"Annuel"}}
],2026);
const plain = JSON.parse(JSON.stringify(forecast));
assert.deepEqual(plain.years.map(r=>[r.year,r.total,r.billed,r.unconfirmed]),[
  [2025,120,120,0], [2026,2177.33,1909,650], [2027,388.33,0,650], [2028,438.33,0,650]
]);
assert.deepEqual(plain.unplanned,[{title:"Ménage",amount:600,basis:"HT/TTC à préciser"}]);
console.log("OK - prévision par année, réel sans double compte, budgets hors total");
