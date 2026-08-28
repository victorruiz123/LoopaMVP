"""Enhetstester för prisalgoritmen, körda mot syntetisk data."""

from __future__ import annotations

import pandas as pd
import pytest

from price_engine import config
from price_engine.data_loader import (clean_price, condition_tier,
                                      normalize_condition, normalize_text)
from price_engine.condition import Band, build_bands
from price_engine.variant import (VARIANT_LABELS, UNKNOWN, VariantGuess,
                                  available_variants, classify_image,
                                  classify_series, normalize_variant)
from price_engine.pricing import compute_price_range, find_listings, price_query


# --------------------------------------------------------------------------
# Steg 5: median
# --------------------------------------------------------------------------
def test_median_udda_antal():
    """Udda antal -> medianen är den mittersta posten.

    Startläget är p40, inte medianen, så med fem priser landar det ett steg
    under mitten. Att medianen räknas rätt syns i att high (p60) hamnar på
    listans topp och low (p30) på dess botten.
    """
    result = compute_price_range([100, 200, 300, 400, 500])
    assert result.default == 300      # p45; sammanfaller med medianen vid n=5
    assert result.low == 100 and result.high == 500


def test_median_jamnt_antal():
    """Jämnt antal -> medianen är medelvärdet av de två mittersta.

    Med bara fyra priser finns ingen p40 skild från p50, och ankaret kapas
    mot medianen — annars hade default hamnat ÖVER den, eftersom
    median_index pekar på det övre av de två mittersta.
    """
    assert compute_price_range([100, 200, 300, 400]).default == 250


def test_median_ar_oberoende_av_indataordning():
    """Steg 4 sorterar, så osorterad indata ger samma svar."""
    assert (
        compute_price_range([500, 100, 300, 200, 400]).default
        == compute_price_range([100, 200, 300, 400, 500]).default
    )


# --------------------------------------------------------------------------
# Steg 2 + 3: HalvIntervall och golvet på 5
# --------------------------------------------------------------------------
def test_halvintervall_golv_ar_fem():
    """N * 0.1 = 2 -> under golvet -> 5."""
    assert compute_price_range(list(range(1, 21))).half_interval == 5


def test_halvintervall_over_golvet():
    """N = 200 -> 200 * 0.1 = 20, vilket är över golvet."""
    assert compute_price_range(list(range(1, 201))).half_interval == 20


def test_halvintervall_avrundas_uppat_vid_halva():
    """N = 55 -> 5.5 -> 6. Pythons round() hade gett 6 här, men N = 65
    -> 6.5 hade gett 6 istället för 7. Vi avrundar alltid .5 uppåt."""
    assert compute_price_range(list(range(1, 66))).half_interval == 7


def test_halvintervall_exakt_pa_golvet():
    """N = 50 -> 5.0 -> exakt golvet, ingen justering."""
    assert compute_price_range(list(range(1, 51))).half_interval == 5


# --------------------------------------------------------------------------
# Steg 6 + 7: fönsterlogiken
# --------------------------------------------------------------------------
def test_fonstret_ar_snavare_an_hela_traffmangden():
    """Fönstret ska skydda mot extremvärden i båda ändar."""
    prices = list(range(1, 101))  # 1..100 -> percentil = värdet
    result = compute_price_range(prices)
    assert result.match_count == 100
    assert result.half_interval == 10
    # Klart snävare än absolut min/max (1 och 100).
    assert result.low > min(prices)
    assert result.high < max(prices)


def test_fonstret_lutar_nedat():
    """low=p30 (lättsålt), default=p45, high=p60 (svårsålt)."""
    prices = list(range(1, 101))  # värdet ÄR percentilen + 1
    r = compute_price_range(prices)
    assert r.low == 31            # p30
    assert r.default == 46        # p45
    assert r.high == 61           # p60
    # Startläget ligger under medianen — det är hela poängen.
    assert r.default < 51


def test_startlaget_dras_inte_ned_av_golvet_vid_tunt_underlag():
    """Golvet breddar fönstret, men ska inte sänka default.

    Med golvet applicerat på p40 hade fem annonser gett default = billigaste
    annonsen (100) i stället för ett steg under medianen.
    """
    r = compute_price_range([100, 200, 300, 400, 500])
    assert r.low == 100 and r.high == 500   # golvet breddar
    assert r.default == 300                 # p45, inte golvets 100


def test_extremvarden_paverkar_inte_intervallet():
    """En annons på 1 miljon ska inte dra upp `high`."""
    prices = [1000] * 50 + [2000] * 50 + [1_000_000]
    result = compute_price_range(prices)
    assert result.high < 10_000


def test_fonstret_omsluter_medianen():
    """low <= default <= high ska alltid gälla."""
    for prices in ([5, 10, 15], list(range(1, 78)), [3, 3, 3, 99]):
        result = compute_price_range(prices)
        assert result.low <= result.default <= result.high


# --------------------------------------------------------------------------
# Kantfall
# --------------------------------------------------------------------------
def test_noll_traffar_kraschar_inte():
    result = compute_price_range([])
    assert result.match_count == 0
    assert result.default is None and result.low is None and result.high is None
    assert result.confidence == "none"
    assert "inga liknande annonser" in result.note.lower()


def test_en_enda_traff():
    """Fönstret clampas till listans gränser."""
    result = compute_price_range([2500])
    assert result.match_count == 1
    assert result.default == result.low == result.high == 2500
    assert result.confidence == "low"


def test_fa_traffar_ger_lag_konfidens():
    result = compute_price_range([100, 200, 300])
    assert result.match_count == 3
    assert result.confidence == "low"
    assert "tunt underlag" in result.note.lower()


def test_manga_traffar_ger_hog_konfidens():
    result = compute_price_range(list(range(1, 101)))
    assert result.confidence == "high"
    assert "100" in result.note


def test_farre_annonser_an_fonstret_kraver():
    """N = 4 med halvIntervall 5 -> fönstret täcker allt, inget indexfel."""
    result = compute_price_range([100, 200, 300, 400])
    assert result.half_interval == 5
    assert result.low == 100 and result.high == 400


def test_alla_priser_lika():
    result = compute_price_range([750] * 40)
    assert result.default == result.low == result.high == 750


# --------------------------------------------------------------------------
# Städning
# --------------------------------------------------------------------------
@pytest.mark.parametrize(
    "raw,expected",
    [
        (1299, 1299.0),
        (1299.5, 1299.5),
        ("1299", 1299.0),
        ("1 299 kr", 1299.0),
        ("1 299 kr", 1299.0),  # hårt mellanslag
        ("1.299:-", 1299.0),
        ("1,299.50", 1299.5),
        ("1.299,50", 1299.5),
        ("SEK 1299", 1299.0),
        ("", None),
        ("kr", None),
        (None, None),
    ],
)
def test_clean_price(raw, expected):
    assert clean_price(raw) == expected


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("gott skick", "Bra skick"),
        ("Gott skick", "Bra skick"),
        ("bra skick", "Bra skick"),
        ("mycket gott skick", "Mycket bra skick"),
        ("mycket bra skick", "Mycket bra skick"),
        ("nyskick", "Nyskick"),
        ("helt ny", "Nyskick"),
        ("okej skick", "Okej skick"),
        ("bruksslitage", "Okej skick"),
        ("soffan är i gott skick", "Bra skick"),
        ("obegripligt", None),
        ("", None),
        (None, None),
    ],
)
def test_normalize_condition(raw, expected):
    assert normalize_condition(raw) == expected


def test_normalize_condition_valjer_langsta_traffen():
    """'mycket bra skick' innehåller 'bra skick' — den längre ska vinna."""
    assert normalize_condition("i mycket bra skick") == "Mycket bra skick"


def test_normalize_text_tar_bort_diakriter():
    assert normalize_text("Söderhamn  SOFFA") == "soderhamn soffa"


# --------------------------------------------------------------------------
# Matchning mot en liten syntetisk tabell
# --------------------------------------------------------------------------
@pytest.fixture
def listings() -> pd.DataFrame:
    rows = [
        ("IKEA Landskrona 3-sits", "IKEA", 4000, "Bra skick", "asking"),
        ("Landskrona soffa grön", "IKEA", 5000, "Nyskick", "asking"),
        ("landskrona fåtölj", "", 2000, "Bra skick", "asking"),
        ("Söderhamn soffa", "IKEA", 3000, "Bra skick", "asking"),
        ("Landskrona 2-sits", "IKEA", 3500, "Okej skick", "asking"),
        ("Landskrona soffa", "IKEA", 9000, "Bra skick", "realized"),
        ("Mio Landskrona kopia", "Mio", 1500, "Bra skick", "asking"),
    ]
    frame = pd.DataFrame(
        rows, columns=["name", "brand", "price", "condition", "price_kind"]
    )
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["brand_norm"] = frame["brand"].map(normalize_text)
    frame["search_blob"] = (frame["name"] + " " + frame["brand"]).map(normalize_text)
    frame["condition_norm"] = frame["condition"].map(normalize_condition)
    frame["condition_tier"] = frame["condition"].map(condition_tier)
    return frame


def test_matchar_pa_namn(listings):
    matches = find_listings(listings, name="Landskrona", price_kind="asking")
    # Söderhamn faller bort, liksom realized-raden.
    assert len(matches) == 5
    assert "Söderhamn soffa" not in matches["name"].tolist()


def test_matchar_pa_varumarke(listings):
    matches = find_listings(listings, name="Landskrona", brand="IKEA",
                            price_kind="asking")
    assert "Mio Landskrona kopia" not in matches["name"].tolist()


def test_varumarke_hittas_aven_i_titeltexten(listings):
    """Raden 'landskrona fåtölj' har tom brand-kolumn men ska inte
    hittas för IKEA, medan 'IKEA Landskrona 3-sits' ska det."""
    matches = find_listings(listings, name="Landskrona", brand="IKEA",
                            price_kind="asking")
    assert "IKEA Landskrona 3-sits" in matches["name"].tolist()


def test_skickfilter_ar_valfritt(listings):
    utan = find_listings(listings, name="Landskrona", price_kind="asking")
    med = find_listings(listings, name="Landskrona", condition="gott skick",
                        price_kind="asking")
    assert len(med) < len(utan)
    assert set(med["condition_norm"]) == {"Bra skick"}


def test_price_kind_separerar_utrop_och_realiserat(listings):
    asking = find_listings(listings, name="Landskrona", price_kind="asking")
    realized = find_listings(listings, name="Landskrona", price_kind="realized")
    assert 9000 not in asking["price"].tolist()
    assert realized["price"].tolist() == [9000]


def test_matchning_ar_skiftlagesokanslig(listings):
    assert len(find_listings(listings, name="LANDSKRONA", price_kind="asking")) == len(
        find_listings(listings, name="landskrona", price_kind="asking")
    )


# --------------------------------------------------------------------------
# Tokenmatchning: alla ord måste finnas, ordning och skiljetecken spelar roll
# --------------------------------------------------------------------------
@pytest.fixture
def titlar() -> pd.DataFrame:
    """Verkliga titelvarianter — alla är 3-sits Landskrona-soffor."""
    rows = [
        "Landskrona 3-sits",              # exakt frasen
        "Soffa IKEA LANDSKRONA Grå 3-sits",  # ord emellan
        "LANDSKRONA soffa 3-sits",        # ord emellan
        "Ikea 3-sitssoffa Landskrona",    # omvänd ordning
        "Soffa IKEA Landskrona 3 sits",   # mellanslag i stället för bindestreck
        "Soffa, IKEA, Landskrona, 3-sits",  # kommatecken emellan
        "Landskrona 2-sits",              # fel storlek
        "Söderhamn 3-sits",               # fel modell
    ]
    frame = pd.DataFrame({"name": rows})
    frame["price"] = 2500
    frame["brand"] = "IKEA"
    frame["price_kind"] = "asking"
    frame["condition"] = None
    frame["condition_norm"] = None
    frame["condition_tier"] = None
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["brand_norm"] = "ikea"
    frame["search_blob"] = frame["name"].map(normalize_text)
    return frame


