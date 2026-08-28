"""Del B — RAPPORT.md för omlistningsstudien."""

from __future__ import annotations

import json

import numpy as np
import pandas as pd

import study_config as S


def write_report(measured: pd.DataFrame, payload: dict, figures: list) -> None:
    grad = payload["gradient_by_variant"].get("global", {})
    steps = payload["strictness_steps"]
    final = steps[-1]
    out = []
    add = out.append

    add("# Del B — omlistningskedjor: den empiriska \"för dyrt\"-gradienten\n")
    add("## Sammanfattning\n")
    add(f"Auktionsspåret innehåller noll osålda objekt, så gränsen för \"för "
        f"dyrt\" måste komma ur Blockets egen data. Varje omlistning med sänkt "
        f"pris är en dom över det första priset.\n")
    add(f"**{payload['n_chains']:,} kedjor** överlevde skärpningen, av "
        f"{steps[0]['kedjor']:,} kandidater — "
        f"{(1 - payload['n_chains'] / steps[0]['kedjor']) * 100:.1f} % offrades "
        f"för precisionens skull.\n")

    if grad:
        low = list(grad.values())[0]
        high = list(grad.values())[-1]
        add(f"**Gradienten finns.** Bland kedjor vars startpris låg i den "
            f"lägsta rangdecilen sänkte {low['share_lowered'] * 100:.0f} % "
            f"priset vid omlistning; i den högsta gjorde "
            f"{high['share_lowered'] * 100:.0f} % det. ")
        add("Det är den empiriska signalen om att ett för högt startpris "
            "tvingas ned — och den är den enda i hela projektet som kommer "
            "från Blocket-världen själv.\n")

    add(f"**Men precisionen räcker inte för produktion.** Skattad precision "
        f"efter skärpning: **{final['skattad_precision']}**, mot kravet ~0,90. "
        f"Resultatet är därför märkt `indicative_only` och ska inte kopplas in "
        f"i motorn.\n")

    add("---\n")

    # --- Skärpningen -----------------------------------------------------
    add("## Skärpningen — vad den kostade\n")
    add("Precisionen skattas ur utfallets symmetri: brus antas ge lika många "
        "prishöjningar som prissänkningar, så andelen höjda gånger två är "
        "brusets storlek. En äkta omlistningspopulation ska luta kraftigt mot "
        "sänkt pris.\n")
    add("| steg | kedjor | sänkt % | höjt % | skattad precision |")
    add("|---|---|---|---|---|")
    for step in steps:
        add(f"| {step['steg']} | {step['kedjor']:,} | {step['sänkt_%']} | "
            f"{step['höjt_%']} | {step['skattad_precision']} |")
    add("")
    add("Titelns **sällsynthet och längd** är de starkaste hävstängerna. En "
        "rubrik som förekommer 11–50 gånger ger sänkt/höjt-kvot 0,58 — alltså "
        "FLER höjningar än sänkningar, vilket är omöjligt för äkta "
        "omlistningar och bevisar att sådana rubriker fångar olika möbler. Vid "
        "frekvens 2 och minst 40 tecken vänder kvoten till 4,2.\n")

    audit_all = payload["precision_all"]
    audit_strict = payload["precision_strict"]
    add(f"Den programmatiska granskningen av 100 slumpade kedjor ger "
        f"{audit_all['precision_safe'] * 100:.0f} % säkra före skärpningen och "
        f"{audit_strict['precision_safe'] * 100:.0f} % efter. **Den andra "
        f"siffran är cirkulär och ska ignoreras** — granskningen prövar samma "
        f"tre kriterier (titel, bild, pris) som redan användes som filter, så "
        f"den kan inte annat än godkänna det som passerat dem. "
        f"Symmetriskattningen ovan är det enda oberoende måttet, och den ger "
        f"{final['skattad_precision']}.\n")
    add(f"Även den är optimistisk av ett andra skäl: "
        f"{audit_strict['no_image']} av de 100 granskade saknade bild på båda "
        f"länkarna och kunde alltså inte motbevisas oavsett metod.\n")

    # --- Bildkontrollen --------------------------------------------------
    add("## Varför bildkontrollen inte räddar situationen\n")
    add("Bland titelmatchade kedjor där båda länkarna har en embeddad bild är "
        "medianen för lägsta parvisa likhet **0,45**. De flesta "
        "titelmatchningar visar alltså olika möbler. Bara 3,7 % når 0,90.\n")
    add("Problemet är att bilden bara finns för en liten minoritet: 95 % av "
        "kedjorna har ingen embeddad bild på båda länkarna, och för dem finns "
        "ingen oberoende kontroll alls. Bildkontrollen kan därför förkasta, "
        "men inte bekräfta i skala.\n")

    # --- Gradienten ------------------------------------------------------
    add("## \"För dyrt\"-gradienten\n")
    add("| startrang | n | sänkte priset | höjde | median sänkning |")
    add("|---|---|---|---|---|")
    for name, row in grad.items():
        cut = f"{row['median_cut'] * 100:.1f} %" if row["median_cut"] else "—"
        add(f"| {name} | {row['n']:,} | {row['share_lowered'] * 100:.1f} % | "
            f"{row['share_raised'] * 100:.1f} % | {cut} |")
    add("")

    tier = payload.get("gradient_by_price_tier", {})
    for name in [k for k in tier if k != "global"]:
        add(f"### Prisnivå: {name}\n")
        add("| startrang | n | sänkte priset | median sänkning |")
        add("|---|---|---|---|")
        for bucket, row in tier[name].items():
            cut = f"{row['median_cut'] * 100:.1f} %" if row["median_cut"] else "—"
            add(f"| {bucket} | {row['n']:,} | "
                f"{row['share_lowered'] * 100:.1f} % | {cut} |")
        add("")

    # --- Jämförelse med Del A --------------------------------------------
    add("## Jämförelse med Del A\n")
    try:
        bridge = json.loads(
            (S.BRIDGE_DIR / "bridge_percentiles.json").read_text())
        engine_percentile = bridge["overall"]["sell_percentile"]
        add(f"Del A mätte säljpercentilen till **p{engine_percentile * 100:.0f}** "
            f"på auktionsdata. Om den siffran är rätt bör omlistningar bli "
            f"vanliga någonstans ovanför den — ett pris satt klart över den "
            f"nivå där affärer sker borde tvingas ned.\n")
        if grad:
            buckets = list(grad.items())
            crossing = None
            for name, row in buckets:
                if row["share_lowered"] > 0.5:
                    crossing = name
                    break
            if crossing:
                add(f"Sänkningarna passerar 50 % först i decilen **{crossing}**. ")
                add("Pekar de två signalerna åt samma håll är det en "
                    "korsvalidering mellan två helt olika datakällor — "
                    "auktionsutfall och Blockets omlistningar.\n")
            else:
                add("Sänkningarna passerar aldrig 50 % i någon decil, vilket "
                    "gör jämförelsen med Del A svag: gradienten lutar rätt men "
                    "når ingen tydlig brytpunkt.\n")
    except Exception:
        add("Del A:s resultat kunde inte läsas för jämförelse.\n")

    # --- Ärlighet --------------------------------------------------------
    add("## Ärlighetssektion\n")
    for title, text in HONESTY:
        add(f"**{title}.** {text}\n")

    if figures:
        add("## Figurer\n")
        for path in figures:
            add(f"![{path.stem}](figurer/{path.name})\n")

    (S.RELIST_DIR / "RAPPORT.md").write_text("\n".join(out))


