"""Skadeavdrag: från identifierad skada till prisjustering.

    LLM:en SER och KLASSIFICERAR.  Tabellen VÄRDERAR.
    Uppskattad lagningskostnad täcker gapet däremellan.

Den arbetsdelningen är hela designen. En språkmodell kan titta på ett foto och
säga "fläck på sittytan, tydligt framträdande" — det är en iakttagelse. Den kan
INTE säga vad det gör med priset på svenska andrahandsmarknaden; den frågan
kräver marknadsdata den inte har, och ett svar därifrån vore en gissning
förklädd till mätning.

Därför tre steg, i fallande tillförlitlighet:

  1. TABELL          uppmätt kvot flaggade/oflaggade inom modellgrupp
  2. LAGNINGSKOSTNAD modellen uppskattar vad det kostar att åtgärda; vi
                     omvandlar med REPAIR_HASSLE_FACTOR
  3. INGET AVDRAG    modellen otillgänglig -> priset sätts utan skadejustering
                     och det redovisas

Steg 3 är inte en degradering utan en garanti: **ett dött API får aldrig fälla
ett prissvar.**
"""

from __future__ import annotations

import json
import re
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import pandas as pd

from . import config

log = logging.getLogger(__name__)

#: Kolumnerna som säger att en annons deklarerat en skada.
FLAG_COLUMNS = ("damage_wear", "damage_scratch", "damage_stain",
                "damage_damage", "damage_crack", "damage_defect")


# --------------------------------------------------------------------------
# Tabellen
# --------------------------------------------------------------------------
def load_table(path=None) -> List[dict]:
    """Raderna ur damage_deductions.json. Tom lista när filen saknas."""
    path = path or config.DAMAGE_TABLE_PATH
    try:
        return json.loads(path.read_text()).get("rows", []) or []
    except FileNotFoundError:
        log.warning("Skadetabellen saknas: %s", path)
        return []
    except Exception:
        log.warning("Skadetabellen gick inte att läsa: %s", path, exc_info=True)
        return []


def categories(path=None) -> List[str]:
    """Kategorinamnen i tabellen — skickas till modellen i prompten.

    Modellen ska mappa mot det vi FAKTISKT kan värdera. Utan listan hittar den
    på egna kategorinamn, och varje sådant blir `unmapped` i onödan.
    """
    return sorted({row["category"] for row in load_table(path)
                   if row.get("category")})


def lookup(category: str, furniture_type: Optional[str], grade: int,
           path=None) -> Optional[dict]:
    """Tabellraden för en skada. Typspecifik vinner över generisk `*`.

    Returnerar None när kategorin saknas ELLER när raden är märkt
    `insufficient_data` — en sådan rad dokumenterar att kategorin är känd men
    omätt, och den ska aldrig ge ett avdrag.
    """
    rows = [r for r in load_table(path)
            if r.get("category") == category and r.get("grade") == grade]
    if not rows:
        return None
    specific = [r for r in rows if r.get("furniture_type") == furniture_type]
    generic = [r for r in rows if r.get("furniture_type") == "*"]
    row = (specific or generic or [None])[0]
    if row is None or row.get("source") == "insufficient_data":
        return None
    if row.get("deduction") is None:
        return None
    return row


# --------------------------------------------------------------------------
# Lagningskostnad -> avdrag
# --------------------------------------------------------------------------
def from_repair_cost(cost_sek: float, base_price: float) -> Optional[float]:
    """Avdragsandel ur en uppskattad lagningskostnad.

        avdrag_sek   = kostnad * REPAIR_HASSLE_FACTOR
        avdrag_andel = avdrag_sek / baspris

    Används BARA för omappade skador. Kategorier i tabellen värderas som ANDEL
    av basen och rör aldrig någon kostnad — tabellens `repair_cost_sek` är
    dokumentation, inte indata.

    Påslaget är 2,0 och inte 1,3 för att kostnadsbaserade avdrag underskattar
    marknadens straff systematiskt: köparen prisar in osäkerhet om vad mer som
    kan vara fel, och stigma kring en skadad möbel, utöver själva lagningen.
    """
    if not cost_sek or not base_price or base_price <= 0 or cost_sek <= 0:
        return None
    share = (float(cost_sek) * config.REPAIR_HASSLE_FACTOR) / float(base_price)
    return min(share, config.MAX_UNMAPPED_DEDUCTION)


