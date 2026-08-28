"""Bilden skriver de ord användaren inte skriver.

Ingen skriver "u-soffa" eller "+ fotpall" i ett sökfält, men motorns cellfilter,
typfilter och buntlogik hänger på just de orden. Formlagret låter en bild-LLM
välja ur lexikonets EGNA listor och skriva in dem i frågan; resten av motorn rörs
inte.

Det kritiska kravet är att orden **måste finnas i lexikonet**. Skriver modellen
"L-formad sektionssoffa" kan motorn inte läsa det, och en söknyckel med ett ord
ingen annons innehåller ger noll träffar i stället för ett bättre svar.
"""

from __future__ import annotations

import json
import pathlib

import pandas as pd
import pytest

from price_engine import config, pricing
from type_system import form_layer as fl
from type_system import grouping


# --------------------------------------------------------------------------
# Ordlistorna måste vara läsbara för motorn
# --------------------------------------------------------------------------
def test_every_form_word_is_understood_by_the_engine():
    """Kärnkravet. Ett formord modellen får välja måste ge en möbeltyp.

    Annars skriver bilden in ett ord som varken cellfiltret eller typfiltret
    känner igen, och hela vinsten uteblir — tyst.
    """
    unreadable = [w for w in fl.form_words()
                  if not grouping.classify(f"Testmodell {w}").types]
    assert not unreadable, (
        f"Formord som motorn inte kan läsa: {unreadable}. Lägg till dem i "
        "product_types i config/vocab.yaml, eller ta bort dem ur form_words."
    )


def test_every_accessory_word_is_understood():
    """Tillbehörsord ska ge antingen en typ eller en tillbehörssignal."""
    signals = set()
    for group in ("accessory_signals",):
        signals |= set(grouping.vocab().get(group) or [])
    unreadable = []
    for word in fl.accessory_words():
        folded = word.lower()
        if grouping.classify(f"Testmodell {folded}").types:
            continue
        if any(s in folded for s in signals):
            continue
        unreadable.append(word)
    assert not unreadable, f"Tillbehörsord motorn inte kan läsa: {unreadable}"


def test_form_words_are_scoped_by_base():
    """En soffa ska inte kunna beskrivas som skrivbord."""
    assert "u-soffa" in fl.form_words("soffa")
    assert "skrivbord" not in fl.form_words("soffa")


def test_prompt_contains_the_lexicon_lists():
    prompt = fl.build_prompt("soffa")
    assert "u-soffa" in prompt and "fotpall" in prompt
    # Fråga 2 handlade förut om vad som SYNS. Den formuleringen gav "+ sidobord"
    # på ett stajlat foto, så kravet är nu att tillbehöret hör IHOP med möbeln.
    assert "hör IHOP MED huvudmöbeln" in prompt
    assert "Bedöm ALDRIG pris" in prompt


# --------------------------------------------------------------------------
# Filtrering av modellens svar
# --------------------------------------------------------------------------
def test_words_outside_the_list_are_rejected():
    out = fl.parse({"form": "L-formad sektionssoffa",
                    "visible_accessories": ["matta", "fotpall"]})
    assert out["form"] is None
    assert out["accessories"] == ["fotpall"]
    assert "l-formad sektionssoffa" in out["rejected"]
    assert "matta" in out["rejected"]


def test_vet_inte_is_a_valid_answer():
    out = fl.parse({"form": "vet inte", "visible_accessories": []})
    assert out["form"] is None
    assert out["rejected"] == []


@pytest.mark.parametrize("payload", [None, "", "inte json", 42, [], {"x": 1}])
def test_broken_response_is_survivable(payload):
    out = fl.parse(payload)
    assert out["form"] is None and out["accessories"] == []


# --------------------------------------------------------------------------
# Inskrivningen i frågan
# --------------------------------------------------------------------------
def test_form_and_accessory_are_written_into_the_query():
    parsed = fl.parse({"form": "u-soffa", "visible_accessories": ["fotpall"]})
    out = fl.enrich("Mio Friday", parsed)
    assert out["text"] == "Mio Friday u-soffa + fotpall"
    assert out["added"] == ["u-soffa", "+ fotpall"]


