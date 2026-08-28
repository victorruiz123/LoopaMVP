"""Tester för attributsystemet (L0-L1) och synonymexpansionen.

Fallen är valda för att låsa fast de fel som faktiskt uppstod under bygget, inte
för att bekräfta att lyckade fall lyckas. Varje test som handlar om ett verkligt
fynd bär en kommentar om vad datan sa.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import pandas as pd

from type_system import chain, decide, synonyms, vision_layer
from type_system.attributes import (SET_ITEMS_UNKNOWN, Attributes,
                                    candidate_types, derive_type)
from type_system.prior import Prior, entropy
from type_system.text_layer import extract


def typ(text: str):
    return derive_type(extract(text))


# --------------------------------------------------------------------------
# L0 — bastyp och positionsregeln
# --------------------------------------------------------------------------
@pytest.mark.parametrize("text,expected", [
    ("Kivik hörnsoffa 3-sits", "hornsoffa"),
    ("Söderhamn bäddsoffa", "baddsoffa"),
    ("Tresitssoffa i skinn", "soffa"),
    ("Bokhylla Billy", "hylla"),
    ("Vitrinskåp med glasdörrar", "vitrin"),
    ("Skänk i teak", "skank"),
    ("Lamino fåtölj", "fatolj"),   # 2,60x en stol — mätt, se steg 2
])
def test_grundfall(text, expected):
    assert typ(text) == expected


def test_positionsregeln_avgor_bastypen():
    """"Soffbord till hörnsoffa" är ett bord. Soffordet beskriver något annat."""
    attrs = extract("Soffbord till hörnsoffa")
    assert attrs.get("base") == "bord"
    assert derive_type(attrs) == "soffbord"
    # Hörnattributet får inte läcka in på ett bord.
    assert attrs.get("corner") is None


def test_soffattribut_utan_bastyp_implicerar_soffa():
    """"schäslong till Vimle" saknar möbelord men är otvetydigt en soffa."""
    attrs = extract("IKEA schäslong till Vimle")
    assert attrs.get("base") == "soffa"
    assert attrs.confidence("base") < 0.95   # slutsats, inte uttryckligt ord


# --------------------------------------------------------------------------
# Falska vänner — alla mätta i korpusen
# --------------------------------------------------------------------------
def test_bortskankes_ar_inte_en_skank():
    """`skankes` 524 och `bortskankes` 586 betyder "ges bort"."""
    attrs = extract("Bortskänkes: gammal byrå")
    assert attrs.get("storage_kind") == "byra"
    assert synonyms.canonical("bortskänkes") is None


def test_dagbadd_ar_inte_baddsoffa():
    """`dagbadd` 10 300, `baddmadrass` 8 596 — ingen av dem är en bäddsoffa."""
    attrs = extract("Dagbädd med bäddmadrass")
    assert attrs.get("convertible") is None
    assert attrs.get("base") == "sang"


def test_hornskap_ar_inte_hornsoffa():
    """`hornskap` 15 898 — "horn" implicerar inte soffa."""
    attrs = extract("Hörnskåp i furu")
    assert attrs.get("base") == "forvaring"
    assert attrs.get("corner") is None


# --------------------------------------------------------------------------
# Negationsspärren — buggen som blockerade 124 giltiga träffar
# --------------------------------------------------------------------------
@pytest.mark.parametrize("text", [
    "Säljes utan schäslongdel",
    "Passar till divan",
    "4-sitssoffa utan schäslong",
    "Kivik fåtöljer ej bäddsoffa",
])
def test_negation_blockerar(text):
    attrs = extract(text)
    assert attrs.get("chaise") is None
    assert attrs.get("convertible") is None


@pytest.mark.parametrize("text,attr", [
    ("Vejlby bäddsoffa", "convertible"),      # "ej" inne i *vejlby*
    ("Rejal skänk", "storage_kind"),          # "ej" inne i *rejal*
    ("Skejby modulsoffa med schäslong", "chaise"),
    ("Interlübke cube skänk", "storage_kind"),  # "inte" inne i *interlubke*
])
def test_negation_ar_inte_delstrangsmatchning(text, attr):
    """Enordiga negationer måste matcha ett helt token, inte en delsträng."""
    assert extract(text).get(attr) is not None


# --------------------------------------------------------------------------
# matgrupp — set_items-sentinelen
# --------------------------------------------------------------------------
@pytest.mark.parametrize("text,expected,items", [
    ("Ekbord med stolar", "matgrupp", SET_ITEMS_UNKNOWN),
    ("Matgrupp i ek", "matgrupp", SET_ITEMS_UNKNOWN),
    ("Runt matbord med 6 stolar", "matgrupp", 6),
    ("Matbord utan stolar", "matbord", None),
    ("Matbord", "matbord", None),
])
def test_matgrupp_harleds(text, expected, items):
    attrs = extract(text)
    assert derive_type(attrs) == expected
    assert attrs.get("set_items") == items


# --------------------------------------------------------------------------
# chaise är MÄTT prisirrelevant och får inte härleda hörnsoffa
# --------------------------------------------------------------------------
def test_divan_ar_prismassigt_en_soffa():
    """divan/schäslong = 0,94x rak soffa, KI [0,91, 1,00] — oskiljbara."""
    attrs = extract("Snygg divansoffa i sammet")
    assert attrs.get("chaise") is True
    assert derive_type(attrs) == "soffa"        # inte hornsoffa

    # Hörnsoffa ligger kvar i unionen, och ska göra det: `corner` är okänt, och
    # en divansoffa KAN ha ett 90-gradershörn. Det är skillnaden mellan att inte
    # härleda ett värde och att utesluta det.
    assert "hornsoffa" in candidate_types(attrs)

    # Vet vi däremot att hörnet saknas faller hörnsoffan bort.
    attrs.set("corner", False, "user", 1.0)
    assert derive_type(attrs) == "soffa"
    assert "hornsoffa" not in candidate_types(attrs)


def test_hornsoffa_ar_egen_typ():
    """hörnsoffa = 1,23x rak soffa — verklig skillnad, behålls."""
    assert derive_type(extract("Kivik hörnsoffa")) == "hornsoffa"


# --------------------------------------------------------------------------
# Okänt attribut ska ge en union, inte en gissning
# --------------------------------------------------------------------------
def test_okand_bastyp_ger_ingen_typ():
    attrs = Attributes()
    assert derive_type(attrs) is None
    assert candidate_types(attrs) == ()


def test_okant_bordattribut_ger_union():
    attrs = extract("Bord i ek")
    assert attrs.get("base") == "bord"
    assert set(candidate_types(attrs)) >= {"matbord", "matgrupp", "soffbord"}


def test_kallhierarkin_hindrar_bilden_fran_att_skriva_over_texten():
    attrs = extract("Söderhamn bäddsoffa")
    assert attrs.set("base", "bord", "image", 0.99) is False
    assert attrs.get("base") == "soffa"
    # Användaren får däremot alltid skriva över.
    assert attrs.set("base", "bord", "user", 1.0) is True


# --------------------------------------------------------------------------
# Synonymexpansion
# --------------------------------------------------------------------------
@pytest.mark.parametrize("word,expected", [
    ("schäslong", "chaise"), ("schaslang", "chaise"), ("shaslong", "chaise"),
    ("divan", "chaise"), ("hörnsoffa", "corner"), ("L-soffa", "corner"),
    ("bäddsoffa", "convertible"), ("sovsoffa", "convertible"),
    ("vitrinskåp", "vitrin"), ("bokhylla", "hylla"), ("byrå", "byra"),
])
def test_canonical(word, expected):
    assert synonyms.canonical(word) == expected


def test_fold_gor_chaise_longue_till_ett_ord():
    assert synonyms.fold("chaise longue") == synonyms.fold("chaiselongue")
    assert synonyms.fold("Chaise-Longue") == "chaiselongue"


def test_stavfelstolerans_bara_pa_svara_ord():
    """Avstånd 1 tillåts mot HARD_TO_SPELL, aldrig generellt."""
    assert synonyms.canonical("schaslng") == "chaise"
    assert synonyms.canonical("hornsofa") == "corner"
    # `bort` ligger på avstånd 1 från `bord` men får inte bli ett bord.
    assert synonyms.canonical("bort") is None
    assert synonyms.canonical("sofa") is None


def test_expansion_korsar_synonymgrupper():
    """Skriver användaren schäslong ska hörnsoffor ingå i jämförelsen."""
    terms = synonyms.expand("schäslong")
    assert "hornsoffa" in terms and "divan" in terms and "schaslong" in terms


def test_skank_expanderar_till_vitrin_men_ar_eget_varde():
    """9,4 % prisskillnad, KI [0,87, 0,95]: liten men verklig."""
    assert "vitrinskap" in synonyms.expand("skänk")
    assert synonyms.canonical("skänk") != synonyms.canonical("vitrinskåp")


# --------------------------------------------------------------------------
# L1 — priorns entropi
# --------------------------------------------------------------------------
def test_entropi_ar_noll_nar_allt_ar_samma():
    assert entropy({"stol": 100}) == 0.0


def test_entropi_ar_ett_nar_fordelningen_ar_jamn():
    assert entropy({"a": 50, "b": 50}) == pytest.approx(1.0)


def test_prior_utan_fil_ar_tom():
    prior = Prior.load("finns-inte.json")
    assert not prior.ready
    assert prior.apply("Lamino", Attributes()) is None


def test_prior_fyller_bara_tomma_attribut():
    prior = Prior({"lamino": {"n": 500, "attributes": {
        "base": {"value": "stol", "share": 0.98, "entropy": 0.05, "n": 500}}}})
    attrs = Attributes()
    assert prior.apply("Lamino fåtölj", attrs) == "lamino"
    assert attrs.get("base") == "stol"
    # Texten har redan talat -> priorn får inte ändra.
    spoken = extract("Lamino bord")
    prior.apply("Lamino bord", spoken)
    assert spoken.get("base") == "bord"


def test_prior_tiger_vid_hog_entropi():
    """Malm är säng, byrå OCH skrivbord — entropin 0,52 tystar priorn."""
    prior = Prior({"malm": {"n": 900, "attributes": {
        "base": {"value": "forvaring", "share": 0.58, "entropy": 0.52, "n": 900}}}})
    attrs = Attributes()
    prior.apply("Malm", attrs)
    assert attrs.get("base") is None


def test_prior_betingar_undertyp_pa_bastypen():
    """`Lamino` fick sub=sidobord från Lamino-BORDET i samma annons.

    Utan betingning blev en stol tilldelad ett bordsattribut. Undertyperna
    ligger därför under `by_base` och plockas bara när bastypen stämmer.
    """
    prior = Prior({"lamino": {
        "n": 2867,
        "attributes": {"base": {"value": "stol", "share": 0.88,
                                "entropy": 0.41, "n": 2867}},
        "by_base": {"bord": {"sub": {"value": "sidobord", "share": 0.89,
                                     "entropy": 0.30, "n": 400}}},
    }})
    attrs = Attributes()
    prior.apply("Lamino", attrs)
    assert attrs.get("base") == "stol"
    assert attrs.get("sub") is None       # bordsattributet får inte följa med


def test_prior_som_bildsparr():
    prior = Prior({"lamino": {"n": 500, "attributes": {
        "base": {"value": "stol", "share": 0.98, "entropy": 0.05, "n": 500}}}})
    assert prior.contradicts("Lamino", "base", "bord") is True
    assert prior.contradicts("Lamino", "base", "stol") is False


# --------------------------------------------------------------------------
# Beslutsreglerna — asymmetri, value of information, L5
# --------------------------------------------------------------------------
def _candidates(rows):
    """Minimal träffmängd: (search_blob, price)."""
    return decide.annotate(pd.DataFrame(rows, columns=["search_blob", "price"]))


def test_asymmetrin_bygger_pa_matt_prisriktning_inte_pa_booleanen():
    """Naiva regeln "kräv mer för False" är fel.

    `corner=True` gör möbeln DYRARE (hörnsoffa 1,205x) medan `convertible=True`
    gör den BILLIGARE (bäddsoffa 0,823x). Riktningen sitter i priset.
    """
    assert decide.is_downgrade("hornsoffa", "soffa") is True
    assert decide.is_downgrade("soffa", "baddsoffa") is True     # True men billigare
    assert decide.is_downgrade("soffa", "hornsoffa") is False
    assert decide.is_downgrade("matbord", "matgrupp") is True
    assert decide.is_downgrade("matgrupp", "matbord") is False


def test_nedgradering_kraver_starkare_evidens():
    attrs = extract("Kivik hörnsoffa")
    assert derive_type(attrs) == "hornsoffa"
    # Att göra den till en rak soffa är en nedgradering: 0,50 räcker inte.
    assert decide.accept(attrs, "corner", False, 0.50) is False
    assert decide.accept(attrs, "corner", False, 0.80) is True


def test_uppgradering_kraver_mindre():
    attrs = extract("soffa")
    assert decide.accept(attrs, "corner", True, 0.55) is True


def test_value_of_information_hoppar_over_billiga_fragor():
    """Skiljer typerna inte i pris är svaret inte värt ett anrop."""
    rows = [("matbord ek", 1000)] * 6 + [("matbord med 4 stolar ek", 1000)] * 6
    frame = _candidates(rows)
    attrs = extract("bord i ek")
    worth, why = decide.worth_asking(frame, attrs, "set_items")
    assert worth is False
    assert why["reason"] == "under tröskel"


def test_value_of_information_staller_fragan_nar_priset_skiljer():
    rows = [("matbord ek", 4000)] * 6 + [("matbord med 4 stolar ek", 1000)] * 6
    frame = _candidates(rows)
    attrs = extract("bord i ek")
    worth, why = decide.worth_asking(frame, attrs, "set_items")
    assert worth is True
    assert why["relative"] > decide.MIN_VALUE_OF_INFORMATION


def test_clarifying_questions_ordnas_efter_nytta():
    """Unionsupplösande frågor först, därefter efter kronpåverkan.

    Den sammansatta frågan ligger först när den slår varje enkel fråga. Den har
    ingen egen `priceImpact` — den löser flera attribut samtidigt, och att
    tillskriva den ett enda kronbelopp vore att hitta på ett tal.
    """
    rows = ([("soffa 3-sits", 5000)] * 6 + [("hornsoffa 3-sits", 12000)] * 6
            + [("baddsoffa 3-sits", 4000)] * 6)
    frame = _candidates(rows)
    attrs = extract("soffa")
    questions = decide.clarifying_questions(frame, attrs)
    assert questions
    assert all("question" in q and "priceImpact" in q for q in questions)

    assert questions[0]["composite"] is True
    assert questions[0]["spreadIfAnswered"] < questions[0]["spreadBefore"]

    simple = [q for q in questions if not q["composite"]]
    impacts = [q["priceImpact"] or 0 for q in simple]
    assert impacts == sorted(impacts, reverse=True)


def test_l5_okant_attribut_ger_bredare_pris_inte_gissning():
    rows = ([("matbord ek", 4000)] * 6 + [("matbord med 4 stolar ek", 1000)] * 6)
    frame = _candidates(rows)
    attrs = extract("bord i ek")
    spread = decide.uncertainty_spread(frame, attrs)
    assert spread is not None
    assert spread["spreadRatio"] > 1.0
    assert set(spread["possibleTypes"]) <= set(candidate_types(attrs))


def test_typkonfidens_sjunker_nar_prisviktigt_attribut_ar_okant():
    assert decide.type_confidence(extract("Kivik hörnsoffa 3-sits")) == "hög"
    assert decide.type_confidence(Attributes()) == "låg"


# --------------------------------------------------------------------------
# L3 — vision-lagret frågar rätt saker och dör tyst
# --------------------------------------------------------------------------
def test_vision_fragar_aldrig_om_baddfunktion():
    """En ihopfälld bäddsoffa ser ut som en soffa. Attributet går till L4."""
    assert "convertible" not in vision_layer.QUESTIONS
    attrs = extract("soffa")
    assert "convertible" not in vision_layer.wanted(attrs)


def test_vision_hoppar_over_prisirrelevanta_attribut():
    """`chaise` är mätt 0,955x — den ska aldrig kosta ett betalt anrop."""
    attrs = extract("soffa")
    assert "chaise" not in vision_layer.wanted(attrs)
    assert "corner" in vision_layer.wanted(attrs)


def test_vision_fragar_bara_om_ratt_bastyps_attribut():
    bord = extract("matbord")
    assert "corner" not in vision_layer.wanted(bord)
    # "byrå" duger inte som exempel: texten sätter redan storage_kind, och då
    # finns inget att fråga om. Ett skåp ger bastypen utan undertyp.
    forvaring = extract("Hörnskåp i furu")
    assert forvaring.get("base") == "forvaring"
    assert forvaring.get("storage_kind") is None
    assert "storage_kind" in vision_layer.wanted(forvaring)
    assert "seats" not in vision_layer.wanted(forvaring)


def test_vision_fragar_aldrig_om_stolarna_ingar():
    """Mätt med matchad design: 10/10 rätt på positiva, 0/7 på negativa.

    Modellen svarar korrekt på vad som SYNS — stolarna står runt bordet — men
    attributet handlar om vad som INGÅR. Alla sju negativa hade härlett
    `matgrupp` och prissatts till 0,52x. Frågan hör till L4.
    """
    assert "set_items" not in vision_layer.QUESTIONS
    assert "set_items" not in vision_layer.wanted(extract("matbord"))
    # Men användarfrågan finns kvar — det är dit attributet flyttades.
    assert "set_items" in decide.USER_QUESTIONS


def test_vision_overlever_dott_api():
    """Krediterna tog slut mitt i en utvärdering en gång. Aldrig igen."""
    class Trasig:
        class chat:
            class completions:
                @staticmethod
                def parse(**_):
                    raise RuntimeError("insufficient_quota")

    attrs = extract("soffa")
    info = vision_layer.ask([b"inte-en-bild"], attrs, client=Trasig(), use_cache=False)
    assert info["method"] == "fel"
    assert attrs.get("corner") is None      # inget skrevs
    assert derive_type(attrs) == "soffa"    # kedjan lever


def test_vision_gar_inte_se_ger_okant_inte_falskt():
    class Svarar:
        def __init__(self, value):
            self.value = value

        class chat:
            pass

    # Enklare: pröva översättningen direkt.
    assert vision_layer._translate("corner", "gar_inte_se") is None
    assert vision_layer._translate("corner", "ja") is True
    assert vision_layer._translate("corner", "nej") is False
    assert vision_layer._translate("set_items", "4") == 4
    assert vision_layer._translate("storage_kind", "glasdorrar") == "vitrin"


# --------------------------------------------------------------------------
# Kedjan
# --------------------------------------------------------------------------
def test_kedjan_utan_bild_och_utan_prior():
    result = chain.resolve(name="Söderhamn bäddsoffa", prior=Prior({}))
    assert result.derived_type == "baddsoffa"
    assert result.attributes.source("base") == "text"
    assert result.type_confidence in ("hög", "medel")


def test_kedjan_returnerar_union_nar_typen_ar_okand():
    result = chain.resolve(name="Bord i ek", prior=Prior({}))
    assert set(result.possible_types) >= {"matbord", "matgrupp", "soffbord"}


def test_kedjan_exponerar_api_falten():
    payload = chain.resolve(name="Kivik hörnsoffa", prior=Prior({})).as_dict()
    for key in ("attributes", "derivedType", "possibleTypes", "typeConfidence",
                "clarifyingQuestions", "uncertainty", "typeDiagnostics"):
        assert key in payload
    assert payload["derivedType"] == "hornsoffa"


def test_kedjan_later_anvandaren_vinna_over_texten():
    result = chain.resolve(name="Söderhamn bäddsoffa",
                           user_answers={"convertible": False}, prior=Prior({}))
    assert result.attributes.get("convertible") is False
    assert result.attributes.source("convertible") == "user"
    assert result.derived_type == "soffa"


# --------------------------------------------------------------------------
# L4 kopplad till unionen — en fråga i stället för ett dubbelt så brett intervall
# --------------------------------------------------------------------------
def test_en_fraga_kollapsar_bordets_union_helt():
    """"Ekbord": både `sub` och `set_items` okända — krävs en sammansatt fråga.

    Ett svar på bara `set_items` räcker inte: säger användaren "inga stolar" är
    det fortfarande okänt om det är ett matbord, soffbord eller sidobord, och
    spännvidden mellan dem är upp till 3x.
    """
    rows = ([("matbord ek 140", 4000)] * 8 + [("matbord med 4 stolar ek", 2000)] * 8
            + [("soffbord ek", 1500)] * 6)
    frame = _candidates(rows)
    attrs = extract("Ekbord")

    simple = decide.narrowing(frame, attrs, "set_items")
    assert simple["spreadAfterExpected"] > 1.0      # en enkel fråga räcker inte

    action = decide.resolve_or_widen(frame, attrs)
    assert action["action"] == "fraga"
    assert action["composite"] is True
    assert action["spreadRatio"] > 2.0
    assert action["spreadIfAnswered"] == 1.0


def test_sammansatt_fraga_loser_soffans_tva_binarer_pa_en_gang():
    """Soffor har TVÅ oberoende prisviktiga binärer.

    En fråga om bara `corner` lämnar `convertible` öppen och tar unionen från
    2,25x till 1,75x. Fyrvägsfrågan löser båda och tar den till 1,0x.
    """
    rows = ([("soffa 3-sits gra", 5000)] * 8 + [("hornsoffa 3-sits gra", 9000)] * 8
            + [("baddsoffa 3-sits", 4000)] * 8)
    frame = _candidates(rows)
    attrs = extract("soffa")

    simple = decide.narrowing(frame, attrs, "corner")
    composite = decide.composite_narrowing(frame, attrs)
    assert composite["reduction"] > simple["reduction"]
    assert composite["spreadAfterExpected"] == 1.0

    action = decide.resolve_or_widen(frame, attrs)
    assert action["composite"] is True
    assert len(action["options"]) == 4


def test_sammansatt_fraga_erbjuds_inte_nar_ena_binaren_ar_kand():
    """Vet vi redan att det är en bäddsoffa räcker en enkel fråga."""
    rows = ([("soffa 3-sits gra", 5000)] * 8 + [("hornsoffa 3-sits gra", 9000)] * 8
            + [("baddsoffa 3-sits", 4000)] * 8)
    assert decide.composite_narrowing(_candidates(rows),
                                      extract("bäddsoffa 3-sits")) is None


def test_smal_union_ger_ingen_fraga():
    rows = [("soffa 3-sits", 5000)] * 10 + [("hornsoffa 3-sits", 5200)] * 10
    action = decide.resolve_or_widen(_candidates(rows), extract("soffa"))
    assert action["action"] == "prissatt"


def test_breddning_ligger_kvar_som_fallback():
    """Svarar användaren inte ska motorn fortfarande kunna bredda."""
    rows = ([("matbord ek 140", 4000)] * 8 + [("matbord med 4 stolar ek", 2000)] * 8)
    action = decide.resolve_or_widen(_candidates(rows), extract("Ekbord"))
    assert action["widenIfUnanswered"] > 0


def test_candidate_types_kollapsar_nar_allt_ar_kant():
    """Buggen: både corner och convertible kända gav ändå två möjliga typer.

    Följden var att en sammansatt fråga såg ut att lämna kvar osäkerhet den
    faktiskt hade löst.
    """
    attrs = extract("soffa")
    attrs.set("corner", True, "user", 1.0)
    attrs.set("convertible", True, "user", 1.0)
    assert candidate_types(attrs) == ("baddsoffa",)
    assert derive_type(attrs) == "baddsoffa"


def test_candidate_types_ar_alltid_konsekvent_med_derive_type():
    """Unionen måste innehålla det derive_type skulle svara. Per konstruktion."""
    for text in ("soffa", "Kivik hörnsoffa", "Söderhamn bäddsoffa", "Ekbord",
                 "matbord", "Billy", "bord i ek", "byrå"):
        attrs = extract(text)
        derived = derive_type(attrs)
        if derived is not None:
            assert derived in candidate_types(attrs), text


def test_resolve_or_widen_klarar_saknad_traffmangd():
    assert decide.resolve_or_widen(None, extract("soffa"))["action"] == "prissatt"


# --------------------------------------------------------------------------
# L3 mot en protokollkompatibel gateway (Lovable) i stället för OpenAI
# --------------------------------------------------------------------------
class _JsonOnlyClient:
    """Gateway som INTE stöder strikt schema — bara `json_object`.

    Speglar Lovables gateway, som Vips-appens edge functions anropar med
    `response_format: {type: "json_object"}`.
    """

    def __init__(self, payload: str):
        self.payload = payload
        self.calls = []
        outer = self

        class _Completions:
            @staticmethod
            def parse(**kwargs):
                outer.calls.append("parse")
                raise TypeError("response_format schema not supported")

            @staticmethod
            def create(**kwargs):
                outer.calls.append("create")
                message = type("M", (), {"content": outer.payload})()
                choice = type("C", (), {"message": message})()
                return type("R", (), {"choices": [choice], "usage": None})()

        self.chat = type("Chat", (), {"completions": _Completions()})()


def test_l3_faller_tillbaka_pa_fritt_json_nar_schema_saknas():
    """Gateways stöder inte alltid strikt schema. Kedjan ska fungera ändå."""
    client = _JsonOnlyClient(
        '{"corner": {"value": "ja", "confidence": "hog", "evidence": "L-form"}}')
    attrs = extract("soffa")
    info = vision_layer.ask([b"bild"], attrs, client=client, use_cache=False)
    assert client.calls == ["parse", "create"]      # strikt först, sedan fallback
    assert info["mode"] == "json_object"
    assert attrs.get("corner") is True
    assert attrs.source("corner") == "vision"
    assert derive_type(attrs) == "hornsoffa"


def test_l3_avvisar_svar_utanfor_svarsrymden():
    """Fritt JSON har ingen schemagaranti — brus får inte bli ett attribut."""
    client = _JsonOnlyClient(
        '{"corner": {"value": "kanske", "confidence": "hog", "evidence": "?"}}')
    attrs = extract("soffa")
    info = vision_layer.ask([b"bild"], attrs, client=client, use_cache=False)
    assert attrs.get("corner") is None
    assert "corner" not in info["written"]


def test_l3_redovisar_vilken_modell_som_svarade():
    """En L3-siffra utan modellnamn betyder ingenting."""
    client = _JsonOnlyClient(
        '{"corner": {"value": "nej", "confidence": "medel", "evidence": "rak"}}')
    info = vision_layer.ask([b"bild"], extract("soffa"), client=client,
                            model="google/gemini-2.5-flash", use_cache=False)
    assert info["model"] == "google/gemini-2.5-flash"


def test_cachen_sparar_ett_identiskt_anrop():
    """Samma bild, samma frågor, samma modell -> inget nytt anrop.

    Under bygget kördes samma mätning fyra gånger innan den var rätt. Utan cache
    är tre av dem betald upprepning av identiska anrop.
    """
    import shutil, tempfile
    from type_system import vision_layer as vl

    original = vl.CACHE_DIR
    vl.CACHE_DIR = Path(tempfile.mkdtemp()) / "vision"
    try:
        client = _JsonOnlyClient(
            '{"corner": {"value": "ja", "confidence": "hog", "evidence": "L"}}')
        first = vl.ask([b"unik-bild"], extract("soffa"), client=client)
        assert first["cached"] is False
        calls_after_first = len(client.calls)

        second = vl.ask([b"unik-bild"], extract("soffa"), client=client)
        assert second["cached"] is True
        assert second["tokens"] == 0
        assert len(client.calls) == calls_after_first     # inget nytt anrop
        assert second["answers"]["corner"]["value"] == "ja"
    finally:
        shutil.rmtree(vl.CACHE_DIR.parent, ignore_errors=True)
        vl.CACHE_DIR = original


# --------------------------------------------------------------------------
# Bron mellan taxonomierna — steg 1: bara teckenkodning
# --------------------------------------------------------------------------
def test_folding_overbryggar_teckenkodningen():
    """`"hornsoffa" in ["hörnsoffa"]` är falskt — och filtrerar bort allt."""
    from type_system import taxonomy
    assert taxonomy.fold("hörnsoffa") == "hornsoffa"
    assert taxonomy.fold("byrå") == "byra"
    assert taxonomy.fold("bäddsoffa") == "baddsoffa"
    assert taxonomy.fold("sänggavel") == "sanggavel"
    assert taxonomy.fold(None) is None


def test_gamla_etiketter_oversatts_till_nya():
    from type_system import taxonomy
    for legacy, canonical in [("hörnsoffa", "hornsoffa"), ("byrå", "byra"),
                              ("bäddsoffa", "baddsoffa"), ("matgrupp", "matgrupp"),
                              ("soffa", "soffa"), ("hylla", "hylla")]:
        assert taxonomy.from_legacy(legacy) == canonical


def test_okand_och_del_far_ingen_typ():
    from type_system import taxonomy
    assert taxonomy.from_legacy("okänd") is None
    assert taxonomy.from_legacy("del/tillbehör") is None


def test_fatolj_finns_i_bada_taxonomierna():
    """Låg i LEGACY_ONLY tills prisrelevansen mättes: 2,60x en stol.

    En kodningsöversättning får aldrig tyst ändra vad en typ betyder — därför
    behölls den orörd i steg 1 och avgjordes av mätning i steg 2.
    """
    from type_system import taxonomy
    assert taxonomy.from_legacy("fåtölj") == "fatolj"
    assert "fatolj" not in taxonomy.LEGACY_ONLY
    assert "fatolj" not in taxonomy.NEW_ONLY
    assert taxonomy.to_legacy("fatolj", {"fåtölj", "stol"}) == "fåtölj"


def test_nya_typer_utan_motsvarighet_ger_inget_filter():
    """skänk -> byrå vore att kasta bort den prisskillnad typen finns för."""
    from type_system import taxonomy
    assert taxonomy.to_legacy("skank") is None
    assert taxonomy.to_legacy("vitrin") is None
    assert taxonomy.to_legacy("soffbord") is None


def test_to_legacy_returnerar_bara_etiketter_som_finns():
    """Ett filter på ett värde som inte finns ger noll träffar — värre än inget."""
    from type_system import taxonomy
    available = {"hörnsoffa", "soffa", "byrå"}
    assert taxonomy.to_legacy("hornsoffa", available) == "hörnsoffa"
    assert taxonomy.to_legacy("byra", available) == "byrå"
    assert taxonomy.to_legacy("matgrupp", available) is None


def test_bron_ar_rundgangssaker_for_de_gemensamma_typerna():
    from type_system import taxonomy
    available = {"hörnsoffa", "bäddsoffa", "soffa", "byrå", "hylla", "matbord",
                 "matgrupp", "bord", "stol", "säng", "sänggavel", "spegel",
                 "fotpall", "fåtölj"}
    for label in available:
        canonical = taxonomy.from_legacy(label)
        assert canonical is not None, label
        assert taxonomy.to_legacy(canonical, available) == label, label


# --------------------------------------------------------------------------
# chair_kind — steg 2: fåtölj mot stol, MÄTT 2,60x
# --------------------------------------------------------------------------
@pytest.mark.parametrize("text,expected", [
    ("Lamino fåtölj", "fatolj"),
    ("öronlappsfåtölj i skinn", "fatolj"),
    ("Sjuan stol", "stol"),
    ("matstol i ek", "stol"),
])
def test_fatolj_och_stol_ar_skilda_typer(text, expected):
    """2,60x skillnad (1 973 modellgrupper, KI [2,50, 2,67]).

    Den största enskilda prisskillnaden i systemet. Slås de ihop underprissätts
    varje fåtölj med 61 %.
    """
    assert derive_type(extract(text)) == expected


def test_fatolj_ar_dyrast_i_prisnivatabellen():
    assert decide.PRICE_LEVEL["fatolj"] == 2.600
    assert decide.is_downgrade("fatolj", "stol") is True
    assert decide.is_downgrade("stol", "fatolj") is False


def test_okand_sittmobel_ger_union_over_bada():
    """"barnstol" är varken fåtölj eller matstol — typen förblir öppen."""
    attrs = extract("barnstol")
    assert attrs.get("base") == "stol"
    assert attrs.get("chair_kind") is None
    assert set(candidate_types(attrs)) == {"fatolj", "stol"}


def test_chair_kind_kan_fragas_om():
    """2,60x gör den till systemets mest prisviktiga fråga."""
    from type_system.attributes import IMPACT
    assert IMPACT["chair_kind"] == 5
    assert "chair_kind" in decide.ANSWER_SPACE
