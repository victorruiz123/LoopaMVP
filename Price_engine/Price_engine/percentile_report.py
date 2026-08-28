"""Fas 4 — RAPPORT.md.

Sammanfattningen först, bortfallstratten näst. Allt som kan få en läsare att
övertolka resultatet står före resultatet, inte efter.
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd

import study_config as S


def _pct(value) -> str:
    return "—" if value is None or (isinstance(value, float) and np.isnan(value)) else f"p{value * 100:.0f}"


def _name(key: str) -> str:
    """Gruppnycklarna separeras med `|`, vilket spräcker markdown-tabeller."""
    return key.replace("|", " · ")


def _largest(groups: dict, n: int = 10) -> list:
    rows = []
    for track, label in (("track_a", "A"), ("track_b", "B")):
        for name, g in groups[track].items():
            if g.get("status") == "ok":
                rows.append((label, name, g))
    rows.sort(key=lambda r: r[2]["n_qualified"], reverse=True)
    return rows[:n]


def write_report(matched: pd.DataFrame, groups: dict, validation: dict,
                 figures: list) -> None:
    funnel = json.loads((S.STUDY_DIR / "funnel.json").read_text())
    gaps = groups["channel_gaps"]
    largest = _largest(groups)
    ok_a = sum(1 for g in groups["track_a"].values() if g.get("status") == "ok")
    ok_b = sum(1 for g in groups["track_b"].values() if g.get("status") == "ok")
    thin = sum(1 for t in ("track_a", "track_b") for g in groups[t].values()
               if g.get("status") == "insufficient_market")
    narrow = validation.get("narrowness", {})
    models = validation["models"]

    tradera_rank = matched[matched.source == "tradera"]["rank"].median()
    auctionet_rank = matched[matched.source == "auctionet"]["rank"].median()

    out = []
    add = out.append

    # ------------------------------------------------------------------
    add("# Percentilstudie — vilken percentil av utropspriserna säljer?\n")
    add("## Sammanfattning\n")
    add(f"Studien mäter var i utropsprisfördelningen affärer faktiskt sker, "
        f"med {len(matched):,} auktionsförsäljningar matchade mot samtida "
        f"utropsannonser (±{S.TIME_WINDOW_MONTHS} mån).\n")

    add("### 1. De tio största grupperna\n")
    add("| spår | grupp | säljpercentil | 95 % CI | n | budtröskel | källa |")
    add("|---|---|---|---|---|---|---|")
    for label, name, g in largest:
        add(f"| {label} | {_name(name)} | **{_pct(g['sell_percentile'])}** | "
            f"{_pct(g['ci_low'])}–{_pct(g['ci_high'])} | {g['n_qualified']:,} | "
            f"≥{g['bid_threshold']} | {g['source']} |")
    add("")

    add("### 2. Huvudfrågan: vilken percentil ska motorn föreslå?\n")
    rec = validation.get("narrow_recommendation") or {}
    if rec.get("overall") is not None:
        add(f"**Svaret motorn ska använda är {_pct(rec['overall'])}**, mätt på "
            f"de {rec['n']:,} försäljningar som kunde matchas SMALT — på märke "
            f"och möbeltyp. Det är den enda matchningsnivån som liknar "
            f"produktionens fråga, och därmed den enda vars percentil kan "
            f"överföras rakt av. Motorns nuvarande default är medelvärdet av "
            f"p40 och p50, alltså cirka p45.\n")
        segments = {k: v for k, v in rec["per_segment"].items()
                    if v["dimension"] == "märkesklass"}
        if segments:
            add("| segment | säljpercentil | okorrigerad | p25–p75 | n |")
            add("|---|---|---|---|---|")
            for name, seg in sorted(segments.items()):
                add(f"| {name} | **{_pct(seg['sell_percentile'])}** | "
                    f"{_pct(seg['sell_percentile_raw'])} | "
                    f"{_pct(seg['p25'])}–{_pct(seg['p75'])} | {seg['n']:,} |")
            add("")
            add("Kolumnen *okorrigerad* är auktionsdatan rå. Skillnaden mot "
                "den korrigerade är kanalgapet, och den är störst för low end "
                "— auktionerad IKEA är samlarvintage medan utropsannonserna är "
                "vardagsmöbler. Att de tre klasserna konvergerar EFTER "
                "korrigering är ett tecken på att gapet fångar en verklig "
                "kanaleffekt och inte bara brus.\n")
    if largest:
        values = [g["sell_percentile"] for _, _, g in largest]
        add(f"De breda gruppvärdena (tabellen ovan) ligger på "
            f"**{_pct(float(np.median(values)))}** i median, spann "
            f"{_pct(min(values))}–{_pct(max(values))}.\n")
    add(f"Den globala säljpercentilen över allt kvalificerat underlag är "
        f"{_pct(validation['global_sell_percentile'])}. Att den ligger klart "
        f"högre än gruppvärdena är ingen motsägelse utan två effekter: den är "
        f"okorrigerad för kanalgapet, och den domineras av Auctionet som står "
        f"för 96 % av försäljningarna. Gruppvärdena är kanalkorrigerade mot "
        f"Tradera, som ligger lägre.\n")

    add("### 3. Kanalgapet per märkesklass\n")
    add("| märkesklass | gap (Tradera − Auctionet) | grupper | n Tradera |")
    add("|---|---|---|---|")
    for tier in S.TIER_ORDER:
        g = gaps.get(tier, {})
        value = g.get("gap")
        add(f"| {tier} | {'—' if value is None else f'{value:+.3f}'} | "
            f"{g.get('groups', 0)} | {g.get('n_tradera', 0):,} |")
    add("")
    add(f"Låg-end: `{groups['low_end_gap_status']}`.\n")
    add(f"Rått, utan gruppkontroll, ligger Tradera på "
        f"{_pct(tradera_rank)} och Auctionet på {_pct(auctionet_rank)} — men "
        f"den skillnaden blandar ihop kanal och sortiment, och är därför inte "
        f"kanalgapet. Tabellen ovan jämför bara inom samma möbeltyp och "
        f"märkesklass.\n")

    add("### 4. De tre största förbehållen\n")
    add(f"**Percentilen är uppmätt mot en BREDARE fördelning än motorn "
        f"använder.** Studien matchar mest på möbeltyp och tid (median "
        f"{int(matched['match_count'].median()):,} annonser per jämförelse), "
        f"medan motorn matchar på märke och modell (~100 annonser). ")
    if narrow:
        add(f"Testat på {narrow['n']:,} försäljningar där båda nivåerna fanns: "
            f"medianrangen är {_pct(narrow['median_rank_narrow'])} smalt mot "
            f"{_pct(narrow['median_rank_broad'])} brett, medianavvikelsen "
            f"{narrow['median_abs_diff']:.3f} och korrelationen "
            f"{narrow['correlation']:.2f}. "
            f"{narrow['within_010'] * 100:.0f} % av försäljningarna hamnar "
            f"inom 10 percentilenheter i båda.\n")
    else:
        add("Underlaget räckte inte för att testa överföringen.\n")

    add(f"**Auktion är inte privatförsäljning.** Percentilerna överförs till "
        f"Blocket-världen som ett antagande. För budgetsegmentet är "
        f"auktionsdata en krycka oavsett korrektion — den riktiga "
        f"sanningskällan för low end är framtida Blocket-signaler "
        f"(omlistningskedjor, snapshots). Studien levererar design och premium "
        f"med hög trovärdighet och low end med tydligt märkta förbehåll.\n")

    add(f"**Ingen såld/osåld-signal finns.** Datan innehåller bara sålda "
        f"objekt: Auctionet har noll rader med noll bud, och Traderas "
        f"noll-budsrader är fastprisköp, inte misslyckade auktioner. Studien "
        f"kan säga var affärer sker, aldrig var de uteblir.\n")

    add("---\n")

    # ------------------------------------------------------------------
    add("## Bortfallstratt\n")
    add("| steg | tradera | auctionet | totalt |")
    add("|---|---|---|---|")
    for row in funnel:
        add(f"| {row['steg']} | {row['tradera']:,} | {row['auctionet']:,} | "
            f"{row['totalt']:,} |")
    add("")

    # ------------------------------------------------------------------
    add("## Metod\n")
    add(f"**Sök först, mät sen.** För varje försäljning hämtas de "
        f"utropsannonser som var aktuella ±{S.TIME_WINDOW_MONTHS} månader "
        f"kring försäljningsdatumet, via motorns egen `find_listings`. "
        f"Percentilrangen är andelen av dem som låg under slutpriset.\n")
    add(f"**Cirkelbrytaren.** Prisnivån (låg/mellan/hög) sätts av medianen i "
        f"den MATCHADE UTROPSFÖRDELNINGEN, aldrig av objektets slutpris. "
        f"Gruppen klassas alltså på vad marknaden begär för liknande möbler — "
        f"samma information motorn har vid förfrågan — och mäts på vad som "
        f"faktiskt betalades.\n")
    add(f"**Budspärr.** Endast försäljningar med budkonkurrens räknas; ett "
        f"ensamt bud är en likvidation, inte prisupptäckt. Startkrav "
        f"≥{S.BID_THRESHOLDS[0]} bud, nedtrappat per grupp till "
        f"{S.BID_THRESHOLDS[1]} och {S.BID_THRESHOLDS[2]} när gruppen har "
        f"färre än {S.BID_STEPDOWN_BELOW} kvalificerade försäljningar. Aldrig "
        f"under {S.BID_THRESHOLDS[-1]}. Vald tröskel loggas per grupp.\n")
    add(f"**Två spår.** Spår A bär märkesklassen och gäller de försäljningar "
        f"där ett märke eller en upphovsman går att läsa ur texten. Spår B är "
        f"de omärkta och rapporteras som möbeltyp × prisnivå UTAN "
        f"märkesdimension — ingen prisbaserad märkesklassning exporteras.\n")

    add("### Känslighet för budtröskeln\n")
    add("| grupp | ≥3 | ≥4 | ≥5 | n≥3 | n≥5 |")
    add("|---|---|---|---|---|---|")
    for row in groups["bid_sensitivity"]:
        add(f"| {_name(row['grupp'])} | {_pct(row.get('>=3'))} | {_pct(row.get('>=4'))} | "
            f"{_pct(row.get('>=5'))} | {row['n>=3']:,} | {row['n>=5']:,} |")
    add("")

    # ------------------------------------------------------------------
    add("## Validering (fas 3)\n")
    add(f"Holdout 50/50 på försäljningsnivå, {validation['n_train']:,} "
        f"träning / {validation['n_test']:,} test. Felen räknas i logdomän — "
        f"priser är multiplikativa, så en dubbling ska väga lika tungt som en "
        f"halvering.\n")
    add("| modell | medianfel | inom ±25 % | systematiskt fel | n |")
    add("|---|---|---|---|---|")
    for name, m in models.items():
        if "median_abs_pct" not in m:
            add(f"| {name} | (för litet underlag) | | | {m.get('n', 0)} |")
            continue
        add(f"| {name} | {m['median_abs_pct']:.1f} % | "
            f"{m['within_25pct'] * 100:.1f} % | {m['median_bias_pct']:+.1f} % | "
            f"{m['n']:,} |")
    add("")
    covered = validation.get("models_covered_only")
    if covered:
        add(f"Bara {validation['group_coverage'] * 100:.1f} % av testraderna "
            f"hade en gruppspecifik percentil; resten föll tillbaka på den "
            f"globala, vilket späder ut jämförelsen. Samma tabell begränsad "
            f"till de rader där gruppvärdet faktiskt fanns:\n")
        add("| modell | medianfel | inom ±25 % | n |")
        add("|---|---|---|---|")
        for name, m in covered.items():
            if "median_abs_pct" in m:
                add(f"| {name} | {m['median_abs_pct']:.1f} % | "
                    f"{m['within_25pct'] * 100:.1f} % | {m['n']:,} |")
        add("")

    group_model = models.get("gruppspecifik säljpercentil", {})
    global_model = models.get("baslinje: global säljpercentil", {})
    p50_model = models.get("baslinje: alltid p50", {})
    if group_model.get("median_abs_pct") and global_model.get("median_abs_pct"):
        better = global_model["median_abs_pct"] - group_model["median_abs_pct"]
        add("#### Tolkning — läs den här innan siffrorna används\n")
        add(f"**Gruppindelningen bär, men knappt.** Den gruppspecifika "
            f"percentilen slår den globala med "
            f"{better:.1f} procentenheter i medianfel "
            f"({group_model['median_abs_pct']:.1f} % mot "
            f"{global_model['median_abs_pct']:.1f} %). Mot alltid-p50 är "
            f"marginalen {p50_model['median_abs_pct'] - group_model['median_abs_pct']:.1f} "
            f"procentenheter — men på måttet *andel inom ±25 %* är alltid-p50 "
            f"faktiskt något BÄTTRE "
            f"({p50_model['within_25pct'] * 100:.1f} % mot "
            f"{group_model['within_25pct'] * 100:.1f} %). Specen bad mig skriva "
            f"rakt ut om gruppindelningen är brus: den är det inte, men den är "
            f"nära. Vinsten är för liten för att motivera en finmaskig "
            f"gruppstruktur i motorn.\n")
        add(f"**Ingen av modellerna predikterar ett enskilt slutpris väl.** "
            f"Medianfelet ligger runt {group_model['median_abs_pct']:.0f} % för "
            f"alla percentilbaserade modeller. Det är väntat och inte ett "
            f"underkännande av studien: att veta VAR i fördelningen affärer "
            f"sker säger inget om vilket enskilt objekt som är dyrt eller "
            f"billigt inom den fördelningen. Auktionshusets egen värdering "
            f"({models['baslinje: aux_estimate']['median_abs_pct']:.0f} % fel) "
            f"är bättre just för att den är objektspecifik — den har sett "
            f"föremålet.\n")
    add("`aux_estimate` är en **känt partisk** prediktor — 74 % av objekten "
        "klubbas under värderingen och mediankvoten är 0,62 — så att slå den "
        "är ingen bedrift. Huvudbaslinjerna är alltid-p50 och den globala "
        "säljpercentilen.\n")

    rec = validation.get("narrow_recommendation") or {}
    pairs = {k: v for k, v in (rec.get("per_segment") or {}).items()
             if v["dimension"] == "märkesklass × prisnivå"}
    if pairs:
        add("### Rekommenderade percentiler per segment (smal matchning)\n")
        add("Detta är studiens användbara leverans till motorn: percentiler "
            "mätta mot samma sorts fördelning som motorn själv bygger.\n")
        add("| märkesklass × prisnivå | säljpercentil | p25–p75 | n |")
        add("|---|---|---|---|")
        for name, seg in sorted(pairs.items()):
            add(f"| {name} | **{_pct(seg['sell_percentile'])}** | "
                f"{_pct(seg['p25'])}–{_pct(seg['p75'])} | {seg['n']:,} |")
        add("")

    years = validation.get("stability_by_year") or {}
    if years:
        add("### Stabilitet över tid\n")
        add("| år | säljpercentil | n |")
        add("|---|---|---|")
        for year in sorted(years):
            add(f"| {year} | {_pct(years[year]['sell_percentile'])} | "
                f"{years[year]['n']:,} |")
        add("")
        add("Tidsöverlappet mot utropsdatan medger 2024–2026, inte Auctionets "
            "15 år: 70 % av auktionsraderna saknar samtida utropspriser att "
            "räkna en rang mot.\n")

    # ------------------------------------------------------------------
    add("## Resultat per grupp\n")
    add(f"Spår A: {ok_a} grupper med exporterbart värde. "
        f"Spår B: {ok_b}. Märkta `insufficient_market`: {thin}.\n")
    for track, label in (("track_a", "Spår A — möbeltyp × märkesklass × prisnivå"),
                         ("track_b", "Spår B — möbeltyp × prisnivå (omärkta)")):
        add(f"### {label}\n")
        add("| grupp | status | säljpercentil | 95 % CI | p25–p75 | n | ≥bud | källa |")
        add("|---|---|---|---|---|---|---|---|")
        for name, g in sorted(groups[track].items()):
            if g.get("status") != "ok":
                add(f"| {_name(name)} | `{g.get('status')}` | — | — | — | "
                    f"{g.get('n_qualified', 0):,} | ≥{g.get('bid_threshold', '')} | — |")
                continue
            add(f"| {_name(name)} | ok | **{_pct(g['sell_percentile'])}** | "
                f"{_pct(g['ci_low'])}–{_pct(g['ci_high'])} | "
                f"{_pct(g['p25'])}–{_pct(g['p75'])} | {g['n_qualified']:,} | "
                f"≥{g['bid_threshold']} | {g['source']} |")
        add("")

    # ------------------------------------------------------------------
    add("## Beslut fattade under körningen\n")
    for title, text in DECISIONS:
        add(f"**{title}.** {text}\n")

    # ------------------------------------------------------------------
    add("## Ärlighetssektion\n")
    for title, text in HONESTY:
        add(f"**{title}.** {text}\n")

    if figures:
        add("## Figurer\n")
        for path in figures:
            add(f"![{path.stem}](figurer/{path.name})\n")

    S.REPORT_MD.write_text("\n".join(out))


DECISIONS = [
    ("Frågan konstrueras ur märke och möbeltyp, inte ur modellnamn",
     "Motorn får i produktion `märke + modellnamn` av användaren. En "
     "auktionsförsäljning har ingen sådan fråga — titeln är en fri "
     "beskrivning (\"FÅTÖLJ, 'Pernilla', Bruno Mathsson\") och ett "
     "token-AND på hela titeln ger noll träffar. Frågan byggs därför av det "
     "som går att läsa ut säkert: igenkänt märke eller upphovsman, plus "
     "möbeltyp. Uppmjukningsordningen är motorns egen: märke+typ → typ → typ "
     "inkl. omärkt typ → alla möbler. Konsekvensen mäts i "
     "smalhetskänsligheten och redovisas som förbehåll 1."),
    ("Månadsupplösning på tidsfönstret",
     "Fönstret räknas från försäljningsmånadens början i stället för det "
     "exakta datumet, vilket gör matchningen memoiserbar: två försäljningar "
     "av samma typ samma månad matchar per definition mot samma annonser. "
     "Det gör hela underlaget körbart i stället för ett urval — ingen "
     "sampling behövdes. Kanten flyttas som mest 31 dagar av ~180."),
    ("Dubbletter i utropspoolen kollapsas på titel och pris",
     "31,7 % av utropsannonserna ligger i en grupp med identisk normaliserad "
     "titel och identiskt pris, den största med 492 exemplar. Utan kollaps "
     "kan en enda omlistad annons dominera fördelningen den mäts mot. "
     "1 043 270 → 772 811 rader."),
    ("Traderas fastprisrader utesluts ur auktionsanalysen",
     "141 Tradera-rader har `channel = marketplace_fixed`: fastprisköp med "
     "per definition noll bud. De kan aldrig passera budspärren och är inte "
     "misslyckade auktioner. De utesluts ur analysen och rapporteras separat "
     "— de är samtidigt det närmaste datan kommer en ren "
     "konsumenttransaktion, och därmed intressanta för framtida arbete."),
    ("Noll-budsanalysen struken",
     "Ordern bad mig kontrollera om Traderas osålda objekt har ett "
     "utropspris. Svaret är att det inte finns några osålda objekt: Auctionet "
     "har noll rader med noll bud (minsta budantal är 1) och Traderas "
     "noll-budsrader är fastprisköp utan `aux_estimate`. Den empiriska "
     "\"för dyrt\"-gränsen kräver framtida snapshot-data."),
    ("Prisnivåterciler räknas på rang, inte på kvantilkanter",
     "Den matchade medianen klumpar hårt — samma sökning ger samma median för "
     "hundratals försäljningar — så kvantilkanter kollapsar till samma värde "
     "och delningen misslyckas. Rangbaserade terciler delar alltid i tre."),
    ("Utökad märkesigenkänning genomförs inte nu",
     "Väg (c) från fas 0-rapporten är noterad som framtida körning. Med "
     "nuvarande lista klassas cirka en femtedel av möbelförsäljningarna på "
     "märke; resten går till spår B."),
]

HONESTY = [
    ("Auktion är inte privataffär",
     "Percentilerna överförs till Blocket-världen som ett antagande. "
     "Kanalgapet Tradera–Auctionet är delvis ett mått på hur stort det "
     "antagandet är, och det redovisas öppet per märkesklass."),
    ("Låg-end är svagast underbyggt",
     "Budkonkurrensen faller monotont med märkesklass — median 15 bud för "
     "high end, 9 för low. En tunn auktionspublik för budgetmöbler betyder "
     "att auktionsdata för det segmentet är en krycka oavsett korrektion. "
     "Låg-end ärver aldrig mid-gapet: värdet extrapoleras med trenden och "
     "märks `gap_extrapolated`, eller exporteras som `insufficient_market`. "
     "Ett underkorrigerat värde ser ut som ett svar och används som ett — "
     "det är farligare än inget värde."),
    ("Cirkulär risk är undanröjd men värd att kontrollera",
     "Prisnivån sätts av den matchade utropsfördelningens median, inte av "
     "slutpriset. Ingen grupp klassas alltså på samma tal den utvärderas mot. "
     "Spår B saknar helt märkesdimension, så ingen prisbaserad "
     "märkesklassning exporteras."),
    ("Tradera-fönstret är inte en månad",
     "Tidigare rapporterat som ett fönster på en månad. Det berodde på en "
     "bugg: `sold_at` blandar två ISO-format och pandas tystade 7 816 av "
     "7 831 datum till NaT. Efter fixen spänner Tradera 2021-03 till "
     "2026-07. Säsongsförbehållet gäller alltså inte i den formen."),
]