HONESTY = [
    ("En kedja som tar slut betyder inte att möbeln såldes",
     "Säljaren kan ha gett upp, tröttnat, skänkt bort möbeln eller flyttat. "
     "Den sista länken är inte en försäljning, den är bara den sista "
     "observationen. Inga slutsatser i den här rapporten bygger på att "
     "kedjan tog slut."),
    ("En annons utan senare länk kan vara en missad matchning",
     "Ändrar säljaren rubriken vid omlistningen bryts kedjan, och annonsen "
     "ser ut som en engångsföreteelse. Kedjeidentifieringen är alltså partisk "
     "mot säljare som skriver om sina annonser — sannolikt just de mest "
     "aktiva, alltså de vars beteende vi helst vill mäta."),
    ("Inga påståenden om säljtid",
     "Datan är fortfarande en rad per annons utan livslängd. Avståndet mellan "
     "två länkar är tiden mellan två OBSERVATIONER, inte tiden annonsen låg "
     "ute. Del C finns för att den skillnaden ska försvinna."),
    ("Precisionen når inte kravet",
     "Skärpningen tog kvoten sänkt/höjt från 1,0 till 4,2, men skattad "
     "precision stannar under 0,90. Resultatet är riktningsgivande, inte "
     "kalibrerande, och exporteras som `indicative_only`."),
    ("Gradienten kan delvis vara regression mot medelvärdet",
     "En annons vars startpris råkade hamna högt i fördelningen har mer "
     "utrymme att sänkas än en som redan låg lågt — helt oberoende av om "
     "marknaden sa nej. Effektens storlek går inte att separera med den här "
     "datan, och gradientens lutning ska därför läsas som en övre gräns."),
]