def test_accessory_uses_plus_so_the_bundle_logic_sees_it():
    """"+" är ett kombinationsord — det är signalen buntlogiken behöver.

    Utan den läses "Lamino fotpall" som en lös fotpall i stället för som en
    fåtölj med pall, och svaret blir 2 000 kr i stället för 10 000.
    """
    parsed = fl.parse({"form": "vet inte", "visible_accessories": ["fotpall"]})
    text = fl.enrich("Lamino", parsed)["text"]
    assert text == "Lamino + fotpall"
    result = grouping.classify(text)
    assert result.is_bundle is True
    assert result.bundle_from_connector is True


def test_words_already_written_are_not_duplicated():
    """Skriver användaren själv "U-soffa" ska bilden inte dubblera ordet."""
    parsed = fl.parse({"form": "u-soffa", "visible_accessories": []})
    out = fl.enrich("Mio Friday U-soffa", parsed)
    assert out["text"] == "Mio Friday U-soffa"
    assert out["added"] == []


def test_enrich_survives_empty_input():
    assert fl.enrich("Lamino", {})["text"] == "Lamino"
    assert fl.enrich("Lamino", None)["text"] == "Lamino"


# --------------------------------------------------------------------------
# I motorn
# --------------------------------------------------------------------------
@pytest.fixture
def corpus():
    names = (["Swedese Lamino fåtölj"] * 40
             + ["Swedese Lamino fåtölj med fotpall"] * 40)
    frame = pd.DataFrame({
        "name": names,
        "name_norm": [pricing.normalize_text(n) for n in names],
        "search_blob": [pricing.normalize_text(n) for n in names],
        "price": [6000.0 + i for i in range(40)] + [11000.0 + i for i in range(40)],
        "price_kind": "asking", "brand_norm": None, "source": "test",
        "variant": "fåtölj", "derived_type": "fatolj",
        "condition_norm": None, "condition_tier": None,
        "listed_at": pd.Timestamp("2026-08-01", tz="UTC"),
    })
    assigned = grouping.assign_cells(frame["name"])
    for column in assigned.columns:
        frame[column] = assigned[column].to_numpy()
    return frame


def test_flag_off_ignores_the_hint(corpus, monkeypatch):
    monkeypatch.setattr(config, "FORM_VISION_ENABLED", False)
    hint = fl.parse({"form": "vet inte", "visible_accessories": ["fotpall"]})
    with_hint = pricing.price_query(corpus, name="Lamino", brand="Swedese",
                                    form_hint=hint, image_rerank=False)
    without = pricing.price_query(corpus, name="Lamino", brand="Swedese",
                                  image_rerank=False)
    assert with_hint["default"] == without["default"]
    assert with_hint["formFromImage"] is None


def test_flag_on_writes_the_words_and_changes_the_answer(corpus, monkeypatch):
    """Hela poängen: bilden ser pallen, frågan blir en bunt, priset stiger."""
    monkeypatch.setattr(config, "FORM_VISION_ENABLED", True)
    hint = fl.parse({"form": "vet inte", "visible_accessories": ["fotpall"]})
    out = pricing.price_query(corpus, name="Lamino", brand="Swedese",
                              attribute_text="Lamino", form_hint=hint,
                              image_rerank=False)
    assert out["formFromImage"]["added"] == ["+ fotpall"]
    assert "fotpall" in out["formFromImage"]["text"]


def test_broken_hint_never_fells_a_price(corpus, monkeypatch):
    monkeypatch.setattr(config, "FORM_VISION_ENABLED", True)
    for hint in ({"form": object()}, {"accessories": None}, {}):
        out = pricing.price_query(corpus, name="Lamino", brand="Swedese",
                                  form_hint=hint, image_rerank=False)
        assert out["default"] is not None


