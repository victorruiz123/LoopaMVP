"""Fas 4 — vektorlagret: läs in embeddings och slå upp dem per annons.

Vektorerna nycklas på **URL-hash, inte annons-ID**, så att flera annonser med
samma bild delar rad. Uppslaget annons -> rad görs därför genom att hasha
annonsens `image_url` med samma funktion som cachen använder.

Lagret laddas en gång och hålls i minnet: 94k x 384 float16 är ~70 MB, vilket
inte är värt en vektordatabas. FAISS-indexet finns för helbeståndssökning och
analys, men API-flödet använder numpy — vid re-ranking av ~200 kandidater är en
skalärprodukt snabbare än ett indexuppslag.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from . import config
from .images import cache_path, normalize_url

log = logging.getLogger(__name__)


@dataclass
class VectorStore:
    """Embeddings + färghistogram, uppslagsbara per annons."""

    embeddings: np.ndarray = field(default_factory=lambda: np.zeros((0, config.EMBED_DIM), np.float16))
    colors: np.ndarray = field(default_factory=lambda: np.zeros((0, 3 * config.COLOR_BINS), np.float16))
    cropped: np.ndarray = field(default_factory=lambda: np.zeros(0, bool))
    row_of: dict = field(default_factory=dict)  # url-hash -> radindex

    def __len__(self) -> int:
        return len(self.embeddings)

    @property
    def ready(self) -> bool:
        return len(self) > 0

    def rows_for(self, listings: pd.DataFrame) -> np.ndarray:
        """Radindex per annons, -1 där vektor saknas."""
        if not self.ready or "image_url" not in listings.columns:
            return np.full(len(listings), -1, dtype=np.int64)
        keys = listings["image_url"].map(
            lambda u: cache_path(u).stem if isinstance(u, str) and u else None
        )
        return keys.map(lambda k: self.row_of.get(k, -1)).to_numpy(dtype=np.int64)


def _store_dir() -> Path:
    return Path(config.VECTOR_DIR)


def load_vectors(directory: Path | None = None) -> VectorStore:
    """Läser vektorlagret. Tomt lager om jobbet inte körts — motorn fungerar ändå."""
    base = Path(directory) if directory else _store_dir()
    emb_path, ids_path = base / "embeddings.npy", base / "ids.json"
    if not (emb_path.is_file() and ids_path.is_file()):
        log.info("Inget vektorlager i %s — bildsökning avstängd", base)
        return VectorStore()

    embeddings = np.load(emb_path)
    ids = json.loads(ids_path.read_text())
    colors_path, cropped_path = base / "colors.npy", base / "cropped.npy"
    colors = np.load(colors_path) if colors_path.is_file() else np.zeros(
        (len(embeddings), 3 * config.COLOR_BINS), np.float16
    )
    cropped = np.load(cropped_path) if cropped_path.is_file() else np.zeros(
        len(embeddings), bool
    )

    # Skärmdumpar från ikea.se/jysk.se ligger i bilddatan som annonsbilder och
    # embeddas som möbler. 38 hittades i parmätningen. De maskeras här i stället
    # för att raderas ur skärvorna, så att listan går att revidera utan att
    # embeddingjobbet körs om.
    blocked_path = base / "blocked.json"
    blocked = set(json.loads(blocked_path.read_text())) if blocked_path.is_file() else set()
    if blocked:
        keep = np.array([key not in blocked for key in ids])
        removed = int((~keep).sum())
        embeddings, colors, cropped = embeddings[keep], colors[keep], cropped[keep]
        ids = [key for key, ok in zip(ids, keep) if ok]
        log.info("Blocklista: %d vektorer maskerade (skärmdumpar)", removed)

    if len(ids) != len(embeddings):  # skadat lager — hellre tomt än fel
        log.error("ids.json (%d) matchar inte embeddings (%d)", len(ids), len(embeddings))
        return VectorStore()

    log.info("Vektorlager: %s bilder, %.0f %% beskurna", f"{len(ids):,}", 100 * cropped.mean())
    return VectorStore(
        embeddings=embeddings,
        colors=colors,
        cropped=cropped,
        row_of={key: i for i, key in enumerate(ids)},
    )


def load_faiss(directory: Path | None = None):
    """FAISS-indexet för helbeståndssökning. None om det saknas."""
    base = Path(directory) if directory else _store_dir()
    path = base / "index.faiss"
    if not path.is_file():
        return None
    try:
        import faiss

        return faiss.read_index(str(path))
    except Exception as exc:  # pragma: no cover
        log.warning("Kunde inte läsa FAISS-index: %s", exc)
        return None