# --------------------------------------------------------------------------
# Basen: mot dubbelräkning
# --------------------------------------------------------------------------
def select_base(matches: pd.DataFrame) -> tuple:
    """(jämförelsemängd att räkna basen på, etikett, halvera_avdrag?).

    **Basregeln.** Jämförelsemängden innehåller redan skadade annonser, så
    medianen är redan nedtryckt av deras skador. Att dra av från den medianen
    straffar skadan två gånger: en gång via mängden och en gång via avdraget.

    Basen räknas därför på de OFLAGGADE annonserna. Räcker de inte till
    filtergolvet används den blandade mängden — men då halveras avdraget, för
    att den blandade medianen redan bär en del av effekten.
    """
    have = [c for c in FLAG_COLUMNS if c in matches.columns]
    if not have or matches.empty:
        return matches, "mixed_no_flags", True

    flagged = matches[have].fillna(False).astype(bool).any(axis=1)
    clean = matches[~flagged]
    if len(clean) >= config.MIN_COMPARISON_SET:
        return clean, "undamaged_comparables", False
    return matches, "mixed_halved", True


# --------------------------------------------------------------------------
# Stapling
# --------------------------------------------------------------------------
def worst_with_ci(items: List[dict]) -> dict:
    """Totalt avdrag = det STÖRSTA enskilda. Ingen stapling, ingen dämpning.

    En köpare prissätter möbelns värsta problem. Ytterligare skador bekräftar
    samma intryck utan att flytta priset igen — se config-noten vid taken.

    **Kanterna propageras som max över posternas CI, inte som den bindande
    postens CI.** I det optimistiska scenariot kan en ANNAN skada bli den
    värsta: med A(0,38, CI 0,25-0,50) och B(0,35, CI 0,30-0,45) är den lägsta
    rimliga totalen 0,30 — B:s undre kant — inte A:s 0,25, för B finns kvar
    även när A visar sig mild.

    Saknas CI för en post används punktskattningen i alla tre kedjorna; den
    bidrar då med noll extra bredd och `missingCi` sätts.
    """
    kept = [i for i in (items or []) if i.get("deduction")]
    if not kept:
        return {"total": 0.0, "totalCiLow": 0.0, "totalCiHigh": 0.0,
                "missingCi": False}

    points, lows, highs, missing = [], [], [], False
    for item in kept:
        point = float(item["deduction"])
        low, high = item.get("ciLow"), item.get("ciHigh")
        if low is None or high is None:
            low = high = point
            missing = True
        # Klamra så att intervallet omsluter punktskattningen.
        points.append(point)
        lows.append(min(float(low), point))
        highs.append(max(float(high), point))

    return {
        "total": max(points),
        "totalCiLow": max(lows),
        "totalCiHigh": max(highs),
        "missingCi": missing,
    }