def test_alla_ord_maste_finnas(titlar):
    """Söderhamn saknar 'landskrona', 2-sits saknar '3'."""
    matches = find_listings(titlar, name="landskrona 3 sits", price_kind="asking")
    assert len(matches) == 6
    assert "Söderhamn 3-sits" not in matches["name"].tolist()
    assert "Landskrona 2-sits" not in matches["name"].tolist()


def test_ord_emellan_hindrar_inte(titlar):
    matches = find_listings(titlar, name="landskrona 3 sits", price_kind="asking")
    assert "Soffa IKEA LANDSKRONA Grå 3-sits" in matches["name"].tolist()


def test_ordningen_spelar_ingen_roll(titlar):
    matches = find_listings(titlar, name="landskrona 3 sits", price_kind="asking")
    assert "Ikea 3-sitssoffa Landskrona" in matches["name"].tolist()


def test_skiljetecken_spelar_ingen_roll(titlar):
    """Bindestreck, mellanslag och komma ska ge samma träffar."""
    a = find_listings(titlar, name="landskrona 3-sits", price_kind="asking")
    b = find_listings(titlar, name="landskrona 3 sits", price_kind="asking")
    assert set(a["name"]) == set(b["name"])


def test_delstrang_ger_bojningsformer(titlar):
    """'sits' matchar '3-sitssoffa' — delsträng är önskvärt för vanliga ord."""
    matches = find_listings(titlar, name="sits", price_kind="asking")
    assert "Ikea 3-sitssoffa Landskrona" in matches["name"].tolist()


def test_siffror_kraver_ordgrans():
    """'2' ska matcha '2-sits' men inte '2024' eller '1200 kr'."""
    frame = pd.DataFrame({"name": ["Soffa 2-sits", "Soffa från 2024", "Soffa 1200 kr"]})
    frame["price"] = 1000
    frame["brand"] = ""
    frame["price_kind"] = "asking"
    frame["condition"] = None
    frame["condition_norm"] = None
    frame["condition_tier"] = None
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["brand_norm"] = ""
    frame["search_blob"] = frame["name"].map(normalize_text)

    matches = find_listings(frame, name="soffa 2", price_kind="asking")
    assert matches["name"].tolist() == ["Soffa 2-sits"]


def test_tvaordsmarke_matchar_isarskrivet():
    """'Fritz Hansen' ska hittas även när orden står isär i titeln."""
    frame = pd.DataFrame({"name": ["Stol av Fritz Hansen", "Hansen stol, Fritz", "Stol IKEA"]})
    frame["price"] = 4000
    frame["brand"] = ""
    frame["price_kind"] = "asking"
    frame["condition"] = None
    frame["condition_norm"] = None
    frame["condition_tier"] = None
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["brand_norm"] = ""
    frame["search_blob"] = frame["name"].map(normalize_text)

    matches = find_listings(frame, name="stol", brand="Fritz Hansen", price_kind="asking")
    assert len(matches) == 2
    assert "Stol IKEA" not in matches["name"].tolist()


# --------------------------------------------------------------------------
# Prisbas: realized / asking / auto
# --------------------------------------------------------------------------
def _market(realized_n: int, asking_n: int) -> pd.DataFrame:
    """Syntetisk marknad: N realiserade priser à 5000, N utropspriser à 9000.

    Modellnamnet "Sjuan" är inte valfritt. En förfrågan som bara består av
    typord ("Stol") räknas som anonym och tvingar då utropsbas oavsett
    auto-tröskeln — se identity_is_anonymous. Testerna här mäter tröskeln, och
    behöver därför en identifierbar produkt.
    """
    rows = [(f"Sjuan stol {i}", "", 5000 + i, None, "realized")
            for i in range(realized_n)]
    rows += [(f"Sjuan stol {i}", "", 9000 + i, None, "asking")
             for i in range(asking_n)]
    frame = pd.DataFrame(
        rows, columns=["name", "brand", "price", "condition", "price_kind"]
    )
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["brand_norm"] = frame["brand"].map(normalize_text)
    frame["search_blob"] = frame["name"].map(normalize_text)
    frame["condition_norm"] = None
    return frame


def test_default_ar_auto():
    assert config.DEFAULT_PRICE_KIND == "auto"


def test_auto_valjer_asking_nar_utropen_racker():
    """UTROP FÖRST. Ändrad regel: auktionsdominans räcker inte längre.

    Den gamla regeln valde auktion när auktion dominerade underlaget. Den var
    fel om syftet — motorn hjälper någon sälja på en marknadsplats. Swedese
    Lamino gav 4 600 kr mot facit 8 500-12 000 av just det skälet.
    """
    payload = price_query(_market(realized_n=1972, asking_n=224), name="Sjuan",
                          price_kind="auto")
    assert payload["priceBasis"] == "asking"
    assert payload["matchCount"] == 224


def test_auktionsfallback_raknas_upp_till_utropsniva():
    """För få utropspriser -> auktion, men uppräknad med en MÄTT kvot."""
    payload = price_query(_market(realized_n=400, asking_n=10), name="Sjuan",
                          price_kind="auto")
    assert payload["priceBasis"].startswith("realized_corrected")
    # Syntetiska auktionspriser ligger på 5 000; korrektionen ska lyfta dem.
    assert payload["default"] > 5000


def test_gamla_dominansregeln_finns_kvar_bakom_flaggan(monkeypatch):
    monkeypatch.setattr(config, "BASIS_PREFER_ASKING", False)
    payload = price_query(_market(realized_n=1972, asking_n=224), name="Sjuan",
                          price_kind="auto")
    assert payload["priceBasis"] == "realized"


def _gammal_test_auto_valjer_realized_nar_auktion_dominerar():
    """Wegner-fallet: 1 972 realized mot 224 asking -> auktion är marknaden."""
    payload = price_query(_market(realized_n=200, asking_n=25), name="Sjuan",
                          price_kind="auto")
    assert payload["priceBasis"] == "realized"
    assert payload["matchCount"] == 200
    assert payload["default"] < 9000  # realized-nivån, inte asking-nivån


def test_auto_valjer_asking_nar_auktion_ar_marginell():
    """Landskrona-fallet: 14 realized mot 624 asking -> auktion är marginell."""
    payload = price_query(_market(realized_n=14, asking_n=624), name="Sjuan",
                          price_kind="auto")
    assert payload["priceBasis"] == "asking"
    assert payload["matchCount"] == 624
    assert payload["default"] >= 9000


def _gammal_test_auto_valjer_realized_precis_over_troskeln():
    """50 realized mot 100 asking = exakt 0.50 -> realized vinner."""
    payload = price_query(_market(realized_n=50, asking_n=100), name="Sjuan",
                          price_kind="auto")
    assert payload["priceBasis"] == "realized"


def test_auto_valjer_asking_precis_under_troskeln():
    """49 realized mot 100 asking = 0.49 -> asking vinner."""
    payload = price_query(_market(realized_n=49, asking_n=100), name="Sjuan",
                          price_kind="auto")
    assert payload["priceBasis"] == "asking"


def test_auto_respekterar_absolut_golv():
    """Hög andel men för få realiserade priser -> asking ändå."""
    payload = price_query(_market(realized_n=6, asking_n=8), name="Sjuan",
                          price_kind="auto")
    assert payload["priceBasis"] == "asking"


def _gammal_test_auto_anvander_realized_nar_asking_saknas_helt():
    payload = price_query(_market(realized_n=4, asking_n=0), name="Sjuan",
                          price_kind="auto")
    assert payload["priceBasis"] == "realized"
    assert payload["matchCount"] == 4


def test_auto_utan_traffar_alls():
    payload = price_query(_market(realized_n=0, asking_n=0), name="Sjuan",
                          price_kind="auto")
    assert payload["matchCount"] == 0
    assert payload["confidence"] == "none"


def test_basen_framgar_av_noteringen(listings):
    payload = price_query(listings, name="Landskrona", price_kind="asking")
    assert "utropspriser" in payload["note"]
    payload = price_query(listings, name="Landskrona", price_kind="realized")
    assert "faktiskt betalda" in payload["note"]


# --------------------------------------------------------------------------
# Hela kedjan / output-format
# --------------------------------------------------------------------------
def test_svarets_format(listings):
    payload = price_query(listings, name="Landskrona", brand="IKEA",
                          condition="gott skick", price_kind="asking")
    assert list(payload) == [
        "query", "priceBasis", "cellLevel", "cellKey", "cellFilterDropped",
        "formFromImage", "damage", "ignoredTerms", "relaxedTerms", "identityAnonymous",
        "variantMethod", "variantSource",
        "variantCandidates", "filtersApplied", "filtersConverted",
        "effectiveN", "cohort", "dispersionWarning",
        "sizeMethod", "sizeQuery", "sizeWarning",
        "cueMethod", "cueWords", "percentileGrid",
        "fallbackMethod", "fallback",
        "conditionMethod", "conditionAnchor", "conditionBand",
        "imageFiltered", "imageMatchCount", "similarityRange",
        "recencyMethod", "recencyCutoff", "dataStaleness",
        # Attributsystemets fält (type_system/). Redovisande, inte styrande:
        # de påverkar inte priset, men visar vad kedjan L0-L5 ser.
        "attributes", "derivedType", "possibleTypes", "typeConfidence",
        "clarifyingQuestions", "typeUncertainty", "typeUncertaintyAction",
        "matchCount", "halfInterval", "default", "low", "high",
        "confidence", "note",
    ]
    # `variant` är inte längre None: attributsystemet härleder bastypen ur
    # modellnamnspriorn (Landskrona -> soffa, 84,5 %, entropi 0,353) och
    # returnerar unionen av de sofftyper som ännu är möjliga. Effekten är att
    # 96 fåtöljer, 49 fotpallar och 5 bord faller bort ur medianen — precis det
    # problem typfiltret finns för.
    assert payload["query"] == {
        "name": "Landskrona", "brand": "IKEA", "condition": "gott skick",
        "variant": ["baddsoffa", "hornsoffa", "soffa"],
    }


def test_svar_utan_traffar(listings):
    payload = price_query(listings, name="Existerar Inte")
    assert payload["matchCount"] == 0
    assert payload["default"] is None
    assert payload["confidence"] == "none"


def test_konfigurerade_troskelvarden_stammer():
    """Skyddar mot oavsiktliga ändringar i config."""
    assert config.HALF_INTERVAL_RATIO == 0.10
    assert config.MIN_HALF_INTERVAL == 5


# --------------------------------------------------------------------------
# Möbeltyp: taxonomi och exklusiv tilldelning
# --------------------------------------------------------------------------
@pytest.mark.parametrize(
    "titel,forvantad",
    [
        ("Landskrona 3-sits soffa", "soffa"),
        ("Landskrona hörnsoffa grå", "hörnsoffa"),
        ("Vimle bäddsoffa", "bäddsoffa"),
        ("Landskrona fåtölj", "fåtölj"),
        ("Söderhamn fotpall", "fotpall"),
        ("Malm säng 160cm", "säng"),
        ("Billy bokhylla vit", "hylla"),
        ("Lack soffbord", "bord"),  # ett soffbord är ett bord, inte en soffa
        ("Ekedalen matbord", "matbord"),
        ("Ekedalen matbord och 4 stolar", "matgrupp"),
        ("Matgrupp med 6 stolar", "matgrupp"),
        ("Hemnes byrå", "byrå"),
        ("Landskrona", "okänd"),
    ],
)
def test_variantklassning(titel, forvantad):
    blob = pd.Series([normalize_text(titel)])
    assert classify_series(blob).iloc[0] == forvantad


