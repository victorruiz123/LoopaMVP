"""Mottagningen av ny data: `extra/` läses tillsammans med master.parquet.

Skyddar mot ett tyst fel. `PREFERRED_FILES` gjorde tidigare att bara
master.parquet lästes när den fanns, så en ny datafil i katalogen ignorerades
utan felmeddelande — samma antal rader, samma svar, ingen ledtråd om att
inläsningen aldrig såg filen.

Testerna verifierar att den dokumenterade handvändningen i README faktiskt
fungerar: kopiera en fil till `extra/`, starta om, och raderna är med.
"""

from __future__ import annotations

import pandas as pd
import pytest

from price_engine import config
from price_engine.data_loader import discover_files, load_listings


@pytest.fixture
def data_dir(tmp_path):
    """En katalog med master.parquet, byggd som den riktiga."""
    master = pd.DataFrame({
        "title": ["IKEA Ektorp 3-sits soffa"] * 40,
        "price_sek": [1000.0 + i for i in range(40)],
        "price_kind": ["asking"] * 40,
        "source": ["archive"] * 40,
        "listed_at_ms": [1_760_000_000_000] * 40,
    })
    master.to_parquet(tmp_path / "master.parquet", index=False)
    return tmp_path


def test_master_alone_is_read(data_dir):
    assert [p.name for p in discover_files(data_dir)] == ["master.parquet"]
    assert len(load_listings(data_dir, use_cache=False)) == 40


def test_extra_file_is_picked_up(data_dir):
    """Den dokumenterade handvändningen: kopiera en fil till extra/."""
    extra = data_dir / config.EXTRA_DATA_DIR
    extra.mkdir()
    pd.DataFrame({
        "title": ["Mio Madison 3-sits soffa"] * 25,
        "price_sek": [5500.0 + i for i in range(25)],
        "price_kind": ["asking"] * 25,
        "source": ["blocket"] * 25,
        "listed_at_ms": [1_780_000_000_000] * 25,
    }).to_parquet(extra / "blocket_2026_08.parquet", index=False)

    files = [p.name for p in discover_files(data_dir)]
    assert files == ["master.parquet", "blocket_2026_08.parquet"]
    listings = load_listings(data_dir, use_cache=False)
    assert len(listings) == 65
    assert set(listings["source"]) == {"archive", "blocket"}


def test_csv_in_extra_also_works(data_dir):
    """Formatet är inte begränsat till parquet — CSV duger för en skrapning."""
    extra = data_dir / config.EXTRA_DATA_DIR
    extra.mkdir()
    pd.DataFrame({
        "title": ["Swedese Lamino fåtölj"] * 12,
        "price_sek": [9000.0 + i for i in range(12)],
        "price_kind": ["asking"] * 12,
        "source": ["blocket"] * 12,
        "listed_at_ms": [1_780_000_000_000] * 12,
    }).to_csv(extra / "ny.csv", index=False)
    assert len(load_listings(data_dir, use_cache=False)) == 52


def test_extra_rows_are_deduped_against_master(data_dir):
    """Samma annons i båda filerna räknas EN gång.

    En omskrapning av samma vecka ska inte dubblera underlaget — det hade gett
    varje dubblerad annons dubbel vikt i medianen.
    """
    extra = data_dir / config.EXTRA_DATA_DIR
    extra.mkdir()
    pd.DataFrame({
        "title": ["IKEA Ektorp 3-sits soffa"] * 40,      # identisk med master
        "price_sek": [1000.0 + i for i in range(40)],   # samma priser som master
        "price_kind": ["asking"] * 40,
        "source": ["blocket"] * 40,
        "listed_at_ms": [1_760_000_000_000] * 40,
    }).to_parquet(extra / "omskrapning.parquet", index=False)
    listings = load_listings(data_dir, use_cache=False)
    # Dedup på (name_norm, price, condition_norm): omskrapningen är radvis
    # identisk med master, så inga rader tillkommer.
    assert len(listings) == 40


def test_cache_key_changes_when_extra_is_added(data_dir):
    """Cachen får aldrig servera den gamla korpusen efter ny data.

    Nyckeln innehåller filernas sökväg, mtid och storlek, så en tillagd fil ger
    en ny nyckel utan att CACHE_VERSION behöver höjas. Utan det hade första
    körningen efter en datainläsning tyst läst gammal cache.
    """
    from price_engine.data_loader import _cache_path

    before = _cache_path(discover_files(data_dir))
    extra = data_dir / config.EXTRA_DATA_DIR
    extra.mkdir()
    pd.DataFrame({
        "title": ["Nytt bord"] * 5, "price_sek": [500.0 + i for i in range(5)],
        "price_kind": ["asking"] * 5, "source": ["blocket"] * 5,
        "listed_at_ms": [1_780_000_000_000] * 5,
    }).to_parquet(extra / "ny.parquet", index=False)
    assert _cache_path(discover_files(data_dir)) != before