# --------------------------------------------------------------------------
# Hela kedjan
# --------------------------------------------------------------------------
def resolve(items: List[dict], furniture_type: Optional[str],
            base_price: Optional[float], table_path=None) -> dict:
    """Skadeposterna till ett totalavdrag, med full redovisning.

    `items` är modellens strukturerade svar: kategori, grad, placering,
    beskrivning och eventuell lagningskostnad. Funktionen gör ingen bedömning
    av VAD som syns — bara vad det är värt.
    """
    resolved: List[dict] = []
    for item in items or []:
        category = item.get("category")
        grade = item.get("grade")
        entry = {
            "category": category,
            "grade": grade,
            "location": item.get("location"),
            "description": item.get("description"),
            "deduction": 0.0,
            "source": None,
        }
        if item.get("count", 1) > 1:
            entry["count"] = item["count"]
        if item.get("gradeEscalated"):
            entry["gradeEscalated"] = True

        # Väsentlighetströskeln FÖRST. En knappt synlig skada listas men kostar
        # inget — AI:n ser mer än köparen bryr sig om.
        if grade is not None and grade < config.MATERIALITY_MIN_GRADE:
            entry.update(source="below_materiality")
            resolved.append(entry)
            continue

        row = (lookup(category, furniture_type, grade, table_path)
               if category and category != "unmapped" and grade is not None
               else None)
        if row is not None:
            entry.update(deduction=float(row["deduction"]), source="table",
                         ciLow=row.get("ci_low"), ciHigh=row.get("ci_high"),
                         nGroups=row.get("n_groups"))
            resolved.append(entry)
            continue

        # Omappad: uppskattad lagningskostnad, om modellen gav någon.
        cost = item.get("repair_cost_sek")
        share = from_repair_cost(cost, base_price) if cost else None
        if share is not None:
            entry.update(category=category or "unmapped",
                         description=item.get("description"),
                         repairCostSek=cost,
                         repairCostRange=item.get("repair_cost_range"),
                         repairAction=item.get("repair_action"),
                         deduction=round(share, 4), source="estimated_repair")
        else:
            entry.update(category=category or "unmapped",
                         description=item.get("description"),
                         source="no_valuation")
        resolved.append(entry)

    chain = worst_with_ci(resolved)
    total = chain["total"]
    capped = total > config.MAX_TOTAL_DEDUCTION
    if capped:
        total = config.MAX_TOTAL_DEDUCTION
    # Kanterna kapas mot samma tak, men behåller sin ordning kring mitten.
    ci_low = min(chain["totalCiLow"], total)
    ci_high = min(max(chain["totalCiHigh"], total), config.MAX_TOTAL_DEDUCTION)
    return {
        "items": resolved,
        "totalDeduction": round(total, 4),
        "totalCiLow": round(ci_low, 4),
        "totalCiHigh": round(ci_high, 4),
        "missingCi": chain["missingCi"],
        "capped": capped,
        "estimatedCount": sum(1 for e in resolved
                              if e["source"] == "estimated_repair"),
    }


# --------------------------------------------------------------------------
# Den självförbättrande taxonomin
# --------------------------------------------------------------------------
def log_shadow(info: dict, dedup: dict, furniture_type: Optional[str],
               path=None) -> None:
    """En rad per prissättning med skador.

    Finns för att kunna svara på frågan "hur ofta utlöser taket och
    dedupliceringen?" innan flaggan slås på skarpt. Utan den vore svaret en
    gissning, och just de två mekanismerna är de som avgör om systemet blir
    nyanserat eller plattar ut alla slitna möbler mot samma pris.
    """
    path = path or config.DAMAGE_SHADOW_LOG
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "date": datetime.now(timezone.utc).date().isoformat(),
                "furniture_type": furniture_type,
                "items_in": dedup.get("before"),
                "items_after_dedup": dedup.get("after"),
                "collapsed": dedup.get("collapsed"),
                "escalated": dedup.get("escalated") or [],
                "counts": dedup.get("counts") or {},
                "total_deduction": info.get("totalDeduction"),
                "capped": bool(info.get("capped")),
                "needs_model": info.get("needsModel"),
                "categories": [i.get("category") for i in info.get("items", [])],
            }, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001 — loggning får aldrig fälla ett prissvar
        log.warning("Skuggloggen gick inte att skriva", exc_info=True)


def log_unmapped(items: List[dict], furniture_type: Optional[str],
                 path=None) -> int:
    """Loggar omappade skador. Loggen är prioriteringsordningen för tabellen.

    Vilka skador användarna faktiskt har är en empirisk fråga, och den enda
    ärliga källan är vad systemet inte kunde värdera. Taxonomin växer därmed ur
    verklig användning i stället för ur en gissning om vad som brukar gå sönder.
    """
    path = path or config.UNMAPPED_DAMAGE_LOG
    rows = [i for i in (items or [])
            if i.get("source") in ("estimated_repair", "no_valuation")
            or i.get("category") == "unmapped"]
    if not rows:
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).date().isoformat()
    with path.open("a", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps({
                "date": stamp,
                "furniture_type": furniture_type,
                "description": row.get("description") or row.get("category"),
                "repair_cost_sek": row.get("repairCostSek"),
                "repair_action": row.get("repairAction"),
                "grade": row.get("grade"),
                "location": row.get("location"),
            }, ensure_ascii=False) + "\n")
    return len(rows)


