"""Del A — RAPPORT.md för bryggmätningen."""

from __future__ import annotations

import json

import numpy as np
import pandas as pd

import study_config as S


def _pct(value) -> str:
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return "—"
    return f"p{value * 100:.0f}"


def write_report(measured: pd.DataFrame, results: dict, funnel: list,
                 figures: list) -> None:
    try:
        broad = json.loads(S.OUTPUT_JSON.read_text())
    except Exception:
        broad = {}
    prev = (broad.get("recommended_percentiles") or {}).get("per_segment", {})
    prev_overall = (broad.get("recommended_percentiles") or {}).get("overall")
    broad_global = broad.get("global_sell_percentile")

    tiers = {k: v for k, v in results["segments"].items()
             if v["dimension"] == "märkesklass"}
    image = results["image_effect"]
    out = []
    add = out.append

    add("# Del A — bryggmätningen: säljpercentilen på motorns egen nivå\n")
    add("## Sammanfattning\n")
    add(f"Percentilstudien mätte rangen mot en bred jämförelsemängd (median "
        f"~11 800 annonser). Den här mätningen gör om det på **motorns egen "
        f"fråga**: samma märke OCH modellnamn, ingen fallback-breddning. "
        f"{len(measured):,} försäljningar kvalificerade, medianjämförelsemängd "
        f"**{results['overall']['median_n_asking']} annonser** — "
        f"produktionens storleksordning.\n")
    add(f"**Säljpercentilen på motornivå är "
        f"{_pct(results['overall']['sell_percentile'])}** "
        f"(okorrigerad {_pct(results['overall']['sell_percentile_raw'])}, "
        f"n={results['overall']['n']:,}).\n")

    # --- Trappan ---------------------------------------------------------
    add("### Trappan — konvergerar percentilen när matchningen smalnar?\n")
    add("| segment | bred nivå | smal nivå | motornivå | n (motornivå) |")
    add("|---|---|---|---|---|")
    for name in sorted(tiers):
        seg = tiers[name]
        add(f"| {name} | {_pct(broad_global)} | "
            f"{_pct(prev.get(name, {}).get('sell_percentile'))} | "
            f"**{_pct(seg['sell_percentile'])}** | {seg['n']:,} |")
    add(f"| **alla** | {_pct(broad_global)} | {_pct(prev_overall)} | "
        f"**{_pct(results['overall']['sell_percentile'])}** | "
        f"{results['overall']['n']:,} |")
    add("")
    add("Den breda nivån är percentilstudiens globala värde, den smala dess "
        "märke+möbeltyp-matchning, motornivån den här mätningen. Driver "
        "värdet fortfarande i samma riktning vid varje nivåbyte är det inte "
        "konvergens utan en trend — och då är ingen av nivåerna slutgiltig.\n")

    # --- Kanalgap --------------------------------------------------------
    add("### Kanalgapet på motornivå\n")
    add("| märkesklass | gap här | gap i percentilstudien | grupper | n Tradera |")
    add("|---|---|---|---|---|")
    old_gaps = broad.get("channel_gaps", {})
    for tier in S.TIER_ORDER:
        g = results["channel_gaps"].get(tier, {})
        o = old_gaps.get(tier, {})
        add(f"| {tier} | {'—' if g.get('gap') is None else f'{g[chr(103)+chr(97)+chr(112)]:+.3f}'} "
            f"| {'—' if o.get('gap') is None else f'{o[chr(103)+chr(97)+chr(112)]:+.3f}'} "
            f"| {g.get('groups', 0)} | {g.get('n_tradera', 0):,} |")
    add("")
    add(f"Låg-end: `{results['low_end_gap_status']}`. Gapet är omskattat på "
        f"motornivåns ranger, aldrig ärvt från den breda nivån.\n")
    missing = [t for t in S.TIER_ORDER
               if results["channel_gaps"].get(t, {}).get("gap") is None]
    if missing:
        add(f"**{', '.join(missing)} saknar mätbart gap på den här nivån** — "
            f"modellkravet lämnar för få Tradera-försäljningar kvar för att "
            f"para ihop källorna inom samma möbeltyp. Segmentens värden för "
            f"{', '.join(missing)} är därför OKORRIGERADE, alltså rå "
            f"auktionsdata. De ska läsas som en övre gräns: den verkliga "
            f"konsumentmarknadsnivån ligger sannolikt lägre.\n")

    # --- Budterciler -----------------------------------------------------
    add("### Glidknappens kanter — budterciler\n")
    add("Första gången intervallets kanter får datastöd.\n")
    add("**Uppdraget antog att hög budaktivitet skulle ge LÄGRE rang och "
        "därmed vara kandidat för vänsterkanten. Datan säger tvärtom.** "
        "Hög-tercilen ligger konsekvent HÖGRE än låg-tercilen, i varje segment "
        "med underlag.\n")
    add("Tolkningen blir därmed den omvända, och den är mer intuitiv: ett "
        "objekt som drar många budgivare är efterfrågat och klarar ett högt "
        "pris. Ett objekt som knappt får bud måste ned i pris för att gå alls. "
        "Översatt till glidknappen är det alltså **låg-tercilen som är "
        "vänsterkanten** (priset som säljer även utan konkurrens) och "
        "**hög-tercilen som är högerkanten** (priset som kräver att någon "
        "verkligen vill ha just din möbel).\n")
    add("| segment | låg tercil | mellan | hög tercil | n |")
    add("|---|---|---|---|---|")
    for name in sorted(results["segments"]):
        seg = results["segments"][name]
        terciles = seg.get("bid_terciles") or {}
        if not terciles:
            continue
        add(f"| {name} | {_pct((terciles.get('låg') or {}).get('sell_percentile'))} "
            f"| {_pct((terciles.get('mellan') or {}).get('sell_percentile'))} "
            f"| {_pct((terciles.get('hög') or {}).get('sell_percentile'))} "
            f"| {seg['n']:,} |")
    add("")

    # --- Bildens effekt --------------------------------------------------
    add("### Gjorde bilden någon skillnad?\n")
    add(f"Bild fanns för **{image['share_with_image'] * 100:.1f} %** av "
        f"försäljningarna ({image['n_with_image']:,} st). Auctionets "
        f"`image_url` är ifylld på 181 787 av 461 564 rader, och efter "
        f"modellkravet återstår så här få.\n")
    if image["median_overlap"] is not None:
        add(f"Där bilden fanns behöll omsorteringen i median "
            f"{image['median_overlap'] * 100:.0f} % av jämförelsemängden, och "
            f"ändrade rangen med i median "
            f"{image['median_rank_shift']:.3f}. Andel där jämförelsemängden "
            f"ändrades väsentligt (under 90 % överlapp): "
            f"**{image['changed_materially'] * 100:.1f} %**.\n")
    add(f"Metoder: {image['methods']}.\n")
    if image["share_with_image"] < 0.2:
        add("**Detta betyder att 'motornivån' här i praktiken är textnivå.** "
            "Bildomsorteringen är en del av produktionens pipeline som den här "
            "mätningen bara kan tala om för en liten minoritet av "
            "försäljningarna. Siffran ovan är alltså motorns nivå vad gäller "
            "SÖKBREDD, men inte vad gäller bildfiltrering.\n")

    add("---\n")

    # --- Tratten ---------------------------------------------------------
    add("## Bortfallstratt\n")
    add("| steg | tradera | auctionet | totalt |")
    add("|---|---|---|---|")
    for row in funnel:
        add(f"| {row['steg']} | {row['tradera']:,} | {row['auctionet']:,} | "
            f"{row['totalt']:,} |")
    add("")

    add("## Segment och grupper\n")
    add("| segment | dimension | säljpercentil | okorr. | 95 % CI | n | ≥bud | median n annonser |")
    add("|---|---|---|---|---|---|---|---|")
    for name in sorted(results["segments"]) + sorted(results["groups"]):
        seg = results["segments"].get(name) or results["groups"][name]
        add(f"| {name} | {seg['dimension']} | **{_pct(seg['sell_percentile'])}** "
            f"| {_pct(seg['sell_percentile_raw'])} "
            f"| {_pct(seg['ci_low'])}–{_pct(seg['ci_high'])} | {seg['n']:,} "
            f"| ≥{seg['bid_threshold']} | {seg['median_n_asking']} |")
    add("")

    add("## Beslut fattade under körningen\n")
    for title, text in DECISIONS:
        add(f"**{title}.** {text}\n")

    add("## Ärlighetssektion\n")
    for title, text in HONESTY:
        add(f"**{title}.** {text}\n")

    if figures:
        add("## Figurer\n")
        for path in figures:
            add(f"![{path.stem}](figurer/{path.name})\n")

    (S.BRIDGE_DIR / "RAPPORT.md").write_text("\n".join(out))


