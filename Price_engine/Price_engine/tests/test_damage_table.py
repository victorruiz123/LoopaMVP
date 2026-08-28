"""Validering av den levererade skadetabellen.

Testerna prövar inte om avdragen är RÄTT — det kan bara marknadsdata avgöra, och
tabellen är märkt `KALLSTART` just därför. De prövar att varje rad är **nåbar**
och att tabellen och motorn talar samma språk.

Bakgrunden: två rader levererades med `furniture_type: "skinn"`. Det är ett
material, inte en möbeltyp, och motorn skickar aldrig det värdet — raderna kunde
aldrig lösa ut. En sådan rad ser ut att göra något men gör inget, vilket är
värre än att den saknas.
"""

from __future__ import annotations

import json

import pytest

from price_engine import config, damage_pricing as dp

#: Möbeltyper motorn kan skicka. Uppmätt ur korpusens `derived_type` och
#: `variant` 2026-08-20 — det är de enda värden som kan nå ett tabelluppslag.
ENGINE_TYPES = frozenset({
    "baddsoffa", "bord", "byra", "byrå", "bäddsoffa", "del/tillbehör", "fatolj",
    "forvaring", "fotpall", "fåtölj", "hornsoffa", "hylla", "hörnsoffa",
    "matbord", "matgrupp", "okänd", "sang", "sanggavel", "sidobord", "skank",
    "skrivbord", "soffa", "soffbord", "spegel", "stol", "säng", "sänggavel",
    "vitrin",
})


@pytest.fixture(scope="module")
def table():
    return json.loads(config.DAMAGE_TABLE_PATH.read_text())


#: Tom sedan 2026-08-20. De två `flack/skinn`-raderna togs bort ur tabellen —
#: `furniture_type` är en möbeltyp, inte ett material, så de kunde aldrig lösa
#: ut. Skillnaden var två procentenheter, och läderspecifika skador täcks av de
#: egna kategorierna `repa_skinn` och `skinnflagning`.
#:
#: Listan hålls TOM med avsikt: en undantagslista som innehåller något är en
#: lista som slutar läsas. Dyker en ny onåbar rad upp ska testet faila, inte
#: växa.
KNOWN_INERT: frozenset = frozenset()


def test_every_row_is_reachable(table):
    """En rad vars furniture_type motorn aldrig skickar är död kod.

    `*` är alltid nåbar. Allt annat måste finnas i motorns taxonomi.
    """
    dead = {f"{r['category']}/{r['furniture_type']}/grad {r['grade']}"
            for r in table["rows"]
            if r["furniture_type"] != "*"
            and r["furniture_type"] not in ENGINE_TYPES}
    new_dead = dead - KNOWN_INERT
    assert not new_dead, (
        "Dessa rader kan aldrig lösa ut — furniture_type är inte en möbeltyp "
        f"motorn känner: {sorted(new_dead)}. Är det ett MATERIAL krävs en egen "
        "uppslagsdimension; se SKADEAVDRAG_RAPPORT.md."
    )
    assert dead == KNOWN_INERT, (
        f"KNOWN_INERT är inaktuell. Faktiskt onåbara: {sorted(dead)}"
    )


def test_no_material_rows_remain():
    """`furniture_type` får bara innehålla möbeltyper, aldrig material.

    De två `flack/skinn`-raderna togs bort 2026-08-20. Testet fångar om någon
    lägger tillbaka ett material i typkolumnen — den vore inert och skulle se
    ut att göra något utan att göra det.
    """
    table = json.loads(config.DAMAGE_TABLE_PATH.read_text())
    materials = {"skinn", "lader", "läder", "tyg", "tra", "trä", "metall",
                 "sammet", "plast", "glas", "marmor"}
    bad = [f"{r['category']}/{r['furniture_type']}"
           for r in table["rows"] if r["furniture_type"] in materials]
    assert not bad, (
        f"Material i furniture_type: {bad}. Kolumnen är för möbeltyper; ett "
        "material kräver en egen uppslagsdimension.")


def test_leather_stain_uses_the_generic_row():
    """En lädersoffa med fläck får den generiska raden — det är avsikten."""
    hit = dp.lookup("flack", "soffa", 2)
    assert hit["deduction"] == 0.22
    assert hit["furniture_type"] == "*"