# --------------------------------------------------------------------------
# Indata från skadesystemet
# --------------------------------------------------------------------------
# **Prismotorn detekterar INTE skador.** Ett separat system gör det och levererar
# en färdig lista. Motorn tar emot den och värderar den — inget mer.
#
# API-kontraktet, per post:
#
#     {"description": "fläck på sittdynan",   # obligatorisk, fritext
#      "severity": "synlig",                  # valfri: 0/1/2 eller text
#      "location": "sittyta",                 # valfri
#      "image": "<base64>"}                   # valfri, används bara vid
#                                             # kostnadsuppskattning
#
# Matchningen sker i TVÅ steg, och ordningen är hela poängen:
#
#   1. DETERMINISTISKT   beskrivning mot kategoriernas synonymer. Gratis,
#                        konsekvent, samma svar varje gång.
#   2. MODELLANROP       endast för poster steg 1 inte klarade, och bara för att
#                        mappa mot kategorilistan eller uppskatta en
#                        lagningskostnad.
#
# En modell som anropas för varje skada är både dyrare och mindre förutsägbar än
# en ordlista. Steg 2 finns för svansen, inte för normalfallet.

#: Severity från skadesystemet -> grad. Både siffror och svensk/engelsk text.
#: Kommer severity med ska den ANVÄNDAS, inte bedömas om — skadesystemet har
#: sett skadan, det har inte vi.
SEVERITY_MAP: Dict[Any, int] = {
    0: 0, 1: 1, 2: 2, "0": 0, "1": 1, "2": 2,
    # grad 0 — knappt synlig
    "knappt synlig": 0, "knappt": 0, "obetydlig": 0, "marginell": 0,
    "liten": 0, "litet": 0, "lindrig": 0, "diskret": 0, "minimal": 0,
    "minor": 0, "low": 0, "slight": 0, "negligible": 0,
    # grad 1 — synlig
    "synlig": 1, "medel": 1, "mattlig": 1, "måttlig": 1, "normal": 1,
    "moderate": 1, "medium": 1, "visible": 1,
    # grad 2 — framträdande
    "framtradande": 2, "framträdande": 2, "kraftig": 2, "kraftigt": 2,
    "stor": 2, "stort": 2, "omfattande": 2, "grov": 2, "allvarlig": 2,
    "severe": 2, "major": 2, "high": 2, "extensive": 2,
}

#: Grad när severity saknas. Att skadesystemet rapporterat skadan alls betyder
#: att den syns — men vi vet inte hur mycket, så vi antar mitten och FLAGGAR det.
#: STATUS: **ovaliderad** — ett antagande, inte en mätning.
DEFAULT_GRADE = 1