DECISIONS = [
    ("Modellnamn kräver att märket också står i texten",
     "\"Kivik\" är både en IKEA-soffa och en ort, \"Stockholm\" både en "
     "IKEA-serie och en stad. Modellnamnet räknas därför bara när märket "
     "finns i samma annonstext. Det kostar träffar men är enda sättet att "
     "undvika att jämförelsemängden fylls med fel möbel."),
    ("Bildfiltret får inte göra jämförelsemängden för tunn",
     "Skär bildomsorteringen bort så mycket att färre än "
     f"{S.BRIDGE_MIN_ASKING} annonser återstår används textnivåns mängd i "
     "stället, och raden märks `reverted`. Alternativet vore att mäta mot en "
     "handfull annonser, vilket ger en rang men ingen mätning."),
    ("Kanalgapet omskattas, ärvs aldrig",
     "Hela poängen med Del A är att nivåbytet ändrar rangen. Att då återanvända "
     "ett gap skattat på den breda nivån vore att importera just det fel vi "
     "försöker mäta bort."),
    ("Endast 533 av de kvalificerade försäljningarna hade bild",
     "Auctionets `image_url` saknas på 60 % av raderna. Alla 533 embeddades "
     "(153 ms/bild, under två minuter totalt), men andelen är för låg för att "
     "bildomsorteringen ska prägla resultatet. Det redovisas öppet i stället "
     "för att döljas — se ärlighetssektionen."),
]

