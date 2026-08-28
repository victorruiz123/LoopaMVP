"""API-kontraktet: prismotorn tar emot skador, den detekterar dem inte.

Ett separat system ser skadorna och levererar en färdig lista. Motorn tolkar
och värderar den. Matchningen sker i två steg, och ordningen är hela poängen:

    1. DETERMINISTISKT   beskrivning mot kategoriernas synonymer. Gratis,
                         konsekvent, samma svar varje gång.
    2. MODELLANROP       endast för det steg 1 inte klarade.

En modell som anropas för varje skada är både dyrare och mindre förutsägbar än
en ordlista. Steg 2 finns för svansen, inte för normalfallet.
"""

from __future__ import annotations

import json

import pytest

from price_engine import config, damage_pricing as dp


@pytest.fixture(autouse=True)
def real_table(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "UNMAPPED_DAMAGE_LOG", tmp_path / "log.jsonl")


# --------------------------------------------------------------------------
# Steg 1: deterministisk matchning
# --------------------------------------------------------------------------
@pytest.mark.parametrize("description,expected", [
    ("fläck på sittdynan", "flack"),
    ("stor reva i tyget", "reva_hal"),
    ("soffan är vinglig", "stomskada"),
    ("luktar rök", "lukt"),
    ("hyllplan saknas", "saknad_del"),
    ("mögel under dynan", "mogel"),
    ("solblekt på ena sidan", "missfargning"),
    ("dynan är nedsutten", "nedsutten"),
    ("vattenskada på foten", "vattenskada"),
    ("flagande skinn", "skinnflagning"),
])
def test_descriptions_match_deterministically(description, expected):
    assert dp.match_category(description) == expected


def test_longest_match_wins():
    """"repa i skinnet" är en skinnrepa, inte en lackrepa.

    Utan längsta-match-först matchar `repa` inuti `repa i skinn` och skadan
    hamnar i fel kategori — samma regel som möbeltypslexikonet använder.
    """
    assert dp.match_category("repa i skinnet") == "repa_skinn"
    assert dp.match_category("repa i lacken") == "repa_hard"


@pytest.mark.parametrize("description,expected", [
    ("skinnet flagnar", "skinnflagning"),
    ("flagnat skinn", "skinnflagning"),
    ("sprucken yta", "skinnflagning"),
    ("nedsuttna", "nedsutten"),
    ("nedsuttna dynor", "nedsutten"),
    ("sviktande dynor", "nedsutten"),
    ("en skruv saknas", "saknad_del"),
    ("saknar dyna", "saknad_del"),
    ("delar saknas", "saknad_del"),
])
def test_inflected_forms_match(description, expected):
    """Böjningsluckan stängdes 2026-08-20 — i TABELLEN, inte i koden.

    Matchningen klarar ordföljd och delsträng men inte stamning: `flagnar` mot
    `flagande`, `nedsuttna` mot `nedsutten`, `skruv` mot `skruvar`. Botemedlet
    var att lägga till formerna som synonymer, vilket inte kräver kodändring.

    Det är den avsedda vägen att utöka täckningen. Stamning hade varit en större
    ändring med egna felkällor, och den hade gällt alla kategorier på en gång.
    """
    assert dp.match_category(description) == expected


def test_new_synonyms_do_not_collide():
    """`sprucken yta` (skinnflagning) får inte kapa `sprucken stomme`."""
    assert dp.match_category("sprucken stomme") == "stomskada"
    assert dp.match_category("sprucket läder") == "skinnflagning"


def test_word_order_does_not_matter():
    """Flerordssynonymer matchar oavsett ordföljd."""
    assert (dp.match_category("hyllplan saknas")
            == dp.match_category("saknas hyllplan") == "saknad_del")


def test_substring_still_beats_word_set_when_needed():
    """"repa i skinnet" mot tabellens "repa i skinn".

    Ordmängdsmatchning ensam missade det — `skinnet` är inte samma ORD som
    `skinn` — och då vann `repa_hard` på sitt enordiga "repa". Båda
    matchningssätten behövs.
    """
    assert dp.match_category("repa i skinnet") == "repa_skinn"


def test_unknown_description_returns_none():
    """Bara det som INTE matchar går vidare till modellen."""
    assert dp.match_category("spjälkat fanér på hörnet") is None
    assert dp.match_category("") is None
    assert dp.match_category(None) is None


def test_matching_is_case_and_diacritic_insensitive():
    for text in ("FLÄCK", "flack", "Fläck på dynan", "FLACK"):
        assert dp.match_category(text) == "flack"


def test_table_synonyms_win_over_builtin(tmp_path, monkeypatch):
    """Synonymlistan ska gå att utöka utan kodändring."""
    path = tmp_path / "t.json"
    path.write_text(json.dumps({
        "categories": {"flack": {"synonyms": ["kladd", "sudd"]}},
        "rows": [{"category": "flack", "furniture_type": "*", "grade": 1,
                  "deduction": 0.10, "source": "measured", "n_groups": 40}],
    }))
    monkeypatch.setattr(config, "DAMAGE_TABLE_PATH", path)
    assert dp.match_category("kladd på dynan") == "flack"


# --------------------------------------------------------------------------
# Severity: används, bedöms aldrig om
# --------------------------------------------------------------------------
@pytest.mark.parametrize("severity,grade", [
    (0, 0), (1, 1), (2, 2), ("0", 0), ("2", 2),
    ("knappt synlig", 0), ("liten", 0), ("minor", 0),
    ("synlig", 1), ("måttlig", 1), ("moderate", 1),
    ("framträdande", 2), ("kraftig", 2), ("severe", 2), ("omfattande", 2),
])
def test_severity_maps_to_grade(severity, grade):
    assert dp.severity_to_grade(severity) == grade


