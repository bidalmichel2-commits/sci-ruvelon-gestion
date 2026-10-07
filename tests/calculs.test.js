const assert = require("node:assert/strict");

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function money(value) {
  return Math.max(0, round2(value));
}

function loyerMensuel({ loyerHt, tvaPct, charges, totalPaye }) {
  const tva = money(loyerHt * tvaPct / 100);
  const loyerTtc = money(loyerHt + tva);
  const totalAttendu = money(loyerTtc + charges);
  const paye = Math.min(money(totalPaye), totalAttendu);
  return {
    tva,
    loyerTtc,
    totalAttendu,
    totalPaye: paye,
    solde: money(totalAttendu - paye)
  };
}

function remunerationGerant({ encaissementsHt, km, baremeKm, primeEdl, primeResponsabilite, autresFrais, autresFraisInclus }) {
  const remunerationBrute = money(encaissementsHt * 0.07);
  const remunerationNette = money(encaissementsHt * 0.07 * 0.70);
  const fraisKm = money(km * baremeKm);
  return {
    remunerationBrute,
    remunerationNette,
    fraisKm,
    totalCompteCourant: money(
      encaissementsHt * 0.07 * 0.70 +
      km * baremeKm +
      money(primeEdl) +
      money(primeResponsabilite) +
      (autresFraisInclus ? money(autresFrais) : 0)
    )
  };
}

function niveauAlerteBail(jours) {
  if (jours < 0) return "expired";
  if (jours <= 92) return "three";
  if (jours <= 183) return "six";
  return null;
}

function bailActifDansMois({ dateDebut, dateFin, mois }) {
  const [annee, numeroMois] = mois.split("-").map(Number);
  const premierJour = `${mois}-01`;
  const dernierJour = new Date(Date.UTC(annee, numeroMois, 0)).toISOString().slice(0, 10);
  return dateDebut <= dernierJour && (!dateFin || dateFin >= premierJour);
}

function remunerationDetail({ encaissements, interventions, primes, primeResponsabilite = 0, autresFraisInclus = false }) {
  const encaissementsHt = money(encaissements.reduce((total, row) => total + money(row.encaissementHt), 0));
  const heures = money(interventions.reduce((total, row) => total + money(row.heures), 0));
  const km = money(interventions.reduce((total, row) => total + money(row.km), 0));
  const autresFrais = money(interventions.reduce((total, row) => total + money(row.autresFrais), 0));
  const primeEdl = money(primes.reduce((total, row) => total + money(row.prime), 0));
  return {
    encaissementsHt,
    heures,
    km,
    autresFrais,
    primeEdl,
    total: money(encaissementsHt * 0.07 * 0.70 + km * 0.636 + primeEdl + primeResponsabilite + (autresFraisInclus ? autresFrais : 0))
  };
}

const loyer = loyerMensuel({
  loyerHt: 1000,
  tvaPct: 20,
  charges: 150,
  totalPaye: 2000
});

assert.deepEqual(loyer, {
  tva: 200,
  loyerTtc: 1200,
  totalAttendu: 1350,
  totalPaye: 1350,
  solde: 0
});

const remuneration2026 = remunerationGerant({
  encaissementsHt: 10000,
  km: 100,
  baremeKm: 0.636,
  primeEdl: 400,
  primeResponsabilite: 50,
  autresFrais: 25,
  autresFraisInclus: false
});

assert.deepEqual(remuneration2026, {
  remunerationBrute: 700,
  remunerationNette: 490,
  fraisKm: 63.6,
  totalCompteCourant: 1003.6
});

const remunerationAvecAutresFrais = remunerationGerant({
  encaissementsHt: 10000,
  km: 100,
  baremeKm: 0.636,
  primeEdl: 400,
  primeResponsabilite: 50,
  autresFrais: 25,
  autresFraisInclus: true
});

assert.equal(remunerationAvecAutresFrais.totalCompteCourant, 1028.6);

assert.equal(niveauAlerteBail(-1), "expired");
assert.equal(niveauAlerteBail(92), "three");
assert.equal(niveauAlerteBail(93), "six");
assert.equal(niveauAlerteBail(183), "six");
assert.equal(niveauAlerteBail(184), null);

assert.equal(bailActifDansMois({ dateDebut: "2026-10-27", dateFin: "2027-11-12", mois: "2026-10" }), true);
assert.equal(bailActifDansMois({ dateDebut: "2026-11-01", dateFin: "2027-11-12", mois: "2026-10" }), false);
assert.equal(bailActifDansMois({ dateDebut: "2026-09-01", dateFin: "2026-09-30", mois: "2026-10" }), false);

const detailMai = remunerationDetail({
  encaissements: [{ encaissementHt: 5278.01 }],
  interventions: [
    { heures: 30, km: 58, autresFrais: 87.76 },
    { heures: 3, km: 36, autresFrais: 0 }
  ],
  primes: [{ prime: 366.67 }, { prime: 133.33 }],
  autresFraisInclus: false
});

assert.deepEqual(detailMai, {
  encaissementsHt: 5278.01,
  heures: 33,
  km: 94,
  autresFrais: 87.76,
  primeEdl: 500,
  total: 818.41
});

console.log("OK - calculs loyers, remuneration et alertes baux");