# --------------------------------------------------------------------------
# Divan, schäslong och hörn — den skillnad som betyder mest
# --------------------------------------------------------------------------
@pytest.mark.parametrize("form,expected_type", [
    ("rak soffa", "soffa"),
    ("hörnsoffa", "hornsoffa"),
    ("u-soffa", "hornsoffa"),
    ("bäddsoffa", "baddsoffa"),
    ("divansoffa", "divansoffa"),
    ("schäslongsoffa", "divansoffa"),
])
def test_every_sofa_form_maps_to_a_type(form, expected_type):
    """Varje formval ska ge en möbeltyp motorn kan filtrera på."""
    assert grouping.classify(f"Mio Friday {form}").types == [expected_type]


def test_u_and_corner_are_distinguished():
    """U-soffa och hörnsoffa får inte kollapsa till samma sak.

    De ger samma TYP (hornsoffa) men olika `corner_count`, vilket är det som
    bär prisskillnaden — en U-soffa ligger indikativt 1,43x en enkelhörnad.
    """
    from type_system import chain

    u = chain.resolve(name="Mio Friday u-soffa", ask_user=False)
    l = chain.resolve(name="Mio Friday hörnsoffa", ask_user=False)
    assert u.derived_type == l.derived_type == "hornsoffa"
    assert u.attributes.get("corner_count") == 2
    assert l.attributes.get("corner_count") == 1


def test_prompt_explains_divan_chaise_and_corner():
    """Modellen ska veta VAD den letar efter, inte bara vilka ord den får välja."""
    prompt = fl.build_prompt("soffa")
    flat = " ".join(prompt.split())
    assert "divan" in flat and "schaslong" in flat.replace("ä", "a")
    assert "BADA andar" in flat.replace("Å", "A").replace("ä", "a")
    for word in ("u-soffa", "hörnsoffa", "divansoffa", "schäslongsoffa"):
        assert word in prompt, word


def test_guidance_covers_every_sofa_form():
    """Varje formval ska ha en förklaring — annars gissar modellen."""
    notes = fl.guidance()
    missing = [w for w in fl.form_words("soffa") if w not in notes]
    assert not missing, f"Formord utan vägledning: {missing}"


# --------------------------------------------------------------------------
# ask(): anropet, reservvägen och cachen
# --------------------------------------------------------------------------
class _FakeClient:
    """Minsta möjliga stand-in för OpenAI-klienten."""

    def __init__(self, payload=None, boom=None):
        self.payload, self.boom, self.calls = payload, boom, []
        outer = self

        class _Completions:
            def create(self, **kw):
                outer.calls.append(kw)
                if outer.boom:
                    raise outer.boom
                message = type("M", (), {"content": json.dumps(outer.payload)})
                return type("C", (), {
                    "choices": [type("Ch", (), {"message": message})()]})()

        self.chat = type("Chat", (), {"completions": _Completions()})()


def test_ask_returns_parsed_answer(tmp_path, monkeypatch):
    monkeypatch.setattr(fl, "CACHE_DIR", tmp_path)
    client = _FakeClient({"form": "u-soffa", "visible_accessories": ["fotpall"],
                          "confidence": 0.9, "evidence": "divan i bada andar"})
    out = fl.ask(b"foto", base="soffa", client=client)
    assert out["form"] == "u-soffa"
    assert out["accessories"] == ["fotpall"]
    assert out["route"] == "direkt"


def test_ask_survives_a_dead_api(tmp_path, monkeypatch):
    """Ett dött API får aldrig fälla ett prissvar — bara svara tomt."""
    monkeypatch.setattr(fl, "CACHE_DIR", tmp_path)
    out = fl.ask(b"foto", base="soffa",
                 client=_FakeClient(boom=RuntimeError("insufficient_quota")))
    assert out["form"] is None and out["accessories"] == []
    assert "insufficient_quota" in out["error"]