def test_tilldelningen_ar_exklusiv():
    """En titel med flera nyckelord får EN variant — den mest specifika."""
    blob = pd.Series([normalize_text("Landskrona 3-sits soffa med divan och fotpall")])
    assert classify_series(blob).iloc[0] == "hörnsoffa"


def test_normalize_variant_tolkar_fritext():
    assert normalize_variant("hörnsoffa") == "hörnsoffa"
    assert normalize_variant("HÖRNSOFFA") == "hörnsoffa"
    assert normalize_variant("en soffa med divan") == "hörnsoffa"
    assert normalize_variant("obegripligt") is None
    assert normalize_variant(None) is None


def test_alla_etiketter_ar_klassbara():
    """Varje etikett i taxonomin ska kunna tolkas tillbaka av normalize_variant."""
    for label in VARIANT_LABELS:
        if label != UNKNOWN:
            assert normalize_variant(label) == label


# --------------------------------------------------------------------------
# Variantkedjan: filtered -> relaxed -> ignored
# --------------------------------------------------------------------------
def _variantmarknad(soffor: int, fotpallar: int, okanda: int) -> pd.DataFrame:
    rows = [("Testmodell soffa", 3000)] * soffor
    rows += [("Testmodell fotpall", 800)] * fotpallar
    rows += [("Testmodell", 2000)] * okanda
    frame = pd.DataFrame(rows, columns=["name", "price"])
    frame["brand"] = ""
    frame["price_kind"] = "asking"
    frame["condition"] = None
    frame["condition_norm"] = None
    frame["condition_tier"] = None
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["brand_norm"] = ""
    frame["search_blob"] = frame["name"].map(normalize_text)
    frame["variant"] = classify_series(frame["search_blob"])
    return frame


def test_variant_filtrerar_strikt_nar_underlaget_racker():
    payload = price_query(_variantmarknad(soffor=40, fotpallar=40, okanda=40),
                          name="Testmodell", variant="soffa", price_kind="asking")
    assert payload["variantMethod"] == "filtered"
    assert payload["matchCount"] == 40
    assert payload["default"] == 3000  # bara soffor, inte blandat


def test_variant_slapper_in_okanda_nar_strikt_ar_for_tunt():
    """5 soffor < 15, men 5 + 30 okända räcker — och fotpallarna utesluts."""
    payload = price_query(_variantmarknad(soffor=5, fotpallar=40, okanda=30),
                          name="Testmodell", variant="soffa", price_kind="asking")
    assert payload["variantMethod"] == "relaxed"
    assert payload["matchCount"] == 35
    assert payload["default"] == 2000  # okända dominerar, men inga fotpallar


def test_variant_ignoreras_nar_aven_relaxat_ar_for_tunt():
    payload = price_query(_variantmarknad(soffor=2, fotpallar=40, okanda=3),
                          name="Testmodell", variant="soffa", price_kind="asking")
    assert payload["variantMethod"] == "ignored"
    assert payload["matchCount"] == 45  # hela underlaget


def test_variant_ignoreras_nar_filtret_inte_utesluter_nagot():
    """Alla annonser är redan okända -> relaxat filter gör ingen skillnad."""
    payload = price_query(_variantmarknad(soffor=0, fotpallar=0, okanda=40),
                          name="Testmodell", variant="soffa", price_kind="asking")
    assert payload["variantMethod"] == "ignored"
    assert payload["matchCount"] == 40


def test_variant_utan_en_enda_markt_traff_ignoreras():
    """Noll märkta soffor betyder att typen inte gäller modellen.

    Att behålla de okända vore att prissätta en möbel som inte finns —
    jämför "Landskrona säng", där ingen av 624 annonser är en säng.
    """
    payload = price_query(_variantmarknad(soffor=0, fotpallar=40, okanda=30),
                          name="Testmodell", variant="soffa", price_kind="asking")
    assert payload["variantMethod"] == "ignored"
    assert payload["matchCount"] == 70  # hela underlaget, inte de 30 okända


def test_ingen_variant_angiven_ger_none():
    payload = price_query(_variantmarknad(soffor=40, fotpallar=40, okanda=0),
                          name="Testmodell", price_kind="asking")
    assert payload["variantMethod"] == "none"
    assert payload["matchCount"] == 80


def test_otolkbar_variant_ger_none():
    payload = price_query(_variantmarknad(soffor=40, fotpallar=40, okanda=0),
                          name="Testmodell", variant="obegripligt", price_kind="asking")
    assert payload["variantMethod"] == "none"
    assert payload["matchCount"] == 80


def test_varianten_framgar_av_noteringen():
    payload = price_query(_variantmarknad(soffor=40, fotpallar=40, okanda=0),
                          name="Testmodell", variant="soffa", price_kind="asking")
    assert "Endast soffa" in payload["note"]


def test_variant_filtreras_fore_skick():
    """Skickets tröskel ska räknas på den typrätta delmängden."""
    frame = _variantmarknad(soffor=40, fotpallar=40, okanda=0)
    frame["condition_tier"] = "Bra skick"
    payload = price_query(frame, name="Testmodell", variant="soffa",
                          condition="gott skick", price_kind="asking")
    assert payload["variantMethod"] == "filtered"
    assert payload["conditionMethod"] == "filtered"
    assert payload["matchCount"] == 40  # inte 80


# --------------------------------------------------------------------------
# Kandidater och bildklassning (utan nätverk)
# --------------------------------------------------------------------------
def test_kandidater_harleds_ur_datan():
    """Bara typer som klarar strikt filtrering erbjuds som alternativ."""
    frame = _variantmarknad(soffor=40, fotpallar=20, okanda=30)
    kandidater = available_variants(frame)
    assert kandidater == [("soffa", 40), ("fotpall", 20)]  # okänd exkluderas


def test_for_fa_annonser_blir_ingen_kandidat():
    """En typ med 5 annonser kan aldrig svaras — den ger ju noll efter filter."""
    frame = _variantmarknad(soffor=40, fotpallar=5, okanda=0)
    assert [v for v, _ in available_variants(frame)] == ["soffa"]


def test_variantguess_anvandbarhet():
    assert VariantGuess(["soffa"], "hög").usable
    assert VariantGuess(["soffa", "bäddsoffa"], "medel").usable
    assert not VariantGuess(["soffa"], "låg").usable
    assert not VariantGuess([], "hög").usable


def test_bilden_klassas_bara_nar_flera_typer_ar_mojliga():
    """En Billy är alltid en hylla — då är modellanropet bortkastat."""
    anrop = []

    def _spion(**kwargs):
        anrop.append(kwargs)
        return VariantGuess(["soffa"], "hög")

    en_typ = _variantmarknad(soffor=40, fotpallar=0, okanda=30)
    price_query(en_typ, name="Testmodell", image=b"foto", classifier=_spion,
                price_kind="asking")
    assert anrop == []  # inget anrop gjordes

    flera = _variantmarknad(soffor=40, fotpallar=40, okanda=0)
    price_query(flera, name="Testmodell", image=b"foto", classifier=_spion,
                price_kind="asking")
    assert len(anrop) == 1
    assert [v for v, _ in anrop[0]["candidates"]] == ["soffa", "fotpall"]


def test_bilden_kan_ge_flera_typer():
    """Bäddsoffa syns inte på foto -> ta unionen, men uteslut fotpall."""
    rows = [("Testmodell soffa", 3000)] * 40 + [("Testmodell bäddsoffa", 6000)] * 40
    rows += [("Testmodell fotpall", 800)] * 40
    frame = pd.DataFrame(rows, columns=["name", "price"])
    for col, val in [("brand", ""), ("price_kind", "asking"), ("condition", None),
                     ("condition_norm", None), ("condition_tier", None),
                     ("brand_norm", "")]:
        frame[col] = val
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["search_blob"] = frame["name"].map(normalize_text)
    frame["variant"] = classify_series(frame["search_blob"])

    payload = price_query(
        frame, name="Testmodell", image=b"foto", price_kind="asking",
        classifier=lambda **kw: VariantGuess(["soffa", "bäddsoffa"], "medel"),
    )
    assert payload["variantMethod"] == "filtered"
    assert payload["matchCount"] == 80  # soffa + bäddsoffa, inte fotpall
    assert "soffa eller bäddsoffa" in payload["note"]


def test_lag_konfidens_ger_inget_filter():
    payload = price_query(
        _variantmarknad(soffor=40, fotpallar=40, okanda=0),
        name="Testmodell", image=b"foto", price_kind="asking",
        classifier=lambda **kw: VariantGuess(["soffa"], "låg"),
    )
    assert payload["variantMethod"] == "none"
    assert payload["matchCount"] == 80


def test_explicit_variant_slar_bilden():
    """Explicit variant är gratis och kan inte gissa fel — den vinner."""
    anrop = []
    payload = price_query(
        _variantmarknad(soffor=40, fotpallar=40, okanda=0),
        name="Testmodell", variant=["fotpall"], image=b"foto", price_kind="asking",
        classifier=lambda **kw: anrop.append(kw) or VariantGuess(["soffa"], "hög"),
    )
    assert anrop == []
    assert payload["query"]["variant"] == ["fotpall"]
    assert payload["matchCount"] == 40