#: Synonymer per kategori för den deterministiska matchningen. Ord matchas som
#: delsträngar i den foldade beskrivningen.
#:
#: Tabellens `categories[x].synonyms` vinner när den finns, så listan går att
#: utöka utan kodändring. Den här kartan är fallback för de kategorier
#: kallstartstabellen levererades med.
CATEGORY_SYNONYMS: Dict[str, tuple] = {
    "flack": ("flack", "flackar", "flackig", "solkig", "smutsig", "smuts",
              "kaffeflack", "vinflack", "urinflack", "stain", "spot"),
    "repa_hard": ("repa", "repor", "rispa", "rispor", "skrapmarke", "skrapa",
                  "lackskada", "scratch", "jack i lacken", "marke i traet"),
    "repa_skinn": ("repa i skinn", "skinnrepa", "skrapmarke i skinn",
                   "repor i ladret", "ladret repat", "skinnet repat"),
    "reva_hal": ("reva", "revor", "hal", "hal i tyget", "sprattat", "sprucket tyg",
                 "riven", "rivet", "tear", "hole", "uppsprucken som"),
    "nedsutten": ("nedsutten", "nersutten", "nedsuttet", "tappat formen",
                  "platt dyna", "sjunkit ihop", "utsutten", "sagging"),
    "missfargning": ("missfargning", "missfargad", "solblekt", "blekt",
                     "gulnad", "gulnat", "urblekt", "faded", "discoloured"),
    "skinnflagning": ("flagande", "flagnar", "sprucket skinn", "skinnet spricker",
                      "krackelerat skinn", "peeling", "sprucket ladar"),
    "stomskada": ("vinglig", "vingligt", "ostadig", "glappar", "stomskada",
                  "trasig stomme", "knakar", "loss i fogarna", "wobbly"),
    "mekanikfel": ("mekanik", "baddfunktion", "gar inte att fallа ut",
                   "ladskena", "hissen", "gangjarn", "trasig mekanism",
                   "fungerar inte", "kargar", "broken mechanism"),
    "saknad_del": ("saknas", "saknad", "fattas", "hyllplan saknas",
                   "en dyna saknas", "skruvar saknas", "missing"),
    "vattenskada": ("vattenskada", "vattenskadad", "fuktskada", "svalld",
                    "svallt", "uppsvalld", "water damage"),
    "lukt": ("lukt", "luktar", "roklukt", "rokdoft", "husdjurslukt",
             "hundlukt", "kattlukt", "unket", "moglig lukt", "smell", "odour"),
    "mogel": ("mogel", "mogligt", "moglig", "mould", "mold", "mildew"),
}


def fold(text: str) -> str:
    """Gemener utan diakriter. Samma folding som resten av systemet."""
    import unicodedata

    if not text:
        return ""
    return (unicodedata.normalize("NFKD", str(text))
            .encode("ascii", "ignore").decode("ascii").lower())


def severity_to_grade(severity: Any) -> Optional[int]:
    """Skadesystemets severity -> grad 0/1/2. None när den inte går att tolka.

    Följer severity med ska den ANVÄNDAS. Skadesystemet har sett skadan; att
    bedöma om den här vore att kasta bort information och riskera att två
    system säger olika saker om samma foto.
    """
    if severity is None:
        return None
    if isinstance(severity, bool):
        return None
    if isinstance(severity, (int, float)):
        return max(0, min(2, int(severity)))
    key = fold(severity).strip()
    if key in SEVERITY_MAP:
        return SEVERITY_MAP[key]
    for word, grade in SEVERITY_MAP.items():
        if isinstance(word, str) and len(word) > 3 and word in key:
            return grade
    return None


def synonyms(table_path=None) -> Dict[str, tuple]:
    """Synonymkartan. Tabellens egna vinner över de inbyggda."""
    try:
        path = table_path or config.DAMAGE_TABLE_PATH
        declared = json.loads(path.read_text()).get("categories", {}) or {}
    except Exception:
        return dict(CATEGORY_SYNONYMS)
    if not declared:
        return dict(CATEGORY_SYNONYMS)

    # BARA tabellens kategorier. En kategori som inte finns i tabellen kan
    # aldrig värderas, så den ska heller aldrig matcha — annars skickas skadan
    # till en kategori som inte har någon rad, och uppslaget missar tyst.
    #
    # Att i stället slå ihop kartorna skapade en kollision: en tabell med
    # kategorin `repa` och den inbyggda `repa_hard` matchade båda ordet "repa"
    # med samma längd, och vinnaren avgjordes av ordboksordningen.
    out = {}
    for name, meta in declared.items():
        extra = (meta or {}).get("synonyms")
        out[name] = (tuple(fold(w) for w in extra) if extra
                     else CATEGORY_SYNONYMS.get(name, (fold(name),)))
    return out