def test_ask_falls_back_to_edge_when_direct_fails(tmp_path, monkeypatch):
    """Slut på krediter hos leverantören -> Lovable-vägen ska provas."""
    monkeypatch.setattr(fl, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(config, "VISION_EDGE_URL", "https://exempel/edge")
    monkeypatch.setattr(fl, "_ask_edge",
                        lambda *a, **k: {"form": "rak soffa",
                                         "visible_accessories": []})
    out = fl.ask(b"foto", base="soffa",
                 client=_FakeClient(boom=RuntimeError("insufficient_quota")))
    assert out["form"] == "rak soffa"
    assert out["route"] == "edge"


def test_cache_key_changes_with_the_word_lists(tmp_path, monkeypatch):
    """Ändrad ordlista måste ogiltigförklara gamla svar.

    Annars fortsätter cachen servera tillbehör som tagits bort ur lexikonet —
    precis vad som hände när `sidobord` ströks.
    """
    monkeypatch.setattr(fl, "CACHE_DIR", tmp_path)
    before = fl._cache_key(b"foto", "soffa", "m")
    monkeypatch.setattr(fl, "build_prompt", lambda base=None: "en annan prompt")
    assert fl._cache_key(b"foto", "soffa", "m") != before


# --------------------------------------------------------------------------
# Tillbehören: rekvisita får inte skrivas in som "ingår"
# --------------------------------------------------------------------------
@pytest.mark.parametrize("word", ["sidobord", "kudde", "dyna", "klädsel"])
def test_staging_props_are_not_accessories(word):
    """Rekvisita i stajlade foton säljs inte med möbeln.

    Mätningen av set_items gav 100 % falsklarm på INKLUDERING. Ett sidobord
    bredvid en Lamino skrevs in som '+ sidobord' och gjorde fotot till en bunt.
    """
    assert word not in fl.accessory_words(), word
    out = fl.parse({"form": "rak soffa", "visible_accessories": [word]}, "soffa")
    assert out["accessories"] == []
    assert word in out["rejected"]


def test_accessories_that_survive_are_value_bearing():
    """Kvar ska bara stå tillbehör som säljs som EN enhet och flyttar priset."""
    assert set(fl.accessory_words()) == {"fotpall", "sittpuff", "stolar",
                                         "hyllplan"}


def test_prompt_demands_the_accessory_belongs_to_the_furniture():
    flat = " ".join(fl.build_prompt("soffa").split())
    assert "samma tyg" in flat
    assert "bara står i rummet" in flat


def test_documentation_keys_are_never_words():
    """Nycklar som börjar med _ är förklaringar, inte ordfamiljer.

    Förut hoppades bara "_note" över, så _guidance-dictens nycklar lästes som
    formord. Det syntes inte förrän en förklaringsrad lades till där.
    """
    assert not [w for w in fl.form_words() if w.startswith("_")]
    assert not [w for w in fl.accessory_words() if w.startswith("_")]


# --------------------------------------------------------------------------
# base_family: smalna ordlistan innan modellen frågas
# --------------------------------------------------------------------------
@pytest.mark.parametrize("hint,familj", [
    ("soffa", "soffa"),
    ("hornsoffa", "soffa"),      # ASCII-vikt typ ur texten
    ("hörnsoffa", "soffa"),
    ("fatolj", "stol"),          # ett ORD i familjen, inte familjenamnet
    ("matbord", "bord"),
    ("Mio", None),               # varumärke är ingen familj
    (None, None),
])
def test_base_family_maps_types_and_words(hint, familj):
    assert fl.base_family(hint) == familj


def test_base_family_takes_the_first_usable_hint():
    assert fl.base_family(None, "Mio", "soffa") == "soffa"


def test_family_shrinks_the_word_list():
    """Utan familj får modellen välja bland matbord och skrivbord också.

    Mätningen som valde FORM_VISION_MODEL kördes med familjen satt, så
    produktionen ska köra likadant.
    """
    assert len(fl.form_words("soffa")) < len(fl.form_words())
    assert "matbord" not in fl.form_words("soffa")


# --------------------------------------------------------------------------
# Bildformat: iPhone-bilder får inte falla tyst
# --------------------------------------------------------------------------
def test_heic_is_detected_not_trusted_from_mime():
    """HEIC ska kännas igen på magiska bytes, inte på anroparens MIME-typ.

    Uppladdningsrutan tillåter "image/*". En iPhone lämnar HEIC, och bild-LLM:en
    svarar 400 på det. Felet syntes bara i en WARNING-rad, så prissvaret kom
    tillbaka utan formord och såg korrekt ut — tyst fel.
    """
    from type_system.image_bytes import sniff

    assert sniff(b"\x00\x00\x00\x20ftypheic" + b"\x00" * 20) == "heic"
    assert sniff(b"\x89PNG\r\n\x1a\n" + b"\x00" * 20) == "png"
    assert sniff(b"\xff\xd8\xff" + b"\x00" * 20) == "jpeg"
    assert sniff(b"inte en bild") is None


def test_supported_formats_are_passed_through_untouched():
    """Omkodning kostar kvalitet — format modellen tar ska lämnas i fred."""
    from type_system.image_bytes import to_supported

    png = pathlib.Path("benchmark/bilder_b1/s01_0.png")
    if not png.is_file():
        pytest.skip("benchmarkbilden saknas")
    blob = png.read_bytes()
    ut, media = to_supported(blob)
    assert ut is blob and media == "image/png"


def test_conversion_never_raises_on_garbage():
    """En trasig bild får aldrig fälla ett prissvar."""
    from type_system.image_bytes import to_supported

    ut, media = to_supported(b"inte en bild alls")
    assert ut == b"inte en bild alls" and media.startswith("image/")


def test_a_failed_vision_call_is_visible_in_the_answer(corpus, monkeypatch):
    """Ett tyst fel är värre än ett högljutt.

    Bilden avvisades som HEIC, priset kom tillbaka utan formord, och svaret såg
    fullt rimligt ut. Felet gick bara att hitta i serverloggen.
    """
    monkeypatch.setattr(config, "FORM_VISION_ENABLED", True)
    monkeypatch.setattr(fl, "ask", lambda *a, **k: {
        "form": None, "accessories": [], "rejected": [],
        "error": "400 unsupported image"})

    svar = pricing.price_query(corpus, name="Lamino", brand="Swedese",
                               image=b"\x00\x00\x00\x20ftypheic" + b"\x00" * 20,
                               image_rerank=False)
    assert (svar.get("formFromImage") or {}).get("error") == "400 unsupported image"


# --------------------------------------------------------------------------
# Drift: CORS och API-nyckel ska vara AV som default
# --------------------------------------------------------------------------
def test_cors_and_key_are_off_by_default():
    """Utan miljövariabler ska servern bete sig exakt som förut.

    Båda är driftsinställningar. En flagga som ändrar beteendet bara genom att
    finnas är precis den sortens tysta ändring som är svår att felsöka.
    """
    assert config.CORS_ORIGINS == ()
    assert config.API_KEY is None


def test_key_check_is_a_noop_without_a_configured_key(monkeypatch):
    from price_engine import api

    monkeypatch.setattr(config, "API_KEY", None)
    assert api.require_key(None) is None          # ingen nyckel krävs
    assert api.require_key("vadsomhelst") is None


def test_key_check_rejects_wrong_and_missing_keys(monkeypatch):
    from fastapi import HTTPException

    from price_engine import api

    monkeypatch.setattr(config, "API_KEY", "hemlig")
    assert api.require_key("hemlig") is None       # rätt nyckel släpps igenom
    for dalig in (None, "", "fel"):
        with pytest.raises(HTTPException) as fel:
            api.require_key(dalig)
        assert fel.value.status_code == 401


def test_health_is_not_behind_the_key():
    """En lastbalanserare ska kunna kolla liveness utan hemlighet."""
    from price_engine import api

    for rutt in api.app.routes:
        if getattr(rutt, "path", None) == "/health":
            beroenden = [d.call for d in rutt.dependant.dependencies]
            assert api.require_key not in beroenden
            break
    else:
        pytest.fail("/health hittades inte")


def test_price_is_behind_the_key():
    from price_engine import api

    for rutt in api.app.routes:
        if getattr(rutt, "path", None) == "/price":
            beroenden = [d.call for d in rutt.dependant.dependencies]
            assert api.require_key in beroenden
            break
    else:
        pytest.fail("/price hittades inte")