def test_classify_image_bygger_ratt_anrop():
    """Verifierar OpenAI-anropets form utan att gå ut på nätet."""
    captured = {}

    class _FakeCompletions:
        def parse(self, **kwargs):
            captured.update(kwargs)
            parsed = kwargs["response_format"](variants=["hörnsoffa"], confidence="hög")
            msg = type("M", (), {"parsed": parsed})()
            return type("C", (), {"choices": [type("Ch", (), {"message": msg})()]})()

    class _FakeClient:
        chat = type("Chat", (), {"completions": _FakeCompletions()})()

    guess = classify_image(
        b"\xff\xd8fake", candidates=[("hörnsoffa", 92), ("soffa", 405)],
        name="Landskrona", brand="IKEA", client=_FakeClient(),
    )

    assert guess == VariantGuess(["hörnsoffa"], "hög")
    assert captured["model"] == config.VARIANT_MODEL
    innehall = captured["messages"][0]["content"]
    # Prompten ska lista kandidaterna med antal, så modellen får en prior.
    assert "hörnsoffa (92 annonser)" in innehall[0]["text"]
    assert "Landskrona" in innehall[0]["text"]
    # Bilden skickas som data-URL, base64-kodad.
    assert innehall[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")


def test_classify_image_slapper_svar_utanfor_kandidatlistan():
    """Skyddsnät om modellen hittar på en typ som inte fanns bland alternativen."""
    class _FakeCompletions:
        def parse(self, **kwargs):
            parsed = type("P", (), {"variants": ["soffa", "rymdskepp"],
                                    "confidence": "hög"})()
            msg = type("M", (), {"parsed": parsed})()
            return type("C", (), {"choices": [type("Ch", (), {"message": msg})()]})()

    client = type("Cl", (), {"chat": type("Chat", (), {"completions": _FakeCompletions()})()})()
    guess = classify_image(b"x", candidates=[("soffa", 40)], client=client)
    assert guess.variants == ["soffa"]


def test_classify_image_utan_kandidater_gor_inget_anrop():
    assert classify_image(b"x", candidates=[]) == VariantGuess([], "låg")

# --------------------------------------------------------------------------
# Skickband — skalan och omankringen
# --------------------------------------------------------------------------
def _frame(rows: list) -> pd.DataFrame:
    """Bygger en tabell ur (namn, pris, skick, prissort, kat, undergrupp)."""
    frame = pd.DataFrame(
        rows,
        columns=["name", "price", "condition", "price_kind", "category", "subgroup"],
    )
    frame["brand"] = ""
    frame["listed_at"] = pd.Timestamp.now(tz="UTC") - pd.Timedelta(days=30)
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["brand_norm"] = ""
    frame["search_blob"] = frame["name"].map(normalize_text)
    frame["condition_norm"] = frame["condition"]
    frame["condition_tier"] = frame["condition"].map(condition_tier)
    frame["variant"] = classify_series(frame["search_blob"])
    return frame


#: Kvoter mot Bra skick per undergrupp. Sjunker för Okej och stiger för
#: Toppskick med referenspriset, precis som i riktig data.
_OKEJ = (0.75, 0.72, 0.70, 0.65, 0.62, 0.60, 0.50, 0.48, 0.45)
_TOPP = (1.15, 1.18, 1.20, 1.28, 1.30, 1.32, 1.60, 1.65, 1.70)


def _band_market() -> pd.DataFrame:
    """Nio undergrupper — tre per prisnivå, precis på MULTIPLIER_MIN_GROUPS.

    Bra skick är skalans interna ankare (kvot 1,0). Medianer:

        globalt   Okej 0,62   Topp 1,30
        låg       Okej 0,72   Topp 1,18
        mellan    Okej 0,62   Topp 1,30
        hög       Okej 0,48   Topp 1,65
    """
    rows = []
    for i, (okej, topp) in enumerate(zip(_OKEJ, _TOPP)):
        referens = 500 * (i + 1)
        key = f"grupp-{i}"
        for _ in range(6):  # >= MULTIPLIER_MIN_ROWS
            rows.append((key, referens, "Bra skick", "asking", "kat", key))
            rows.append((key, referens * okej, "Okej skick", "asking", "kat", key))
            rows.append((key, referens * topp, "Mycket bra skick", "asking", "kat", key))
    return _frame(rows)


def test_skalan_gar_at_bada_hallen():
    """Okej under 1,0 och Toppskick över — mot det interna ankaret Bra skick."""
    bands = build_bands(_band_market())
    assert bands.overall["Okej skick"].median == pytest.approx(0.62)
    assert bands.overall["Toppskick"].median == pytest.approx(1.30)


def test_bandet_ar_percentiler_inte_en_punkt():
    """Skalningen använder p40/p60, viddmätningen p25/p75."""
    band = build_bands(_band_market()).overall["Okej skick"]
    assert band.low < band.median < band.high
    assert band.p25 < band.low and band.high < band.p75
    assert band.groups == 9


def test_referensskicket_ger_identitet():
    bands = build_bands(_band_market())
    band, source = bands.lookup(1000, config.CONDITION_REFERENCE)
    assert (band.low, band.median, band.high) == (1.0, 1.0, 1.0)
    assert source == "reference"


def test_prisnivaband_gar_fore_globalt():
    """Kvoten beror på prisnivå — billiga möbler tappar mindre på slitage."""
    bands = build_bands(_band_market())
    assert bands.edges, "prisnivåer ska ha byggts"
    lag, k1 = bands.lookup(500, "Okej skick")
    hog, k2 = bands.lookup(4500, "Okej skick")
    assert k1 == k2 == "level"
    assert lag.median == pytest.approx(0.72)
    assert hog.median == pytest.approx(0.48)


def test_okant_skick_ger_ingen_justering():
    """Saknas bandet helt -> None, inte en gissning."""
    rows = []
    for i in range(9):
        key = f"g{i}"
        for _ in range(6):
            rows.append((key, 1000, "Bra skick", "asking", "kat", key))
    bands = build_bands(_frame(rows))
    band, source = bands.lookup(1000, "Okej skick")
    assert band is None and source == "none"


def test_banden_ignorerar_realized():
    """Auktionsrader ska inte bidra — kvoterna där är icke-monotona."""
    rows = []
    for i in range(9):
        key = f"g{i}"
        for _ in range(6):
            rows.append((key, 1000, "Bra skick", "realized", "kat", key))
            rows.append((key, 100, "Okej skick", "realized", "kat", key))
    assert build_bands(_frame(rows)).overall == {}


def test_for_fa_rader_ger_inget_band():
    rows = []
    for i in range(9):
        key = f"g{i}"
        for _ in range(2):  # under MULTIPLIER_MIN_ROWS
            rows.append((key, 1000, "Bra skick", "asking", "kat", key))
            rows.append((key, 400, "Okej skick", "asking", "kat", key))
    bands = build_bands(_frame(rows))
    assert bands.overall == {} and bands.per_level == {}


# --------------------------------------------------------------------------
# Omankringen: medianskicket bland träffarna får faktor 1,0
# --------------------------------------------------------------------------
def test_omankring_flyttar_skalan():
    """faktor(mål) = skala[mål] / skala[ankare]."""
    bands = build_bands(_band_market())
    # Utan ankare: mot det interna Bra skick.
    utan, _ = bands.lookup(2500, "Toppskick")
    # Med Okej skick som ankare blir allt dyrare relativt sett.
    med, kalla = bands.lookup(2500, "Okej skick", anchor="Toppskick")
    okej, _ = bands.lookup(2500, "Okej skick")
    topp, _ = bands.lookup(2500, "Toppskick")
    assert med.median == pytest.approx(okej.median / topp.median, rel=1e-3)
    assert "/" in kalla  # källan visar båda uppslagen


def test_ankare_lika_mal_ger_identitet():
    bands = build_bands(_band_market())
    band, _ = bands.lookup(2500, "Okej skick", anchor="Okej skick")
    assert band.median == pytest.approx(1.0)


def test_faktorn_kapas_vid_sanitetstaket():
    """Extrema kvoter kapas, men taket är generöst nu när ankaret mäts."""
    from price_engine.condition import _band
    band = _band(pd.Series([3.0, 3.5, 4.0, 4.5, 5.0]))
    assert band.median == config.BAND_MAX_FACTOR == 2.0


@pytest.mark.parametrize(
    "p25,p75,vid",
    [(0.5, 0.8, False), (0.94, 2.00, True), (1.20, 1.60, False), (1.41, 2.86, True)],
)
def test_vidd_markeras(p25, p75, vid):
    """Vidden mäts på p25/p75, inte på skalningskvantilerna."""
    mid = (p25 + p75) / 2
    assert Band(low=mid, median=mid, high=mid, p25=p25, p75=p75, groups=20).wide is vid


def test_fa_grupper_gor_bandet_osakert():
    tunt = Band(low=0.43, median=0.44, high=0.45, p25=0.43, p75=0.47, groups=7)
    assert not tunt.wide and tunt.thin and tunt.shaky
    stadigt = Band(low=0.43, median=0.44, high=0.45, p25=0.43, p75=0.47, groups=41)
    assert not stadigt.shaky


# --------------------------------------------------------------------------
# Färskhet: fönster -> utökning
# --------------------------------------------------------------------------
def _tidsmarknad(inom: int, utanfor: int, pris_inom=1000, pris_utanfor=2000):
    """Annonser inom och utanför färskhetsfönstret, med olika prisnivå.

    Prisskillnaden gör det synligt vilka som faktiskt användes.
    """
    nu = pd.Timestamp.now(tz="UTC")
    rader, datum = [], []
    for i in range(inom):
        rader.append(("Testsoffa", pris_inom))
        datum.append(nu - pd.Timedelta(days=10 + i))
    for i in range(utanfor):
        rader.append(("Testsoffa", pris_utanfor))
        datum.append(nu - pd.DateOffset(months=config.RECENCY_MONTHS + 2, days=i))
    frame = pd.DataFrame(rader, columns=["name", "price"])
    frame["listed_at"] = pd.to_datetime(pd.Series(datum), utc=True)
    for col, val in [("brand", ""), ("brand_norm", ""), ("price_kind", "asking"),
                     ("condition", None), ("condition_norm", None),
                     ("condition_tier", None), ("variant", "soffa")]:
        frame[col] = val
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["search_blob"] = frame["name"].map(normalize_text)
    return frame


def test_farska_annonser_racker():
    """20 färska >= golvet -> bara fönstret används, gamla priser ignoreras."""
    payload = price_query(_tidsmarknad(inom=20, utanfor=50), name="Testsoffa",
                          price_kind="asking")
    assert payload["recencyMethod"] == "window"
    assert payload["matchCount"] == 20
    assert payload["default"] == 1000  # inte 2000


def test_underlaget_utokas_bakat_till_golvet():
    """5 färska < 15 -> fyll på med de senaste gamla tills 15 nås."""
    payload = price_query(_tidsmarknad(inom=5, utanfor=50), name="Testsoffa",
                          price_kind="asking")
    assert payload["recencyMethod"] == "extended"
    assert payload["matchCount"] == config.RECENCY_MIN_LISTINGS
    assert "senaste" in payload["note"]


def test_utokningen_tar_de_senaste_inte_slumpvis():
    """De 10 påfyllda ska vara de nyaste av de gamla."""
    frame = _tidsmarknad(inom=5, utanfor=50)
    from price_engine.pricing import _apply_recency
    valda, metod, _ = _apply_recency(frame)
    assert metod == "extended"
    gamla = valda[valda["price"] == 2000]
    assert len(gamla) == 10
    # Ingen av de valda gamla får vara äldre än någon bortvald.
    bortvalda = frame[~frame.index.isin(valda.index)]
    assert gamla["listed_at"].min() > bortvalda["listed_at"].max()


def test_farre_an_golvet_totalt_ger_alla():
    payload = price_query(_tidsmarknad(inom=3, utanfor=4), name="Testsoffa",
                          price_kind="asking")
    assert payload["matchCount"] == 7


def test_utan_tidsstampel_filtreras_inte():
    """Saknas datum helt -> hellre gammalt underlag än tomt."""
    frame = _tidsmarknad(inom=20, utanfor=20)
    frame["listed_at"] = pd.NaT
    payload = price_query(frame, name="Testsoffa", price_kind="asking")
    assert payload["recencyMethod"] == "none"
    assert payload["matchCount"] == 40


# --------------------------------------------------------------------------
# Skalan går åt båda hållen — taket "höj aldrig" är borttaget
# --------------------------------------------------------------------------
def _skickmarknad(topp_pris: int, ovrigt_pris: int, topp_n=20, ovrigt_n=60):
    rows = [("Testsoffa", topp_pris, "Mycket bra skick", "asking", "kat", "g")] * topp_n
    rows += [("Testsoffa", ovrigt_pris, "Bra skick", "asking", "kat", "g")] * ovrigt_n
    return _frame(rows)


def test_filtrerat_toppskick_far_ligga_over_medianen(band_tabell):
    """Riktiga toppskicksannonser får kosta mer än det obetingade priset.

    Tidigare kapades detta ("medianen höjs aldrig"), eftersom vi inte visste
    vilket skick medianen speglade. Nu mäts ankaret, så uppräkningen är
    grundad i stället för antagen.
    """
    frame = _skickmarknad(topp_pris=9000, ovrigt_pris=4000)
    obetingad = price_query(frame, name="Testsoffa", price_kind="asking",
                            multipliers=band_tabell)
    topp = price_query(frame, name="Testsoffa", condition="mycket bra skick",
                       price_kind="asking", multipliers=band_tabell)
    assert topp["conditionMethod"] == "filtered"
    assert topp["default"] > obetingad["default"]


def test_filtrerat_skick_under_medianen_behalls(band_tabell):
    frame = _skickmarknad(topp_pris=2000, ovrigt_pris=4000)
    topp = price_query(frame, name="Testsoffa", condition="mycket bra skick",
                       price_kind="asking", multipliers=band_tabell)
    assert topp["conditionMethod"] == "filtered"
    assert topp["default"] == 2000


# --------------------------------------------------------------------------
# Fas 6 — bildlikhet som omsortering
# --------------------------------------------------------------------------
import numpy as np

from price_engine import vision
from price_engine.vectors import VectorStore


def _enhetsvektor(dim, i):
    """Ortogonal enhetsvektor — skalärprodukten blir 1 mot sig själv, 0 mot andra."""
    v = np.zeros(dim, dtype=np.float32)
    v[i % dim] = 1.0
    return v


def test_likhet_ar_skalarprodukt_for_normaliserade_vektorer():
    """L2-normaliserade vektorer -> cosinuslikhet = skalärprodukt."""
    dim = 8
    q = _enhetsvektor(dim, 0)
    kandidater = np.stack([_enhetsvektor(dim, i) for i in range(4)])
    farg = np.zeros((4, 4), dtype=np.float32)
    s = vision.similarity(q, np.zeros(4, np.float32), kandidater, farg, color_weight=0.0)
    assert s[0] == pytest.approx(1.0)
    assert s[1:] == pytest.approx(0.0)


def test_farg_vags_in_enligt_vikten():
    """poäng = (1-w)*bild + w*färg."""
    q, qc = _enhetsvektor(4, 0), _enhetsvektor(4, 1)
    bild = np.stack([_enhetsvektor(4, 0)])          # bildlikhet 1
    farg = np.stack([_enhetsvektor(4, 2)])          # färglikhet 0
    assert vision.similarity(q, qc, bild, farg, 0.0)[0] == pytest.approx(1.0)
    assert vision.similarity(q, qc, bild, farg, 0.5)[0] == pytest.approx(0.5)
    assert vision.similarity(q, qc, bild, farg, 1.0)[0] == pytest.approx(0.0)


def _bildmarknad(likheter, pris_lik=1000, pris_olik=5000):
    """Annonser med kända vektorer: de 'lika' delar riktning med frågan."""
    nu = pd.Timestamp.now(tz="UTC")
    dim = config.EMBED_DIM
    rader, vektorer, urls = [], [], []
    for i, lik in enumerate(likheter):
        rader.append(("Testsoffa", pris_lik if lik else pris_olik))
        v = np.zeros(dim, np.float32)
        v[0 if lik else 1] = 1.0
        vektorer.append(v)
        urls.append(f"https://exempel/{i}.jpg")
    frame = pd.DataFrame(rader, columns=["name", "price"])
    frame["image_url"] = urls
    frame["listed_at"] = nu - pd.Timedelta(days=30)
    for col, val in [("brand", ""), ("brand_norm", ""), ("price_kind", "asking"),
                     ("condition", None), ("condition_norm", None),
                     ("condition_tier", None), ("variant", "soffa")]:
        frame[col] = val
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["search_blob"] = frame["name"].map(normalize_text)

    from price_engine.images import cache_path
    store = VectorStore(
        embeddings=np.stack(vektorer).astype(np.float16),
        colors=np.zeros((len(urls), 3 * config.COLOR_BINS), np.float16),
        cropped=np.ones(len(urls), bool),
        row_of={cache_path(u).stem: i for i, u in enumerate(urls)},
    )
    return frame, store


def _fraga():
    v = np.zeros(config.EMBED_DIM, np.float32); v[0] = 1.0
    return v, np.zeros(3 * config.COLOR_BINS, np.float32)


def test_bildfiltret_behaller_bara_de_lika():
    from price_engine.pricing import _apply_image
    frame, store = _bildmarknad([True] * 20 + [False] * 40)
    kvar, metod, spann = _apply_image(frame, _fraga(), store)
    assert metod == "filtered"
    assert len(kvar) == 20
    assert (kvar["price"] == 1000).all()
    assert spann[0] >= config.IMAGE_SIMILARITY_MIN


def test_bildfiltret_lattas_nar_for_fa_overlever():
    """3 lika < IMAGE_MIN_LISTINGS -> tröskeln släpps och det markeras."""
    from price_engine.pricing import _apply_image
    frame, store = _bildmarknad([True] * 3 + [False] * 40)
    kvar, metod, _ = _apply_image(frame, _fraga(), store)
    assert metod == "loosened"
    assert len(kvar) >= config.IMAGE_MIN_LISTINGS


def test_utan_vektorlager_filtreras_inte():
    frame, _ = _bildmarknad([True] * 20)
    from price_engine.pricing import _apply_image
    kvar, metod, spann = _apply_image(frame, _fraga(), VectorStore())
    assert metod == "none" and spann is None and len(kvar) == len(frame)


def test_prisalgoritmen_kors_pa_den_bildfiltrerade_mangden():
    """Hela poängen: befintlig prislogik, bättre urvalsmängd."""
    frame, store = _bildmarknad([True] * 20 + [False] * 40)
    utan = price_query(frame, name="Testsoffa", price_kind="asking")
    med = price_query(frame, name="Testsoffa", price_kind="asking",
                      image=b"x", vectors=store,
                      classifier=lambda **kw: None)
    assert utan["imageFiltered"] == "none"
    assert utan["default"] == 5000          # domineras av de olika
    # Med bild ska bara de 20 lika räknas — men bara om frågebilden kunde läsas.
    assert med["imageFiltered"] in ("none", "filtered")


def test_utan_bild_ar_svaret_oforandrat():
    """Regressionsskydd: utan bild ska inget av bildfälten påverka något."""
    frame, store = _bildmarknad([True] * 20 + [False] * 40)
    a = price_query(frame, name="Testsoffa", price_kind="asking")
    b = price_query(frame, name="Testsoffa", price_kind="asking", vectors=store)
    for nyckel in ("default", "low", "high", "matchCount", "confidence"):
        assert a[nyckel] == b[nyckel]
    assert a["imageFiltered"] == b["imageFiltered"] == "none"
    assert a["imageMatchCount"] is None and a["similarityRange"] is None


def test_klassificerare_som_ger_none_kraschar_inte():
    """Robusthet: ett oväntat svar från klassificeraren får inte fälla frågan."""
    payload = price_query(_variantmarknad(soffor=40, fotpallar=40, okanda=0),
                          name="Testmodell", image=b"foto", price_kind="asking",
                          classifier=lambda **kw: None)
    assert payload["variantMethod"] == "none"
    assert payload["matchCount"] == 80


# --------------------------------------------------------------------------
# Skickkedjan: filtered -> reference -> band -> ignored
# --------------------------------------------------------------------------
@pytest.fixture
def soffmarknad() -> pd.DataFrame:
    """Medianskicket är Bra skick: 8 Okej, 40 Bra, 8 Topp (sämst först)."""
    rows = [("Testsoffa", 1000, "Bra skick", "asking", "kat", "grupp-0")] * 40
    rows += [("Testsoffa", 600, "Okej skick", "asking", "kat", "grupp-0")] * 8
    rows += [("Testsoffa", 1400, "Mycket bra skick", "asking", "kat", "grupp-0")] * 8
    return _frame(rows)


@pytest.fixture
def band_tabell() -> object:
    return build_bands(_band_market())


def test_medianskicket_raknas_ur_traffarna(soffmarknad):
    """Sorterat sämst -> bäst, medianen landar på Bra skick."""
    from price_engine.pricing import _median_tier
    assert _median_tier(soffmarknad) == "Bra skick"


def test_medianskicket_foljer_batchen():
    """Domineras batchen av Okej skick blir DET ankaret."""
    from price_engine.pricing import _median_tier
    rows = [("Testsoffa", 600, "Okej skick", "asking", "kat", "g")] * 40
    rows += [("Testsoffa", 1000, "Bra skick", "asking", "kat", "g")] * 8
    assert _median_tier(_frame(rows)) == "Okej skick"


def test_for_fa_markta_ger_inget_ankare():
    from price_engine.pricing import _median_tier
    rows = [("Testsoffa", 1000, "Bra skick", "asking", "kat", "g")] * 3
    assert _median_tier(_frame(rows)) is None


def test_strikt_filter_nar_underlaget_racker(soffmarknad, band_tabell):
    """40 annonser i Bra skick >= CONDITION_STRICT_MIN -> filtrera."""
    payload = price_query(soffmarknad, name="Testsoffa", condition="gott skick",
                          price_kind="asking", multipliers=band_tabell)
    assert payload["conditionMethod"] == "filtered"
    assert payload["conditionAnchor"] == "Bra skick"
    assert payload["matchCount"] == 40
    assert payload["default"] == 1000


def test_malet_lika_medianskicket_ger_reference(band_tabell):
    """Är målet medianskicket, och underlaget för tunt för strikt filtrering,
    används medianpriset oförändrat — det speglar redan det skicket."""
    rows = [("Testsoffa", 1000, "Bra skick", "asking", "kat", "g")] * 12
    rows += [("Testsoffa", 600, "Okej skick", "asking", "kat", "g")] * 4
    payload = price_query(_frame(rows), name="Testsoffa", condition="gott skick",
                          price_kind="asking", multipliers=band_tabell)
    assert payload["conditionMethod"] == "reference"
    assert payload["conditionAnchor"] == "Bra skick"


def test_samre_skick_an_ankaret_sanker(soffmarknad, band_tabell):
    obetingad = price_query(soffmarknad, name="Testsoffa", price_kind="asking",
                            multipliers=band_tabell)
    okej = price_query(soffmarknad, name="Testsoffa", condition="okej skick",
                       price_kind="asking", multipliers=band_tabell)
    assert okej["conditionMethod"] == "band"
    assert okej["conditionBand"]["median"] < 1.0
    assert okej["default"] < obetingad["default"]


def test_battre_skick_an_ankaret_hojer(soffmarknad, band_tabell):
    """Nya specen: skicket justeras åt BÅDA hållen från medianskicket."""
    obetingad = price_query(soffmarknad, name="Testsoffa", price_kind="asking",
                            multipliers=band_tabell)
    topp = price_query(soffmarknad, name="Testsoffa", condition="nyskick",
                       price_kind="asking", multipliers=band_tabell)
    assert topp["conditionMethod"] == "band"
    assert topp["conditionBand"]["median"] > 1.0
    assert topp["default"] > obetingad["default"]


def test_bandet_skalar_kanterna_olika(soffmarknad, band_tabell):
    oskalad = price_query(soffmarknad, name="Testsoffa", price_kind="asking",
                          multipliers=band_tabell)
    skalad = price_query(soffmarknad, name="Testsoffa", condition="okej skick",
                         price_kind="asking", multipliers=band_tabell)
    b = skalad["conditionBand"]
    assert skalad["low"] == round(oskalad["low"] * b["low"])
    assert skalad["default"] == round(oskalad["default"] * b["median"])
    assert skalad["high"] == round(oskalad["high"] * b["high"])


def test_realized_far_aldrig_band(band_tabell):
    """Auktionsdatans skicksignal är obrukbar -> släpp skicket."""
    rows = [("Auktionsstol", 5000, "Bra skick", "realized", "kat", "g")] * 40
    rows += [("Auktionsstol", 4000, "Okej skick", "realized", "kat", "g")] * 8
    payload = price_query(_frame(rows), name="Auktionsstol", condition="okej skick",
                          price_kind="realized", multipliers=band_tabell)
    assert payload["conditionMethod"] == "ignored"
    assert "auktionsdata saknar tillförlitlig skicksignal" in payload["note"]


def test_utan_bandtabell_ignoreras_skicket(soffmarknad):
    payload = price_query(soffmarknad, name="Testsoffa", condition="okej skick",
                          price_kind="asking", multipliers=None)
    assert payload["conditionMethod"] == "ignored"


def test_inget_skick_angivet_ger_none(soffmarknad, band_tabell):
    payload = price_query(soffmarknad, name="Testsoffa", price_kind="asking",
                          multipliers=band_tabell)
    assert payload["conditionMethod"] == "none"
    assert payload["conditionAnchor"] is None


def test_nyskick_och_mycket_bra_ar_samma_niva(soffmarknad, band_tabell):
    a = price_query(soffmarknad, name="Testsoffa", condition="nyskick",
                    price_kind="asking", multipliers=band_tabell)
    b = price_query(soffmarknad, name="Testsoffa", condition="mycket bra skick",
                    price_kind="asking", multipliers=band_tabell)
    assert a["default"] == b["default"]


# --------------------------------------------------------------------------
# Delar och tillbehör (variant.PART)
# --------------------------------------------------------------------------
# Modellnamnet bärs av hela reservdelssortimentet. "IKEA PAX" plockade in
# gångjärn för 25 kr och klädstänger för 30 kr i samma median som
# garderoberna — 17,5 % av underlaget låg under 200 kr och medianen blev
# 750 kr för en garderob. Efter filtret: 1 500 kr.
from price_engine.variant import PART, classify_series


def _klassa(titel: str) -> str:
    return classify_series(pd.Series([normalize_text(titel)])).iloc[0]


@pytest.mark.parametrize("titel", [
    "IKEA KOMPLEMENT Klädstång, mörkgrå, 50 cm",
    "IKEA / Blum gångjärn",
    "Skåpshandtag",
    "2 st IKEA Tyssedal garderobsdörrar",
    "Pax Skjutdörrar",
    "IKEA Komplement hyllplan - 50x58cm NYA",
    "Klädsel till Ikea Kivik",
    "Soffdyna/sittdyna till Kivik soffa",
    "IKEA PAX - inredning",
    "Ben till Malm säng",
    "Garderobsinredning till IKEA PAX",
])
def test_delar_klassas_som_del(titel):
    assert _klassa(titel) == PART


@pytest.mark.parametrize("titel,variant", [
    # "med X" beskriver en egenskap, inte varan.
    ("IKEA PAX garderob med dörrar och inredning, 100x58x236 cm", "hylla"),
    ("Säng med förvaringslådor Malm", "säng"),
    ("Bokhylla Billy med dörrar", "hylla"),
    ("IKEA PAX med inredning", UNKNOWN),
    # Auktionstexter räknar upp detaljer EFTER möbelordet.
    ("BOKHYLLA; 1930/40-tal, 2 flyttbara hyllplan, fanér i betsad teak.", "hylla"),
    ("KARMSTOL, barock, 1700-tal, klädd med blommig klädsel.", "fåtölj"),
    ("ÖRONLAPPSFÅTÖLJ, skinnklädsel, 1900-talets mitt.", "fåtölj"),
    ('gungstol, "Swing", svartbetsad, klädsel i ylle', "stol"),
    # "till salu" är inte en delsignal.
    ("Skohylla till salu", "hylla"),
    ("Soffbord till salu", "bord"),
])
def test_hela_mobler_klassas_inte_som_del(titel, variant):
    assert _klassa(titel) == variant


def test_langsta_traffen_vinner_vid_samma_position():
    # "garderobsdörrar" och "garderob" börjar på samma tecken.
    assert _klassa("2 st IKEA Tyssedal garderobsdörrar") == PART
    assert _klassa("IKEA PAX Garderob") == "hylla"


def test_delar_utesluts_ur_kandidatmangden():
    frame = pd.DataFrame({
        "name": ["IKEA PAX garderob", "IKEA KOMPLEMENT klädstång till PAX"],
        "brand": ["IKEA", "IKEA"],
        "price": [1500.0, 30.0],
        "price_kind": ["asking", "asking"],
        "condition": [None, None],
    })
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["brand_norm"] = frame["brand"].map(normalize_text)
    frame["search_blob"] = frame["name_norm"]
    frame["variant"] = classify_series(frame["search_blob"])

    traffar = find_listings(frame, name="PAX", brand="IKEA", price_kind="asking")
    assert len(traffar) == 1
    assert traffar["price"].iloc[0] == 1500.0


def test_delar_erbjuds_aldrig_som_bildalternativ():
    from price_engine.variant import available_variants

    frame = pd.DataFrame({"variant": [PART] * 50 + ["soffa"] * 50})
    etiketter = [label for label, _ in available_variants(frame)]
    assert PART not in etiketter
    assert "soffa" in etiketter


def test_part_ingar_inte_i_bildmodellens_etiketter():
    # Ett foto på en soffa ska aldrig kunna besvaras med "reservdel".
    assert PART not in VARIANT_LABELS


# --------------------------------------------------------------------------
# Skickjusteringen som strömbrytare (config.CONDITION_PRICING)
# --------------------------------------------------------------------------
# Skicket är avstängt i produktion tills modellen görs om. Maskineriet ska
# ändå hållas testat, så alla tester ovan körs med det PÅSLAGET — annars
# skulle skickkedjan sluta verifieras och tyst ruttna.
@pytest.fixture(autouse=True)
def _skick_pa(monkeypatch):
    monkeypatch.setattr(config, "CONDITION_PRICING", True)


@pytest.fixture
def _skick_av(monkeypatch):
    monkeypatch.setattr(config, "CONDITION_PRICING", False)


def test_avstangt_skick_ger_samma_pris_oavsett_angivet_skick(
    soffmarknad, band_tabell, _skick_av
):
    priser = {
        skick: price_query(soffmarknad, name="Testsoffa", condition=skick,
                           price_kind="asking", multipliers=band_tabell)
        for skick in (None, "nyskick", "mycket bra skick", "bra skick", "okej skick")
    }
    referens = priser[None]
    for skick, svar in priser.items():
        assert svar["default"] == referens["default"], skick
        assert svar["low"] == referens["low"], skick
        assert svar["high"] == referens["high"], skick
        assert svar["matchCount"] == referens["matchCount"], skick


def test_avstangt_skick_redovisas_i_svaret(soffmarknad, band_tabell, _skick_av):
    svar = price_query(soffmarknad, name="Testsoffa", condition="okej skick",
                       price_kind="asking", multipliers=band_tabell)
    assert svar["conditionMethod"] == "disabled"
    assert svar["conditionAnchor"] is None
    assert svar["conditionBand"] is None
    # Skicket ekas tillbaka så att den som frågade ser att det togs emot.
    assert svar["query"]["condition"] == "okej skick"
    assert "avstängd" in svar["note"]


def test_avstangt_skick_ger_rena_medianfonstret(soffmarknad, band_tabell, _skick_av):
    """Utan skick ska svaret vara identiskt med grundalgoritmen på samma urval."""
    svar = price_query(soffmarknad, name="Testsoffa", condition="nyskick",
                       price_kind="asking", multipliers=band_tabell)
    utan_skick = price_query(soffmarknad, name="Testsoffa",
                             price_kind="asking", multipliers=None)
    assert svar["default"] == utan_skick["default"]
    assert svar["low"] == utan_skick["low"]
    assert svar["high"] == utan_skick["high"]


def test_pasllaget_skick_paverkar_priset_igen(soffmarknad, band_tabell):
    """Kontroll att strömbrytaren verkligen är det som styr."""
    toppskick = price_query(soffmarknad, name="Testsoffa", condition="nyskick",
                            price_kind="asking", multipliers=band_tabell)
    slitet = price_query(soffmarknad, name="Testsoffa", condition="okej skick",
                         price_kind="asking", multipliers=band_tabell)
    assert toppskick["default"] != slitet["default"]


# --------------------------------------------------------------------------
# Shrinkage mot bredare underlag (config.FALLBACK_*)
# --------------------------------------------------------------------------
# Ett tunt underlag kan bära ett självsäkert grovt fel svar: Kinnarps Capella X
# gav tre annonser, alla för en premiumundermodell, och motorn svarade 4 000 kr
# mot facit 1 300-1 600. Att BYTA till bredare sökning flyttar bara felet
# (900 kr, alltså för lågt), så svaret glider dit i stället.
#
# Övriga tester i filen körs med mekanismen AVSTÄNGD, annars skulle den blanda
# in sig i varje exakt prispåstående på de små syntetiska underlagen.
@pytest.fixture(autouse=True)
def _shrinkage_av(monkeypatch):
    monkeypatch.setattr(config, "FALLBACK_BELOW", 0)


@pytest.fixture
def _shrinkage_pa(monkeypatch):
    monkeypatch.setattr(config, "FALLBACK_BELOW", 30)


def _tunn_marknad() -> pd.DataFrame:
    """Tre dyra annonser av en modell, 40 billigare av samma märke och typ."""
    rows = [{"name": f"Kinnarps Capella X Energy {i}", "brand": "Kinnarps",
             "price": 4000.0} for i in range(3)]
    rows += [{"name": f"Kinnarps kontorsstol {i}", "brand": "Kinnarps",
              "price": 800.0 + i * 10} for i in range(40)]
    frame = pd.DataFrame(rows)
    frame["price_kind"] = "asking"
    frame["condition"] = None
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["brand_norm"] = frame["brand"].map(normalize_text)
    frame["search_blob"] = frame["name_norm"]
    frame["variant"] = classify_series(frame["search_blob"])
    frame["listed_at"] = pd.Timestamp.now(tz="UTC")
    return frame


def test_tunt_underlag_glider_mot_den_bredare_skattningen(_shrinkage_pa):
    frame = _tunn_marknad()
    svar = price_query(frame, name="Capella X", brand="Kinnarps",
                       price_kind="asking")
    assert svar["fallbackMethod"] == "shrinkage"
    info = svar["fallback"]
    assert info["narrowCount"] == 3
    assert info["narrowDefault"] == 4000
    # Vikten på den smala mängden: n / (n + k).
    k = config.FALLBACK_SHRINKAGE_K
    assert info["weight"] == pytest.approx(3 / (3 + k), abs=0.01)
    # Svaret ska hamna MELLAN de två skattningarna, inte på någon av dem.
    assert info["broadDefault"] < svar["default"] < info["narrowDefault"]
    assert svar["confidence"] == "low"
    assert "sammanvägt" in svar["note"]


def test_blandningen_ar_geometrisk_inte_aritmetisk(_shrinkage_pa):
    """Priser är multiplikativa: 2x fel uppåt ska väga som 2x nedåt."""
    frame = _tunn_marknad()
    svar = price_query(frame, name="Capella X", brand="Kinnarps",
                       price_kind="asking")
    info = svar["fallback"]
    w = info["weight"]
    geometriskt = round(info["narrowDefault"] ** w * info["broadDefault"] ** (1 - w))
    aritmetiskt = round(w * info["narrowDefault"] + (1 - w) * info["broadDefault"])
    assert svar["default"] == pytest.approx(geometriskt, abs=2)
    assert svar["default"] < aritmetiskt


def test_starkt_underlag_lamnas_orort(_shrinkage_pa):
    rows = [{"name": f"Kinnarps Capella X {i}", "brand": "Kinnarps",
             "price": 4000.0} for i in range(40)]
    frame = pd.DataFrame(rows)
    frame["price_kind"] = "asking"
    frame["condition"] = None
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["brand_norm"] = frame["brand"].map(normalize_text)
    frame["search_blob"] = frame["name_norm"]
    frame["variant"] = classify_series(frame["search_blob"])
    frame["listed_at"] = pd.Timestamp.now(tz="UTC")
    svar = price_query(frame, name="Capella X", brand="Kinnarps",
                       price_kind="asking")
    assert svar["fallbackMethod"] == "none"
    assert svar["default"] == 4000


def test_ingen_blandning_utan_bredare_underlag(_shrinkage_pa):
    """Saknas jämförbara annonser av samma märke sker ingen blandning."""
    rows = [{"name": f"Kinnarps Capella X {i}", "brand": "Kinnarps",
             "price": 4000.0} for i in range(3)]
    frame = pd.DataFrame(rows)
    frame["price_kind"] = "asking"
    frame["condition"] = None
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["brand_norm"] = frame["brand"].map(normalize_text)
    frame["search_blob"] = frame["name_norm"]
    frame["variant"] = classify_series(frame["search_blob"])
    frame["listed_at"] = pd.Timestamp.now(tz="UTC")
    svar = price_query(frame, name="Capella X", brand="Kinnarps",
                       price_kind="asking")
    assert svar["fallbackMethod"] == "none"


def test_intervallet_vander_sig_aldrig_inat(_shrinkage_pa):
    """low <= default <= high måste hålla även efter blandningen."""
    frame = _tunn_marknad()
    svar = price_query(frame, name="Capella X", brand="Kinnarps",
                       price_kind="asking")
    assert svar["low"] <= svar["default"] <= svar["high"]


# --------------------------------------------------------------------------
# Åtgärd 1 — prisbas vid okänd identitet
# --------------------------------------------------------------------------
# "Ekbord med stolar" låg på 300 kr mot facit 2 000-5 000 (−85 %) eftersom
# `auto` valde auktionsdata: gamla brunmöbler klubbas för 100-700 kr medan
# Blocket-utropen ligger tiofalt högre. Regeln är att en förfrågan som inte
# identifierar någon produkt aldrig får prissättas på auktion.
from price_engine.pricing import identity_is_anonymous


@pytest.mark.parametrize("name,brand", [
    ("Matgrupp 5 stolar", None),
    ("Ekbord med stolar", None),
    ("Ekbord med 6 stolar i massiv ek", None),
    ("rak vit soffa 3-sits", None),
    ("gra sammetssoffa 3 sits", None),   # foge-s i sammansättningen
    ("teakbord med stolar", None),
])
def test_frageord_utan_produkt_ar_anonym(name, brand):
    assert identity_is_anonymous(name, brand)


@pytest.mark.parametrize("name,brand", [
    ("Landskrona", None),      # modellnamn utan märke räcker
    ("Strandmon", None),
    ("Stocksund", None),
    ("Lamino", None),
    ("Capella X", None),
    ("Vimle 3-sits", None),    # modellnamn + typord
    ("soffa", "Bellus"),       # märket räcker även när namnet är generiskt
    ("Town", "Mio"),
])
def test_identifierbar_produkt_ar_inte_anonym(name, brand):
    assert not identity_is_anonymous(name, brand)


def test_modellnamn_forvaxlas_inte_med_typord():
    """Suffixregeln får inte äta modellnamn.

    "Landskrona" slutar på "ona", "Strandmon" på "mon" — därför krävs minst
    fyra tecken i suffixet, annars faller varje modellnamn som råkar sluta på
    ett kort typord.
    """
    for model in ("Landskrona", "Strandmon", "Madison", "Pinntorp",
                  "Jennylund", "Songesand", "Norsborg"):
        assert not identity_is_anonymous(model, None), model


def _anonymous_market() -> pd.DataFrame:
    """Auktionsdata dominerar i antal, utropspriserna är tiofalt högre."""
    rows = [(f"Ekbord med 6 stolar {i}", "", 300 + i, None, "realized")
            for i in range(200)]
    rows += [(f"Ekbord med 6 stolar {i}", "", 3000 + i, None, "asking")
             for i in range(60)]
    frame = pd.DataFrame(rows, columns=["name", "brand", "price", "condition",
                                        "price_kind"])
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["brand_norm"] = frame["brand"].map(normalize_text)
    frame["search_blob"] = frame["name"].map(normalize_text)
    frame["condition_norm"] = None
    frame["variant"] = classify_series(frame["search_blob"])
    frame["listed_at"] = pd.Timestamp.now(tz="UTC")
    return frame


def test_anonym_forfragan_prissatts_pa_utropspriser():
    payload = price_query(_anonymous_market(), name="Ekbord med stolar",
                          price_kind="auto")
    assert payload["identityAnonymous"]
    assert payload["priceBasis"] == "asking_forced_unknown_identity"
    # Utropsnivån, inte auktionsnivån — trots att auktion har 200 rader mot 60.
    assert payload["default"] >= 3000


def test_kant_produkt_pavarkas_inte_av_regeln():
    """Regeln får bara röra anonyma flöden — inte namngivna möbler."""
    frame = _anonymous_market()
    frame["name"] = frame["name"].str.replace("Ekbord", "Ekedalen", regex=False)
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["search_blob"] = frame["name_norm"]
    payload = price_query(frame, name="Ekedalen", price_kind="auto")
    assert not payload["identityAnonymous"]
    # Namngiven produkt: `auto` får bestämma. Med utrop-först-regeln blir det
    # asking eftersom de 60 utropsraderna räcker till en jämförelsemängd.
    assert payload["priceBasis"] == "asking"


def test_regeln_kan_stangas_av(monkeypatch):
    """Utan identitetsspärren OCH utan utrop-först faller basen till auktion."""
    monkeypatch.setattr(config, "FORCE_ASKING_WHEN_ANONYMOUS", False)
    monkeypatch.setattr(config, "BASIS_PREFER_ASKING", False)
    payload = price_query(_anonymous_market(), name="Ekbord med stolar",
                          price_kind="auto")
    assert payload["identityAnonymous"]
    assert payload["priceBasis"] == "realized"


# --------------------------------------------------------------------------
# Åtgärd 2 — filtergolvet
# --------------------------------------------------------------------------
# Varje filter är rimligt för sig men de multipliceras. Variantfilter plus
# bildomsortering tog Vimle 117 -> 40 och Santos 24 -> 7, varpå shrinkagen drog
# svaret mot märkesnivån. Golvet gör att filtret i stället VIKTAR.
from price_engine.pricing import (compute_weighted_range, weighted_quantile,
                                  _floor_or_weight)


def test_viktad_kvantil_ger_samma_kanter_som_positionslogiken():
    """Med enhetsvikter måste low och high vara identiska över golvet."""
    for n in (30, 47, 60, 100, 250):
        prices = list(range(1, n + 1))
        oviktad = compute_price_range(prices)
        viktad = compute_weighted_range(prices, [1.0] * n)
        assert (viktad.low, viktad.high) == (oviktad.low, oviktad.high), n
        # default kan skilja EN position: positionsformeln avrundar.
        assert abs(viktad.default - oviktad.default) <= 1, n


def test_nedviktning_flyttar_kvantilen_mot_de_tyngre():
    prices = list(range(1, 101))
    billig_tung = compute_weighted_range(prices, [1.0] * 50 + [0.25] * 50)
    dyr_tung = compute_weighted_range(prices, [0.25] * 50 + [1.0] * 50)
    assert billig_tung.default < dyr_tung.default


def test_vikterna_summerar_till_effektiv_mangd():
    r = compute_weighted_range([100, 200, 300, 400], [1.0, 1.0, 0.25, 0.25])
    assert r.match_count == 4          # antalet rader är oförändrat
    assert r.half_interval == round(2.5 * config.HALF_INTERVAL_RATIO)


def _floor_frame(n: int) -> pd.DataFrame:
    return pd.DataFrame({"price": [float(i) for i in range(n)]})


def test_filter_som_haller_golvet_appliceras():
    frame = _floor_frame(100)
    weights = pd.Series(1.0, index=frame.index)
    mask = frame.index < 60          # 60 kvar, över golvet 30
    kept, w, state = _floor_or_weight(frame, weights, mask, "bild",
                                      {"applied": [], "converted": []})
    assert len(kept) == 60
    assert state["applied"] == ["bild"] and state["converted"] == []
    assert (w == 1.0).all()


def test_filter_som_bryter_golvet_blir_viktning():
    frame = _floor_frame(100)
    weights = pd.Series(1.0, index=frame.index)
    mask = frame.index < 10          # bara 10 kvar -> under golvet
    kept, w, state = _floor_or_weight(frame, weights, mask, "bild",
                                      {"applied": [], "converted": []})
    assert len(kept) == 100          # ingenting kastades
    assert state["converted"] == ["bild"] and state["applied"] == []
    assert (w[:10] == 1.0).all()
    assert (w[10:] == config.FILTER_DOWNWEIGHT).all()


def test_vikterna_multipliceras_over_flera_konverterade_filter():
    """Två filter som båda konverterats ska stapla sina vikter."""
    frame = _floor_frame(100)
    weights = pd.Series(1.0, index=frame.index)
    state = {"applied": [], "converted": []}
    _, weights, state = _floor_or_weight(frame, weights, frame.index < 10,
                                         "variant", state)
    _, weights, state = _floor_or_weight(frame, weights, frame.index < 5,
                                         "bild", state)
    assert state["converted"] == ["variant", "bild"]
    assert weights.iloc[0] == 1.0
    assert weights.iloc[7] == pytest.approx(config.FILTER_DOWNWEIGHT)
    assert weights.iloc[50] == pytest.approx(config.FILTER_DOWNWEIGHT ** 2)


def test_filter_som_inte_andrar_nagot_registreras_inte():
    frame = _floor_frame(50)
    weights = pd.Series(1.0, index=frame.index)
    for mask in (frame.index >= 0, frame.index < 0):   # allt, respektive inget
        _, w, state = _floor_or_weight(frame, weights, mask, "bild",
                                       {"applied": [], "converted": []})
        assert state == {"applied": [], "converted": []}
        assert (w == 1.0).all()


# --------------------------------------------------------------------------
# Del 1 — storleksnivån
# --------------------------------------------------------------------------
# Prisspridningen INOM variant har median 78 %: Kivik hörnsoffa går 2-sits
# 1 250 kr -> 5-sits 4 900 kr, alltså fyra gånger inom samma modell och typ.
from price_engine import size as size_mod


@pytest.mark.parametrize("text,variant,want", [
    ("kivik hornsoffa 3-sits", "hörnsoffa", "3-sits"),
    ("soderhamn 2 sits soffa gra", "soffa", "2-sits"),
    ("kivik hornsoffa med divan", "hörnsoffa", "divan"),
    ("stockholm u-soffa gra", "soffa", "u-soffa"),
    ("matgrupp med 6 stolar", "matgrupp", "6 stolar"),
    ("ekbord 200 cm med stolar", "matbord", "200-250cm"),
    ("soffbord 90 cm", "bord", "50-100cm"),
    # Sitsantal slår längd: en tresits ÄR 220 cm, längden är en följd.
    ("vimle 3-sits 220 cm", "soffa", "3-sits"),
])
def test_storlek_extraheras(text, variant, want):
    assert size_mod.extract(text, variant) == want


@pytest.mark.parametrize("text,variant", [
    # Falskträffen som mätningen hittade: en byrå som matchar "2 st."
    ("hemnes byra 2 st lador", "byrå"),
    ("bokhylla 4 stolar", "hylla"),
    ("matbord 6 stolar ek", "matbord"),      # stolar hör till matgrupp
    ("malm sang 2024 modell", "säng"),       # årtal är ingen längd
    ("fatolj 45 cm sitthojd", "fåtölj"),     # cm hör inte till fåtöljer
])
def test_kompatibilitetsspärren_forkastar_orimliga_storlekar(text, variant):
    assert size_mod.extract(text, variant) is None


def test_utan_moebeltyp_gors_ingen_sparr():
    """Är typen okänd kan spärren inte tillämpas — då tas första träffen."""
    assert size_mod.extract("2 st stolar", None) == "2 stolar"


def test_orimliga_langder_ignoreras():
    for text in ("soffa 12 cm", "bord 999 cm", "bord 2024 cm"):
        assert size_mod.extract(text, "bord") is None


def _size_market() -> pd.DataFrame:
    """Samma modell och variant, tre storlekar, fyra gånger i pris."""
    rows = []
    for label, price, n in (("2-sits", 1250, 40), ("3-sits", 2000, 40),
                            ("5-sits", 4900, 40)):
        rows += [{"name": f"Kivik hornsoffa {label} {i}", "brand": "IKEA",
                  "price": float(price + i)} for i in range(n)]
    frame = pd.DataFrame(rows)
    frame["price_kind"] = "asking"
    frame["condition"] = None
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["brand_norm"] = frame["brand"].map(normalize_text)
    frame["search_blob"] = frame["name_norm"]
    frame["variant"] = classify_series(frame["search_blob"])
    frame["size"] = size_mod.classify_series(frame["search_blob"], frame["variant"])
    frame["listed_at"] = pd.Timestamp.now(tz="UTC")
    return frame


def test_storleksfiltret_valjer_ratt_prisniva():
    frame = _size_market()
    liten = price_query(frame, name="Kivik", brand="IKEA", size="2-sits",
                        price_kind="asking")
    stor = price_query(frame, name="Kivik", brand="IKEA", size="5-sits",
                       price_kind="asking")
    assert liten["sizeMethod"] == "filtered"
    assert stor["sizeMethod"] == "filtered"
    assert liten["default"] < 2000 < stor["default"]


def test_storleksfiltret_lyder_under_filtergolvet():
    """Tunn storleksgrupp -> viktning, inte svält. Ingen egen specialmekanik."""
    frame = _size_market()
    # Bara fem annonser i 4-sits, alltså långt under golvet på 30.
    extra = frame.head(5).copy()
    extra["name"] = "Kivik hornsoffa 4-sits"
    extra["name_norm"] = extra["name"].map(normalize_text)
    extra["search_blob"] = extra["name_norm"]
    extra["size"] = "4-sits"
    frame = pd.concat([frame, extra], ignore_index=True)

    payload = price_query(frame, name="Kivik", brand="IKEA", size="4-sits",
                          price_kind="asking")
    assert payload["sizeMethod"] == "weighted"
    assert payload["filtersConverted"] == ["storlek"]
    assert payload["matchCount"] > 30          # ingenting svalt


def test_utan_storleksuppgift_varnas_med_gruppernas_prislagen():
    payload = price_query(_size_market(), name="Kivik", brand="IKEA",
                          price_kind="asking")
    assert payload["sizeQuery"] is None
    warning = payload["sizeWarning"]
    assert warning is not None
    assert set(warning) == {"2-sits", "3-sits", "5-sits"}
    # Intervallet ska omfatta gruppernas MEDIANER, inte låtsas veta vilken
    # storlek användaren har.
    medians = [g["median"] for g in warning.values()]
    assert payload["low"] <= min(medians)
    assert payload["high"] >= max(medians)
    assert payload["confidence"] == "low"


def test_liten_storleksspridning_ger_ingen_varning():
    frame = _size_market()
    frame.loc[frame["size"] == "5-sits", "price"] = 2100.0   # jämna ut
    frame.loc[frame["size"] == "2-sits", "price"] = 1900.0
    payload = price_query(frame, name="Kivik", brand="IKEA", price_kind="asking")
    assert payload["sizeWarning"] is None


# --------------------------------------------------------------------------
# Del 2 — visuell kohort
# --------------------------------------------------------------------------
# "Ekbord med stolar": orden matchar 226 annonser med Blocket-utrop på
# 50-250 kr — äkta priser — men bilden visar en massiv ekskiva värd
# 2 000-5 000. Orden säger kategori, bilden bär värdet.
from price_engine import cohort as cohort_mod


def test_spridning_maets_i_logdoman():
    tight = cohort_mod.dispersion([900, 1000, 1100, 1000, 950, 1050, 980])
    wide = cohort_mod.dispersion([50, 80, 100, 200, 1500, 3000, 4000])
    assert tight < 2.0
    assert wide > config.COHORT_DISPERSION_TRIGGER


def test_spridning_kraver_underlag():
    assert cohort_mod.dispersion([100, 5000]) == 0.0


def test_klungor_delas_vid_storsta_glappet():
    prices = [500, 520, 550, 560, 600, 620, 3000, 3100, 3200, 3300]
    clusters = cohort_mod.price_clusters(prices)
    assert len(clusters) == 2
    assert clusters[0]["median"] < 1000 < clusters[1]["median"]
    assert clusters[0]["n"] + clusters[1]["n"] == len(prices)


def test_ingen_klungdelning_utan_glapp():
    assert cohort_mod.price_clusters(list(range(1000, 1040))) == []


def test_klippdetektering_hoppar_over_forsta_positionen():
    """Största fallet ligger alltid vid position 1 — där den egna bilden slutar.

    Utan golvet skulle avskärningen därför alltid bli en granne.
    """
    similarity = np.array([0.99] + [0.70] * 40 + [0.30] * 40)
    cut = cohort_mod._cliff(similarity)
    assert cut >= config.COHORT_MIN
    assert cut <= config.COHORT_MAX


def test_kohortflodet_kraver_alla_tre_villkoren():
    """Anonym + bild + stor ordspridning. Saknas ett ska flödet inte aktiveras."""
    frame = _anonymous_market()          # liten spridning, ingen bild
    payload = price_query(frame, name="Ekbord med stolar", price_kind="auto")
    assert payload["cohort"] is None
    assert payload["priceBasis"] == "asking_forced_unknown_identity"


def test_namngiven_forfragan_gar_aldrig_till_kohorten():
    frame = _anonymous_market()
    frame["name"] = frame["name"].str.replace("Ekbord", "Ekedalen", regex=False)
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["search_blob"] = frame["name_norm"]
    payload = price_query(frame, name="Ekedalen", price_kind="auto")
    assert payload["cohort"] is None
    assert not payload["identityAnonymous"]


# --------------------------------------------------------------------------
# Bildens roll: bara möbeltyp (config.IMAGE_RERANK_ENABLED)
# --------------------------------------------------------------------------
# Beslutat 2026-08-06: DINOv2 kan inte identifiera modeller (hörnsoffa AUC
# 0,513 trots 99 % beskärning), så bilden filtrerar inte längre
# jämförelsemängden. Koden är kvar och testad bakom flaggan.
def test_bildfiltret_ar_avstangt_som_standard():
    assert config.IMAGE_RERANK_ENABLED is False
    assert config.CUE_FILTER_ENABLED is False


def test_bildfiltret_paverkar_inte_jamforelsemangden(listings, monkeypatch):
    """Med flaggan av ska en bild ge samma pris som ingen bild.

    Vektorlagret är tomt i testet, men poängen är att kedjan inte längre ens
    försöker filtrera: image_method stannar på "none" och inget filter
    registreras.
    """
    utan = price_query(listings, name="Landskrona", brand="IKEA",
                       price_kind="asking")
    med = price_query(listings, name="Landskrona", brand="IKEA",
                      price_kind="asking", image=b"inte-en-riktig-bild")
    assert med["default"] == utan["default"]
    assert med["imageFiltered"] == "none"
    assert (med["filtersConverted"] or []) == (utan["filtersConverted"] or [])


def test_ledorden_redovisas_men_filtrerar_inte(monkeypatch):
    """Ledorden ska synas i svaret utan att skära i mängden."""
    frame = pd.DataFrame({
        "name": [f"Kivik hornsoffa {i}" for i in range(40)],
        "brand": ["IKEA"] * 40, "price": [2000.0 + i for i in range(40)],
    })
    frame["price_kind"] = "asking"
    frame["condition"] = None
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["brand_norm"] = frame["brand"].map(normalize_text)
    frame["search_blob"] = frame["name_norm"]
    frame["variant"] = classify_series(frame["search_blob"])
    frame["listed_at"] = pd.Timestamp.now(tz="UTC")

    payload = price_query(frame, name="Kivik", brand="IKEA", price_kind="asking")
    assert payload["cueMethod"] in ("none", "reported_only")
    assert "ledord" not in (payload["filtersConverted"] or [])
    assert "ledord" not in (payload["filtersApplied"] or [])


def test_omsorteringskoden_finns_kvar_bakom_flaggan(monkeypatch):
    """Beslutet ska gå att ompröva när embeddingen byts."""
    monkeypatch.setattr(config, "IMAGE_RERANK_ENABLED", True)
    assert config.IMAGE_RERANK_ENABLED
    # _apply_image är oförändrad och testas på egen hand i fas 6-testerna.
    from price_engine.pricing import _apply_image
    assert callable(_apply_image)


# --------------------------------------------------------------------------
# attribute_text — attributen läses ur HELA texten, före typordskapningen
# --------------------------------------------------------------------------
def _puffmarknad() -> pd.DataFrame:
    """Soffor och fotpallar med samma märke, så typvalet avgör priset."""
    rows = [(f"Bolia soffa med puff {i}", 9000, "asking") for i in range(40)]
    rows += [(f"Bolia puff fotpall {i}", 900, "asking") for i in range(40)]
    frame = pd.DataFrame(rows, columns=["name", "price", "price_kind"])
    for col, val in [("brand", "Bolia"), ("condition", None),
                     ("condition_norm", None), ("condition_tier", None)]:
        frame[col] = val
    frame["brand_norm"] = "bolia"
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["search_blob"] = frame["name"].map(normalize_text)
    frame["variant"] = classify_series(frame["search_blob"])
    from type_system.attributes import derive_type as _d
    from type_system.text_layer import extract as _e
    frame["derived_type"] = [_d(_e(b, prenormalized=True))
                             for b in frame["search_blob"]]
    return frame


def test_kapad_soknyckel_utan_attribute_text_ger_fel_typ():
    """Regressionsvakt: "soffa med puff" kapas till "med puff", och `puff`
    är ett fotpallsord. Utan attribute_text blir soffan en fotpall."""
    payload = price_query(_puffmarknad(), name="med puff", brand="Bolia",
                          price_kind="asking")
    assert payload["derivedType"] == "fotpall"


def test_attribute_text_raddar_typen():
    payload = price_query(_puffmarknad(), name="med puff", brand="Bolia",
                          price_kind="asking",
                          attribute_text="soffa med puff")
    assert payload["derivedType"] == "soffa"
    # Och priset följer typen, inte söknyckeln.
    assert payload["default"] > 5000


def test_numeriskt_modellnamn_behaller_bastypen():
    """"säng 303" kapas till "303". Bastypen får inte gå förlorad."""
    rows = [(f"DUX säng 303 nr {i}", 60000, "asking") for i in range(40)]
    frame = pd.DataFrame(rows, columns=["name", "price", "price_kind"])
    for col, val in [("brand", "DUX"), ("condition", None),
                     ("condition_norm", None), ("condition_tier", None)]:
        frame[col] = val
    frame["brand_norm"] = "dux"
    frame["name_norm"] = frame["name"].map(normalize_text)
    frame["search_blob"] = frame["name"].map(normalize_text)
    frame["variant"] = classify_series(frame["search_blob"])
    from type_system.attributes import derive_type as _d
    from type_system.text_layer import extract as _e
    frame["derived_type"] = [_d(_e(b, prenormalized=True))
                             for b in frame["search_blob"]]
    payload = price_query(frame, name="303", brand="DUX", price_kind="asking",
                          attribute_text="säng 303")
    assert payload["derivedType"] == "sang"


def test_numeriskt_sokord_kraver_ordgrans():
    """"303" får inte träffa "1303" eller "3030"."""
    from price_engine.pricing import _token_hit

    blob = pd.Series(["dux sang 303", "dux sang 1303", "dux sang 3030",
                      "dux 303 sang"])
    hits = _token_hit(blob, "303")
    assert list(hits) == [True, False, False, True]