def match_category(description: str, table_path=None) -> Optional[str]:
    """Steg 1: deterministisk matchning av beskrivning mot kategori.

    Längsta träffen vinner. Utan den regeln matchar "repa" inuti "repa i skinn"
    och en skinnrepa hamnar i fel kategori — samma längsta-match-först som
    möbeltypslexikonet använder, och av samma skäl.

    Returnerar None när inget matchar. Då, och bara då, blir det ett modellanrop.
    """
    text = fold(description)
    if not text:
        return None
    words_in_text = set(re.findall(r"[a-z0-9]+", text))

    best, best_len = None, 0
    for category, phrases in synonyms(table_path).items():
        for phrase in phrases:
            if not phrase:
                continue
            parts = re.findall(r"[a-z0-9]+", phrase)
            if len(parts) > 1:
                # FLERORDSSYNONYM: träff om frasen står ordagrant ELLER om alla
                # dess ord finns i texten oavsett ordföljd.
                #
                # Båda behövs. Delsträng ensam missade "hyllplan saknas" när
                # tabellen skrev "saknas hyllplan"; ordmängd ensam missade
                # "repa i skinnet" mot "repa i skinn", eftersom `skinnet` inte
                # är samma ORD som `skinn` — och då vann `repa_hard` i stället.
                hit = phrase in text or all(w in words_in_text for w in parts)
            else:
                hit = phrase in text
            if hit and len(phrase) > best_len:
                best, best_len = category, len(phrase)
    return best


def normalise(damages: List[dict], table_path=None) -> List[dict]:
    """API-poster till interna poster. Ingen detektering, bara tolkning.

    Varje post får `category` (eller None när steg 1 missade), `grade`,
    `matchedBy` och de fält värderingen behöver.
    """
    out = []
    for raw in damages or []:
        if not isinstance(raw, dict):
            continue
        # IDEMPOTENT. En post som redan gått genom steg 1 och 2 — den har
        # `matchedBy` — får inte normaliseras om: då tappas kategorin och
        # kostnaden modellen tillförde, och skadan blir ovärderad.
        #
        # Det gör också att en anropare kan köra steg 2 själv och lämna in en
        # färdig post, vilket är den väg som används när skadesystemet redan
        # har mappat mot vår kategorilista.
        if raw.get("matchedBy") is not None:
            out.append(dict(raw))
            continue

        description = raw.get("description") or ""
        category = match_category(description, table_path)
        grade = severity_to_grade(raw.get("severity"))
        out.append({
            "category": category,
            "grade": DEFAULT_GRADE if grade is None else grade,
            "gradeAssumed": grade is None,
            "location": raw.get("location"),
            "description": description,
            "image": raw.get("image"),
            "matchedBy": "synonym" if category else None,
        })
    return out


def _group_key(item: dict) -> str:
    """Nyckeln skador grupperas på.

    Kategori när den finns. Saknas den — posten är omappad — grupperas på den
    foldade beskrivningen i stället, så att tio identiska "repa på benet" blir
    en post även innan de mappats.
    """
    return item.get("category") or f"~{fold(item.get('description') or '')}"


def deduplicate(items: List[dict]) -> tuple:
    """En post per kategori, med gruppens högsta grad. (poster, statistik).

    Skadesystemet rapporterar varje enskild skada. Utan det här steget ger en
    normalsliten möbel 8-12 poster som staplas till 50-procentstaket, och då
    blir taket normalfallet i stället för ett skyddsnät — alla slitna möbler
    hamnar på samma pris oavsett hur slitna de är.

    Antalet inom kategorin redovisas som `count` men påverkar INTE avdraget.
    Undantaget är COUNT_ESCALATION_AT: så många i samma kategori höjer graden
    ett steg, högst till 2. Tre repor är värre än en, men inte tre gånger
    värre.
    """
    groups: Dict[str, List[dict]] = {}
    for item in items or []:
        groups.setdefault(_group_key(item), []).append(item)

    out, escalated = [], []
    for key, members in groups.items():
        # Behåll posten med högst grad — dess beskrivning och placering är den
        # mest relevanta att visa användaren.
        best = max(members, key=lambda i: (i.get("grade") or 0))
        merged = dict(best)
        merged["count"] = len(members)
        grade = merged.get("grade") or 0
        if (config.COUNT_ESCALATION_AT
                and len(members) >= config.COUNT_ESCALATION_AT
                and grade < 2):
            merged["grade"] = grade + 1
            merged["gradeEscalated"] = True
            escalated.append(key)
        out.append(merged)

    stats = {
        "before": len(items or []),
        "after": len(out),
        "collapsed": len(items or []) - len(out),
        "escalated": escalated,
        "counts": {k: len(v) for k, v in groups.items() if len(v) > 1},
    }
    return out, stats


