"""Kolumnvitlistan: okända fält får aldrig passera in i motorn.

Inläsningen var TILLÅTANDE — den läste varje kolumn i filen och kastade det den
inte kände igen efteråt. Följden var att `description`, `condition_text`, `lat`
och `lon` lästes in i minnet vid varje uppstart trots att motorn aldrig använde
dem, och att ingen upptäckte att de fanns kvar i filen.

**Testerna failar om en okänd kolumn passerar.** Det är hela poängen: en
framtida skrapning ska inte kunna dra in fält vi inte bett om.
"""

from __future__ import annotations

import pandas as pd
import pytest

from price_engine import config
from price_engine.data_loader import _allowed, load_listings


#: Fälten som faktiskt fanns i rådatan och som saneringen tog bort.
REAL_OFFENDERS = ["description", "condition_text", "canonical_text",
                  "lat", "lon", "seller_type", "url", "href", "click_id"]


def _file_with(tmp_path, extra_columns: dict):
    base = {
        "title": ["IKEA Ektorp 3-sits soffa"] * 20,
        "price_sek": [1000.0 + i for i in range(20)],
        "price_kind": ["asking"] * 20,
        "source": ["blocket"] * 20,
        "listed_at_ms": [1_780_000_000_000] * 20,
    }
    base.update({k: [v] * 20 for k, v in extra_columns.items()})
    pd.DataFrame(base).to_parquet(tmp_path / "master.parquet", index=False)
    return tmp_path


def test_forbidden_columns_never_pass(tmp_path):
    """Kärntestet: de verkliga syndarna får inte överleva inläsningen."""
    data_dir = _file_with(tmp_path, {c: "hemligt" for c in REAL_OFFENDERS})
    listings = load_listings(data_dir, use_cache=False)
    for column in REAL_OFFENDERS:
        assert column not in listings.columns, column


def test_unknown_column_is_skipped(tmp_path):
    """Ett fält ingen bett om ska inte dyka upp bara för att det finns i filen."""
    data_dir = _file_with(tmp_path, {"nytt_falt_2027": "x",
                                     "seller_phone": "070-1234567"})
    listings = load_listings(data_dir, use_cache=False)
    assert "nytt_falt_2027" not in listings.columns
    assert "seller_phone" not in listings.columns


def test_allowed_filters_the_column_list():
    available = ["title", "price_sek", "description", "lat", "lon",
                 "damage_wear", "okant"]
    keep = _allowed(available)
    assert "title" in keep and "price_sek" in keep and "damage_wear" in keep
    for bad in ("description", "lat", "lon", "okant"):
        assert bad not in keep, bad


def test_forbidden_wins_over_whitelist(monkeypatch):
    """Dubbel spärr: även om någon lägger till ett förbjudet fält i vitlistan
    släpps det inte in. Att glömma bort varför ett fält är förbjudet är
    lättare än att glömma bort att man tagit bort det ur två listor."""
    monkeypatch.setattr(config, "COLUMN_CANDIDATES",
                        {**config.COLUMN_CANDIDATES, "x": ("description",)})
    assert "description" not in _allowed(["title", "description"])


def test_damage_columns_are_allowed():
    """De härledda flaggorna ersätter condition_text och MÅSTE släppas in."""
    keep = _allowed(list(config.DAMAGE_COLUMNS) + ["title"])
    for column in config.DAMAGE_COLUMNS:
        assert column in keep, column


def test_engine_corpus_has_no_protected_columns():
    """Den riktiga korpusen, inte bara ett fixture."""
    listings = load_listings()
    for column in REAL_OFFENDERS:
        assert column not in listings.columns, column
