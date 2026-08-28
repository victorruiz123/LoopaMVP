"""L1 — modellnamnsprior. Gratis, deterministisk, och hittills oanvänd.

Idén: databasen vet redan vad en Lamino är. I annonser där texten är tydlig kan
attributfördelningen räknas per modellord, och den fördelningen används sedan för
att fylla i attribut som en *ny* förfrågan är tyst om.

Priorn har två roller:

1. **Ifyllnad.** "Lamino" utan möbelord -> `base=stol`, eftersom 98 % av alla
   Lamino-annonser är stolar.
2. **Spärr.** Säger bilden "bord" men modellordet är Lamino, är bilden fel.
   Detta är den enda mekanismen i kedjan som kan avvisa ett bildsvar på
   annat än konfidens.

**Entropin avgör om priorn får tala.** Ett modellord som fördelar sig jämnt över
fem bastyper vet ingenting — `Kivik` finns som rak soffa, hörnsoffa och
bäddsoffa, och dess prior på `corner` är värdelös även om dess prior på `base`
är stark. Därför lagras entropi per (modellord, attribut), inte per modellord.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Dict, Optional, Tuple

from price_engine.data_loader import normalize_text

from .attributes import Attributes

DEFAULT_PATH = Path("model_type_prior.json")

#: Under så många annonser är fördelningen brus.
MIN_LISTINGS = 12
#: Normaliserad entropi över detta -> modellordet säger inget användbart.
#: 0,5 av maxentropi valdes som mittpunkt; kalibreras i measure_type_system.py
#: mot kronofelsmåttet, inte mot benchmarkmöblerna.
MAX_ENTROPY = 0.50
#: Dominerande värde måste ha minst denna andel för att få fylla i.
MIN_SHARE = 0.70


def entropy(distribution: Dict[str, float]) -> float:
    """Normaliserad Shannonentropi, 0 = säker, 1 = vet ingenting."""
    total = sum(distribution.values())
    if total <= 0:
        return 1.0
    shares = [v / total for v in distribution.values() if v > 0]
    if len(shares) <= 1:
        return 0.0
    raw = -sum(s * math.log(s) for s in shares)
    return raw / math.log(len(shares)) if len(shares) > 1 else 0.0


class Prior:
    """Uppslagning av attributfördelningar per modellord."""

    def __init__(self, table: Optional[dict] = None) -> None:
        self.table = table or {}

    @classmethod
    def load(cls, path: Path = DEFAULT_PATH) -> "Prior":
        if not Path(path).exists():
            return cls({})
        return cls(json.loads(Path(path).read_text()))

    @property
    def ready(self) -> bool:
        return bool(self.table)

    def lookup(self, text: str) -> Tuple[Optional[str], dict]:
        """Hittar det mest informativa modellordet i texten.

        Vid flera träffar vinner det med flest annonser bakom sig — ett vanligt
        modellord är mer sannolikt det användaren menar än ett sällsynt som råkar
        förekomma i beskrivningen.
        """
        folded = normalize_text(text or "")
        best_token, best_entry, best_n = None, {}, -1
        for token in folded.split():
            entry = self.table.get(token)
            if entry and entry.get("n", 0) > best_n:
                best_token, best_entry, best_n = token, entry, entry["n"]
        return best_token, best_entry

    def _usable(self, block: dict) -> bool:
        return (block.get("entropy", 1.0) <= MAX_ENTROPY
                and block.get("share", 0.0) >= MIN_SHARE
                and block.get("n", 0) >= MIN_LISTINGS)

    def apply(self, text: str, attrs: Attributes) -> Optional[str]:
        """Fyller i attribut som texten är tyst om. Returnerar modellordet.

        Skriver aldrig över `text`-källan: `Attributes.set` upprätthåller
        källhierarkin strukturellt, så ordningen här kan inte råka bli fel.

        **Undertypsattribut hämtas betingat på bastypen.** Utan betingning
        förorenar andra möbler i samma annons: `Lamino` fick
        `sub=sidobord` i 89 % av fallen (från Lamino-bordet som säljs
        tillsammans med stolen) och `Kivik` fick `storage_kind=hylla` i 99 %
        (från hyllan i samma annons). Båda är osanna om själva möbeln, och
        båda försvinner när fördelningen räknas per bastyp.
        """
        token, entry = self.lookup(text)
        if not token or entry.get("n", 0) < MIN_LISTINGS:
            return None

        base_block = entry.get("attributes", {}).get("base")
        if base_block and not attrs.known("base") and self._usable(base_block):
            attrs.set("base", base_block["value"], "prior", base_block["share"],
                      f"{token}: {base_block['share']:.0%} av "
                      f"{base_block['n']} annonser")

        base = attrs.get("base")
        if base is None:
            return token
        for name, block in entry.get("by_base", {}).get(str(base), {}).items():
            if attrs.known(name) or not self._usable(block):
                continue
            attrs.set(name, block.get("value"), "prior", block["share"],
                      f"{token} som {base}: {block['share']:.0%} av "
                      f"{block['n']} annonser")
        return token

    def contradicts(self, text: str, name: str, value) -> bool:
        """Motsäger priorn ett påstått attributvärde? Används som bildspärr.

        Detta är den enda mekanismen i kedjan som kan avvisa ett bildsvar på
        annan grund än bildens egen konfidens. Säger bilden "bord" och
        modellordet är Lamino, är bilden fel — hur säker den än är.
        """
        token, entry = self.lookup(text)
        if not token or entry.get("n", 0) < MIN_LISTINGS:
            return False
        block = entry.get("attributes", {}).get(name)
        if not block or not self._usable(block):
            return False
        return bool(block.get("value") != value)
