import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

import openpyxl


SUPABASE_URL = os.environ.get("SCI_SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SCI_SUPABASE_KEY", "")
ADMIN_EMAIL = os.environ.get("SCI_ADMIN_EMAIL", "")
ADMIN_PASSWORD = os.environ.get("SCI_ADMIN_PASSWORD", "")
IMPORT_MARKER = "[IMPORT_LISTE_LOCATION_2026]"


def request(path, method="GET", body=None, token=None, prefer=None):
    headers = {"apikey": SUPABASE_KEY, "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if prefer:
        headers["Prefer"] = prefer
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(SUPABASE_URL + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            return json.loads(raw.decode("utf-8")) if raw else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase {exc.code}: {detail}") from exc


def text(value):
    return "" if value is None else str(value).strip()


def number(value):
    try:
        return round(float(value or 0), 2)
    except (TypeError, ValueError):
        return 0


def normalize(value):
    value = unicodedata.normalize("NFKD", text(value)).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", value).strip().lower()


def iso_date(value):
    if isinstance(value, (datetime, date)):
        return value.strftime("%Y-%m-%d")
    raw = text(value)
    if not raw:
        return ""
    for fmt in ("%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    raise ValueError(f"Date non reconnue: {raw}")


def add_years(value, years):
    current = datetime.strptime(value, "%Y-%m-%d").date()
    try:
        return current.replace(year=current.year + years).isoformat()
    except ValueError:
        return current.replace(month=2, day=28, year=current.year + years).isoformat()


def canonical_local_code(code):
    value = text(code).upper()
    if value in {"RC1", "RC2"}:
        return "RC1+RC2"
    if value in {"SS1", "SS2"}:
        return "SS1+SS2"
    return value


def split_codes(value):
    result = []
    for part in text(value).split("+"):
        code = canonical_local_code(part)
        if code and code not in result:
            result.append(code)
    return result


def tenant_key(label):
    return normalize(label)


def database_tenant_key(row):
    label = row.get("raison_sociale") or " ".join(
        part for part in [row.get("nom"), row.get("prenom")] if part
    )
    return normalize(label)


def current_dates(label, start, end, duration_years):
    normalized = normalize(label)
    if "word soccer" in normalized:
        return "2026-05-30", "2027-05-29"

    if start and end and end < start and duration_years:
        end = add_years(start, duration_years)
        end_date = datetime.strptime(end, "%Y-%m-%d").date()
        end = (end_date - timedelta(days=1)).isoformat()

    automatic = any(name in normalized for name in (
        "oryx", "sabatino", "rognon", "leroy", "bouzouren", "relacom"
    ))
    if automatic and end and duration_years:
        while end < date.today().isoformat():
            end = add_years(end, duration_years)
    return start, end


def main(workbook_path):
    if not all([SUPABASE_URL, SUPABASE_KEY, ADMIN_EMAIL, ADMIN_PASSWORD]):
        raise RuntimeError("Configuration Supabase incomplete.")

    auth = request(
        "/auth/v1/token?grant_type=password",
        method="POST",
        body={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
    )
    token = auth["access_token"]

    locals_rows = request(
        "/rest/v1/locaux?select=id,code_local,actif&order=created_at", token=token
    ) or []
    local_by_code = {
        text(row.get("code_local")).upper(): row
        for row in locals_rows
        if row.get("actif") is not False
    }

    tenants_rows = request(
        "/rest/v1/locataires?select=id,nom,prenom,raison_sociale,email&order=created_at",
        token=token,
    ) or []
    tenant_by_key = {database_tenant_key(row): row for row in tenants_rows}

    existing = request(
        "/rest/v1/baux?select=id,local_id,locataire_id,date_debut,observations", token=token
    ) or []
    existing_exact = {
        (row.get("locataire_id"), row.get("local_id"), row.get("date_debut")): row
        for row in existing
    }
    existing_imported = {
        (row.get("locataire_id"), row.get("local_id")): row
        for row in existing
        if IMPORT_MARKER in text(row.get("observations"))
    }

    workbook = openpyxl.load_workbook(workbook_path, data_only=True, read_only=True)
    sheet = workbook["3. Locataires"]
    created = 0
    updated = 0
    skipped = 0
    missing = []

    for row in sheet.iter_rows(min_row=2, values_only=True):
        label = text(row[0])
        if not label or label.upper() == "TOTAL" or normalize(row[2]) != "actif":
            continue

        label_without_activity = re.sub(r"\s*\([^)]*\)\s*$", "", label)
        tenant = tenant_by_key.get(tenant_key(label)) or tenant_by_key.get(tenant_key(label_without_activity))
        if not tenant:
            missing.append(f"Locataire introuvable: {label}")
            continue

        codes = split_codes(row[1])
        local_records = [local_by_code.get(code) for code in codes]
        if not codes or any(item is None for item in local_records):
            absent = [code for code, item in zip(codes, local_records) if item is None]
            missing.append(f"Local introuvable pour {label}: {', '.join(absent)}")
            continue

        start = iso_date(row[3])
        end = iso_date(row[5])
        duration_years = max(1, int(number(row[4]) or 1))
        source_start, source_end = start, end
        start, end = current_dates(label, start, end, duration_years)
        # La colonne source contient le loyer TTC hors charges.
        rent = round(number(row[8]) / 1.20, 2)
        charges = number(row[7])
        deposit = number(row[9])
        normalized = normalize(label)
        automatic = any(name in normalized for name in (
            "oryx", "sabatino", "rognon", "leroy", "bouzouren", "relacom"
        ))

        for index, local in enumerate(local_records):
            secondary = index > 0
            marker = "[LOCAL_SECONDAIRE]" if secondary else "[BAIL_PRINCIPAL]"
            notes = [
                IMPORT_MARKER,
                marker,
                "Locaux contractuels: " + " + ".join(codes),
                f"Dates source: {source_start or '-'} au {source_end or '-'}",
            ]
            if secondary:
                notes.append("Loyer et charges portes sur le bail principal pour eviter un double comptage")
            if text(row[13]):
                notes.append(text(row[13]))

            payload = {
                "local_id": local["id"],
                "locataire_id": tenant["id"],
                "type_bail": "Commercial",
                "date_debut": start,
                "date_fin": end or None,
                "duree_mois": duration_years * 12,
                "loyer_ht": 0 if secondary else rent,
                "tva": 20,
                "charges_mensuelles": 0 if secondary else charges,
                "depot_garantie": 0 if secondary else deposit,
                "renouvellement_auto": automatic,
                "statut": "Actif",
                "observations": ". ".join(notes) + ".",
            }

            exact_key = (tenant["id"], local["id"], start)
            imported_key = (tenant["id"], local["id"])
            previous = existing_exact.get(exact_key) or existing_imported.get(imported_key)
            if previous and IMPORT_MARKER in text(previous.get("observations")):
                encoded_id = urllib.parse.quote(previous["id"], safe="")
                request(
                    f"/rest/v1/baux?id=eq.{encoded_id}",
                    method="PATCH",
                    body=payload,
                    token=token,
                    prefer="return=minimal",
                )
                updated += 1
            elif previous:
                skipped += 1
            else:
                request(
                    "/rest/v1/baux",
                    method="POST",
                    body=payload,
                    token=token,
                    prefer="return=minimal",
                )
                created += 1

    final_rows = request(
        "/rest/v1/baux?select=id,statut,renouvellement_auto,observations", token=token
    ) or []
    print(json.dumps({
        "baux_crees": created,
        "baux_actualises": updated,
        "baux_existants_conserves": skipped,
        "baux_total": len(final_rows),
        "baux_importes": sum(IMPORT_MARKER in text(row.get("observations")) for row in final_rows),
        "renouvellements_automatiques": sum(bool(row.get("renouvellement_auto")) for row in final_rows),
        "anomalies": missing,
    }, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: import_baux.py <classeur.xlsx>")
    main(sys.argv[1])
