"""Mätinstrumentet är fryst. Dessa tester är låset.

Harnessen ändrades fem gånger under utvecklingen och orsakade till slut själv
5 av 13 missar — 14,3 procentenheter som tillskrevs motorn men var mätfel. Ett
instrument som rör sig mellan körningarna gör att inga två siffror är jämförbara.

Efter rättelsen 2026-08-17 är söknyckelregeln fryst och testad här. **Varje
framtida ändring av harnessen ska rapporteras som MÄTRÄTTELSE med omkörning av
alla lägen — aldrig som en förbättring.** Se README.

Testerna låser de beslut som visat sig kunna gå fel, inte implementationen: vad
söknyckeln BLIR för varje typ av specpost.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evaluate_examples import HARNESS_VERSION, core_name, search_key


# --------------------------------------------------------------------------
# core_name: typord stryks — men aldrig så att nyckeln förstörs
# --------------------------------------------------------------------------
@pytest.mark.parametrize("model,expected", [
    ("Söderhamn bäddsoffa", "Söderhamn"),
    ("Valen 224 Rak soffa", "Valen 224"),
    ("Capella X / Capella Classic", "Capella X"),
    ("Clara Rak bäddsoffa", "Clara"),
    ("PINNTORP", "PINNTORP"),
    ("Ektorp", "Ektorp"),
])
def test_core_name_strips_type_words(model, expected):
    assert core_name(model) == expected


@pytest.mark.parametrize("model", [
    "soffa med puff",     # allt utom "med" är typord -> ströps till "med puff"
    "säng 303",           # kvar blev "303", noll träffar
    "soffa",              # enda ordet är ett typord
    "matgrupp",
    "fåtölj",
])
def test_core_name_never_destroys_the_key(model):
    """Strykningen ångras när inget bokstavsord utanför utfyllnaden återstår.

    Det här är den rättade buggen. "soffa med puff" blev "med puff", och `puff`
    är ett fotpallsord — sökningen letade fotpallar där facit gällde en soffa,
    och missen (−68 %) tillskrevs motorn.
    """
    assert core_name(model) == model


def test_core_name_keeps_model_numbers_with_their_noun():
    """Ett rent siffertal är ingen söknyckel.

    "säng 303" -> "303" gav noll träffar och därmed inget svar alls. Ett
    modellnummer behöver sitt substantiv för att kunna matcha.
    """
    assert core_name("säng 303") == "säng 303"
    assert core_name("Valen 224 Rak soffa") == "Valen 224"   # har bokstavsord


# --------------------------------------------------------------------------
# search_key: märkeslösa poster skickar HELA etiketten
# --------------------------------------------------------------------------
def test_brandless_item_sends_the_whole_label():
    """Kategorin ensam kastar bort orden som bär värdet.

    "Ekbord med stolar" och "Matbord trä" fick tidigare IDENTISK förfrågan
    (`matbord`) och identiskt svar, trots att facit skiljer sig 2 000-5 000 mot
    3 000-7 000.
    """
    assert search_key({"label": "Ekbord med stolar", "brand": None,
                       "model": None, "category": "matbord"}) == "Ekbord stolar"
    assert search_key({"label": "Matbord trä", "brand": None, "model": None,
                       "category": "matbord"}) == "Matbord trä"


def test_brandless_labels_are_not_identical_to_each_other():
    """Två olika möbler får aldrig samma söknyckel."""
    items = [{"label": "Ekbord med stolar", "brand": None, "model": None,
              "category": "matbord"},
             {"label": "Matbord trä", "brand": None, "model": None,
              "category": "matbord"}]
    keys = [search_key(i) for i in items]
    assert len(set(keys)) == 2, keys


def test_filler_words_are_dropped_from_the_label():
    """`find_listings` kräver att ALLA ord träffar; "med" smalnar utan att
    identifiera."""
    assert "med" not in search_key(
        {"label": "Ekbord med stolar", "brand": None, "model": None}).lower().split()


def test_brand_name_in_label_survives():
    """"byCrea" är det enda som identifierar möbeln — det får inte tappas."""
    key = search_key({"label": "Matgrupp byCrea", "brand": None, "model": None,
                      "category": "matgrupp"})
    assert "byCrea" in key


def test_model_without_brand_is_sent_verbatim():
    """Utan märke finns inget typord att kapa mot — modellen går in som den är."""
    assert search_key({"model": "Bellus soffa", "brand": None}) == "Bellus soffa"


def test_empty_model_field_does_not_crash():
    """Tomt modellfält får falla tillbaka, inte kasta."""
    assert search_key({"model": None, "brand": None, "label": None,
                       "category": "soffa"}) == "soffa"
    assert search_key({}) == ""


# --------------------------------------------------------------------------
# Specarna och deras overrides
# --------------------------------------------------------------------------
def test_facit_overrides_are_applied():
    """PINNTORP ska vara delad i två fall med olika facit."""
    from extract_benchmark_specs import FACIT_OVERRIDES, apply_overrides

    original = [{"nr": 10, "brand": "IKEA", "model": "PINNTORP",
                 "variant": "Bord och 4 stolar", "category": "Matgrupp",
                 "facit_low": 600, "facit_high": 800}]
    result = apply_overrides("11", original)
    assert len(result) == 2
    assert [i["nr"] for i in result] == [10, 12]
    assert [(i["facit_low"], i["facit_high"]) for i in result] == [
        (300, 800), (1500, 2500)]
    assert result[1]["disputed"] is True
    assert ("11", 10) in FACIT_OVERRIDES


def test_all_35_items_have_a_nonempty_search_key():
    """Ingen möbel får gå in i benchmarken med en tom söknyckel."""
    total = 0
    for tag in ("11", "b1", "b2"):
        path = Path(f"benchmark/items_{tag}.json")
        if not path.is_file():
            pytest.skip("specarna saknas — kör extract_benchmark_specs.py")
        for item in json.loads(path.read_text()):
            total += 1
            key = search_key(item)
            assert key and key.strip(), f"{tag}#{item['nr']}"
    assert total == 35


def test_harness_version_is_recorded():
    """Versionen måste finnas och vara läsbar — den skrivs till resultatfilen.

    Utan den går det inte att i efterhand veta vilket instrument en siffra kom
    ur, och det var precis det problemet som gjorde fem tidigare körningar
    ojämförbara.
    """
    assert isinstance(HARNESS_VERSION, int)
    assert HARNESS_VERSION >= 6