def test_unreadable_severity_is_none():
    for value in (None, "nonsens", True, [], {}):
        assert dp.severity_to_grade(value) is None


def test_severity_is_used_not_rejudged():
    """Följer severity med ska den ANVÄNDAS.

    Skadesystemet har sett skadan; att bedöma om den vore att kasta bort
    information och riskera att två system säger olika saker om samma foto.
    """
    items = dp.normalise([{"description": "fläck", "severity": "knappt synlig"}])
    assert items[0]["grade"] == 0
    assert items[0]["gradeAssumed"] is False


def test_missing_severity_assumes_middle_and_flags():
    items = dp.normalise([{"description": "fläck"}])
    assert items[0]["grade"] == dp.DEFAULT_GRADE == 1
    assert items[0]["gradeAssumed"] is True


# --------------------------------------------------------------------------
# Normalisering av API-formatet
# --------------------------------------------------------------------------
def test_api_shape_is_accepted():
    items = dp.normalise([
        {"description": "fläck på sittdynan", "severity": "synlig",
         "location": "sittyta", "image": "<base64>"},
        {"description": "spjälkat fanér", "severity": 2},
    ])
    assert items[0]["category"] == "flack"
    assert items[0]["grade"] == 1
    assert items[0]["location"] == "sittyta"
    assert items[0]["matchedBy"] == "synonym"
    assert items[1]["category"] is None
    assert items[1]["matchedBy"] is None


def test_garbage_input_is_survivable():
    assert dp.normalise(None) == []
    assert dp.normalise([]) == []
    assert dp.normalise(["sträng", 42, None]) == []
    assert dp.normalise([{}])[0]["category"] is None


def test_needs_model_selects_only_the_unmatched():
    items = dp.normalise([{"description": "fläck"},
                          {"description": "spjälkat fanér"},
                          {"description": "luktar rök"}])
    unmatched = dp.needs_model(items)
    assert len(unmatched) == 1
    assert unmatched[0]["description"] == "spjälkat fanér"


# --------------------------------------------------------------------------
# Steg 2: modellanropet mappar och kostnadsuppskattar — aldrig detekterar
# --------------------------------------------------------------------------
def test_mapping_prompt_does_not_ask_for_detection():
    prompt = dp.build_mapping_prompt("spjälkat fanér", "byra")
    assert "spjälkat fanér" in prompt
    flat = " ".join(prompt.split())          # radbrytningar bort
    assert "uppgift är INTE att titta efter skador" in flat
    assert "Bedöm ALDRIG priset" in prompt
    assert "Bedöm inte hur allvarlig skadan är" in prompt
    # Kategorilistan ur den riktiga tabellen ska följa med.
    assert "flack" in prompt and "mogel" in prompt


def test_mapping_response_is_parsed():
    assert dp.parse_mapping('{"category": "flack"}') == {"category": "flack"}
    out = dp.parse_mapping({"category": "unmapped", "repair_cost_sek": 900,
                            "repair_action": "fanerlagning"})
    assert out["repair_cost_sek"] == 900


@pytest.mark.parametrize("payload", [None, "", "inte json", 42, [], {"x": 1}])
def test_broken_mapping_response_is_survivable(payload):
    assert isinstance(dp.parse_mapping(payload), dict)


def test_mapping_never_changes_the_grade():
    """Modellen mappar kategori och kostnad. Graden är skadesystemets.

    Att låta den justera graden vore att återinföra bedömningen vi tog bort.
    """
    item = dp.normalise([{"description": "spjälkat fanér", "severity": 2}])[0]
    merged = dp.apply_mapping(item, {"category": "stomskada", "grade": 0})
    assert merged["grade"] == 2
    assert merged["category"] == "stomskada"
    assert merged["matchedBy"] == "model"


def test_model_unmapped_keeps_cost_for_valuation():
    item = dp.normalise([{"description": "spjälkat fanér", "severity": 2}])[0]
    merged = dp.apply_mapping(item, {"category": "unmapped",
                                     "repair_cost_sek": 900,
                                     "repair_action": "fanerlagning"})
    assert merged["category"] is None
    assert merged["matchedBy"] == "model_unmapped"
    out = dp.resolve([merged], "byra", 10000)
    assert out["items"][0]["source"] == "estimated_repair"
    assert out["items"][0]["deduction"] == pytest.approx(0.18, abs=1e-3)


# --------------------------------------------------------------------------
# Ingen detekteringslogik kvar
# --------------------------------------------------------------------------
def test_detection_prompt_is_gone():
    """Den gamla detekteringsprompten och dess parser ska vara borta."""
    assert not hasattr(dp, "PROMPT")
    assert not hasattr(dp, "build_prompt")
    assert not hasattr(dp, "parse_response")
    assert not hasattr(dp, "LOCATIONS")


def test_normalise_is_idempotent():
    """En post som redan mappats i steg 2 får inte normaliseras om.

    Annars tappas kategorin och kostnaden modellen tillförde, och skadan blir
    ovärderad — vilket är precis vad som hände när price_query normaliserade om
    en redan berikad post.
    """
    item = dp.normalise([{"description": "spjälkat fanér", "severity": 2}])[0]
    merged = dp.apply_mapping(item, {"category": "unmapped",
                                     "repair_cost_sek": 900,
                                     "repair_action": "fanerlagning"})
    again = dp.normalise([merged])[0]
    assert again["repair_cost_sek"] == 900
    assert again["matchedBy"] == "model_unmapped"
    assert again["grade"] == 2


def test_normalise_twice_is_stable():
    once = dp.normalise([{"description": "fläck", "severity": 1}])
    twice = dp.normalise(once)
    assert once == twice