def test_lookup_returns_the_declared_deduction(table):
    """Varje rad ska gå att slå upp och ge sitt eget avdrag."""
    for row in table["rows"]:
        if row["grade"] < config.MATERIALITY_MIN_GRADE:
            continue                      # fångas av väsentlighetströskeln
        hit = dp.lookup(row["category"], row["furniture_type"], row["grade"])
        assert hit is not None, f"{row['category']}/{row['grade']} nås inte"
        assert hit["deduction"] == row["deduction"]


def test_no_row_exceeds_the_total_cap(table):
    """Ett enskilt avdrag över totaltaket vore internt motsägelsefullt."""
    for row in table["rows"]:
        if row.get("deduction") is not None:
            assert row["deduction"] <= config.MAX_TOTAL_DEDUCTION, row["category"]


def test_confidence_intervals_bracket_the_estimate(table):
    for row in table["rows"]:
        low, high, point = row.get("ci_low"), row.get("ci_high"), row.get("deduction")
        if None in (low, high, point):
            continue
        assert low <= point <= high, f"{row['category']}/{row['grade']}"


def test_grades_rise_with_severity(table):
    """Grad 2 ska aldrig kosta mindre än grad 1 för samma kategori och typ."""
    by_key = {}
    for row in table["rows"]:
        if row.get("deduction") is None:
            continue
        by_key.setdefault((row["category"], row["furniture_type"]), {})[
            row["grade"]] = row["deduction"]
    for key, grades in by_key.items():
        if 1 in grades and 2 in grades:
            assert grades[2] >= grades[1], key
        if 0 in grades and 1 in grades:
            assert grades[1] >= grades[0], key


def test_every_row_category_is_declared(table):
    """Varje rad ska höra till en kategori i `categories` — annars saknar den
    etikett och beskrivning i svaret."""
    declared = set(table.get("categories", {}))
    used = {r["category"] for r in table["rows"]}
    assert used <= declared, f"odeklarerade: {sorted(used - declared)}"


def test_declared_categories_all_have_rows(table):
    """Motsatt håll: en kategori utan rader kan aldrig värderas.

    Den hamnar i prompten, modellen väljer den, och uppslaget missar — vilket
    skickar skadan till kostnadsuppskattningen i onödan.
    """
    declared = set(table.get("categories", {}))
    used = {r["category"] for r in table["rows"]}
    assert declared <= used, f"utan rader: {sorted(declared - used)}"


def test_functional_damage_costs_more_than_cosmetic(table):
    """Tabellens egen regel: funktionella skador väger tyngre vid samma grad.

    Testet låser regeln mot tabellens innehåll, så att en framtida redigering
    som bryter mot den egna principen upptäcks.
    """
    kinds = {k: v["kind"] for k, v in table["categories"].items()}
    heavy, light = [], []
    for row in table["rows"]:
        if row["grade"] == 2 and row.get("deduction"):
            # Hygien tillkom i 0.2 och väger som funktionell: mögel och lukt
            # ändrar vad möbeln KAN användas till, inte bara hur den ser ut.
            bucket = (light if kinds[row["category"]] == "kosmetisk" else heavy)
            bucket.append(row["deduction"])
    assert heavy and light
    assert sum(heavy) / len(heavy) > sum(light) / len(light)


def test_rules_block_is_documentation_only(table):
    """Motorn läser konstanterna ur config.py, aldrig ur tabellen.

    Blocket `rules` dokumenterar vad tabellen ANTAR. Divergerar de är config.py
    sanningen. Blocket synkades 2026-08-20 så att dokumentationen inte ljuger —
    testet håller den synkad framåt.
    """
    rules = table["rules"]
    assert rules["max_unmapped_deduction"] == config.MAX_UNMAPPED_DEDUCTION
    assert rules["max_total_deduction"] == config.MAX_TOTAL_DEDUCTION
    assert rules["repair_hassle_factor"] == config.REPAIR_HASSLE_FACTOR
    assert rules["count_escalation_at"] == config.COUNT_ESCALATION_AT
    assert rules["stacking"].startswith("none")
