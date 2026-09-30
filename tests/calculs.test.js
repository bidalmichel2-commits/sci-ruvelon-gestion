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
      remunerationNette +
      fraisKm +
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

console.log("OK - calculs loyers, remuneration et alertes baux");
