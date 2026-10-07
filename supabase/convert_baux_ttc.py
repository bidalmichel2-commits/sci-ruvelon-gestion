"""Convertit les baux en TVA 20% en conservant les totaux TTC du pointage."""
import argparse
import json
import tempfile
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

import import_baux as api


def amount(value):
    return Decimal(str(value or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def split(total, charges):
    ttc = amount(total) - amount(charges)
    if ttc < 0:
        raise ValueError("Charges superieures au total TTC")
    ht = (ttc / Decimal("1.20")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return float(ht), float(ttc - ht), float(ttc)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--month", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    token = api.request("/auth/v1/token?grant_type=password", method="POST", body={
        "email": api.ADMIN_EMAIL, "password": api.ADMIN_PASSWORD,
    })["access_token"]
    baux = api.request("/rest/v1/baux?select=*&statut=eq.Actif", token=token) or []
    rents = api.request(f"/rest/v1/loyers_mensuels?select=*&mois=eq.{args.month}-01", token=token) or []
    by_bail = {row["bail_id"]: row for row in rents if row.get("bail_id")}
    changes = []
    for bail in baux:
        rent = by_bail.get(bail["id"])
        charges = amount(rent["charges_mensuelles"] if rent else bail["charges_mensuelles"])
        total = amount(rent["total_attendu"]) if rent else amount(
            amount(bail["loyer_ht"]) * (1 + Decimal(str(bail["tva"])) / 100)
        ) + charges
        ht, vat, ttc = split(total, charges)
        changes.append(("baux", bail["id"], {"loyer_ht": ht, "tva": 20, "charges_mensuelles": float(charges)}))
        if rent:
            changes.append(("loyers_mensuels", rent["id"], {
                "loyer_ht": ht, "tva": vat, "loyer_ttc": ttc,
            }))
    backup = None
    if args.apply:
        backup = Path(tempfile.gettempdir()) / ("sci_ruvelon_avant_tva_" + datetime.now().strftime("%Y%m%d_%H%M%S") + ".json")
        backup.write_text(json.dumps({"baux": baux, "loyers_mensuels": rents}, ensure_ascii=False, indent=2), encoding="utf-8")
        for table, identifier, payload in changes:
            api.request(f"/rest/v1/{table}?id=eq.{identifier}", method="PATCH", body=payload, token=token, prefer="return=minimal")
        verified = api.request(f"/rest/v1/loyers_mensuels?select=*&mois=eq.{args.month}-01", token=token) or []
        original = {row["id"]: row for row in rents}
        assert len(verified) == len(rents)
        for row in verified:
            old = original[row["id"]]
            assert row["total_attendu"] == old["total_attendu"]
            assert row["total_paye"] == old["total_paye"]
            if row.get("bail_id") in by_bail:
                assert amount(row["loyer_ht"]) + amount(row["tva"]) + amount(row["charges_mensuelles"]) == amount(row["total_attendu"])
    print(json.dumps({"applique": args.apply, "baux": len(baux), "ventilations_pointage": sum(table == "loyers_mensuels" for table, _, _ in changes), "total_ttc_conserve": float(sum(amount(row["total_attendu"]) for row in rents)), "sauvegarde": str(backup) if backup else None}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