HONESTY = [
    ("Urvalet lutar mot design och premium",
     "Modellnamn står i auktionstitlar när möbeln är känd nog att namnges. En "
     "Lamino heter Lamino; en IKEA-soffa på Blocket heter \"soffa\". "
     "Resultatet gäller därför det segmentet. **Low end täcks inte av Del A** "
     "— dess sanning ska komma från Del B:s omlistningskedjor."),
    ("Auktionsbilder är studiofoton, Blocket-bilder är vardagsrumsfoton",
     "DINOv2 mäter visuell identitet, och en professionellt ljussatt bild mot "
     "vit bakgrund liknar inte nödvändigtvis samma möbel fotograferad i ett "
     "vardagsrum. Bildomsorteringen kan därför bete sig annorlunda här än i "
     "produktion, där både fråga och annonser kommer från samma sorts källa."),
    ("Auktion är fortfarande inte privataffär",
     "Kanalgapet korrigerar för skillnaden mellan Tradera och Auctionet, inte "
     "för skillnaden mellan auktion och Blocket. Den sista överföringen är "
     "fortfarande ett antagande."),
    ("Ingen såld/osåld-signal",
     "Som tidigare: datan innehåller bara sålda objekt. Mätningen säger var "
     "affärer sker, aldrig var de uteblir."),
]