def needs_model(items: List[dict]) -> List[dict]:
    """Posterna steg 1 inte klarade — de enda som motiverar ett modellanrop."""
    return [i for i in items or [] if not i.get("category")]


# --------------------------------------------------------------------------
# Steg 2: modellanropet. Mappning och kostnad — ALDRIG detektering.
# --------------------------------------------------------------------------
MAPPING_PROMPT = """Du får en beskrivning av en skada på en begagnad möbel.
Skadan är redan identifierad av ett annat system. Din uppgift är INTE att titta
efter skador — bara att placera den beskrivna skadan i rätt fack.

Skada: "{description}"
Möbeltyp: {furniture_type}

Steg 1: Passar skadan någon av dessa kategorier?
{categories}

Om JA: svara {{"category": "<kategorinamn>"}}

Om NEJ: svara med en kostnadsuppskattning i stället:
{{"category": "unmapped",
  "repair_action": "vilken åtgärd som krävs",
  "repair_cost_sek": <mittvärde i kronor>,
  "repair_cost_range": [<lägsta>, <högsta>]}}

Kostnaden avser vad en svensk hantverkare eller verkstad tar, prisnivå 2026.

Regler:
- Gissa inte en kategori som inte passar. "unmapped" är ett korrekt svar.
- Bedöm ALDRIG priset på möbeln eller värdeminskningen. Du svarar bara på
  vilken kategori skadan hör till, eller vad åtgärden kostar.
- Bedöm inte hur allvarlig skadan är — det har det andra systemet redan gjort.

Svara som JSON.
"""


def build_mapping_prompt(description: str, furniture_type: Optional[str],
                         table_path=None) -> str:
    """Prompten för EN omappad post. Anropas bara när steg 1 missat."""
    names = categories(table_path)
    listing = ("\n".join(f"  - {n}" for n in names) if names
               else "  (tabellen är tom — svara alltid 'unmapped')")
    return MAPPING_PROMPT.format(
        description=description or "(ingen beskrivning)",
        furniture_type=furniture_type or "okänd",
        categories=listing,
    )


def parse_mapping(payload: Any) -> dict:
    """Modellens mappningssvar. Tål trasiga och tomma svar.

    Returnerar alltid en dict; tomma fält betyder "kunde inte mappa", vilket
    prissätts som noll. Ett fel här får aldrig fälla ett prissvar.
    """
    if payload is None:
        return {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            log.warning("Mappningssvaret var inte JSON")
            return {}
    if not isinstance(payload, dict):
        return {}
    category = payload.get("category")
    out = {"category": (category or "").strip().lower() or None}
    for key in ("repair_action", "repair_cost_sek", "repair_cost_range"):
        if payload.get(key) is not None:
            out[key] = payload[key]
    return out


def apply_mapping(item: dict, mapping: dict) -> dict:
    """Väver in modellens svar i en post. Graden rörs ALDRIG.

    Skadesystemet har satt graden; modellen mappar bara kategori och kostnad.
    Att låta den justera graden vore att återinföra bedömningen vi tog bort.
    """
    merged = dict(item)
    category = (mapping or {}).get("category")
    if category and category != "unmapped":
        merged["category"] = category
        merged["matchedBy"] = "model"
    else:
        merged["category"] = None
        merged["matchedBy"] = "model_unmapped"
    for source, target in (("repair_cost_sek", "repair_cost_sek"),
                           ("repair_action", "repair_action"),
                           ("repair_cost_range", "repair_cost_range")):
        if (mapping or {}).get(source) is not None:
            merged[target] = mapping[source]
    return merged
