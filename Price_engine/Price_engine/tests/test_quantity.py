"""Antalsdetektering. Fällorna är viktigare än träffarna.

En felaktig styckdelning gör priset katastrofalt lågt, och systemet lutar redan
lågt — alla sex katastrofmissar i benchmarken är negativa. Testerna nedan lägger
därför mer vikt på vad som INTE får delas än på vad som ska.
"""

from __future__ import annotations

import pytest

from type_system.quantity import MAX_UNITS, per_unit, units


# --------------------------------------------------------------------------
# Ska detekteras
# --------------------------------------------------------------------------
@pytest.mark.parametrize("title,expected", [
    ('Stolar, 6 st, "Victoria Ghost", Kartell', 6),
    ('Karmstolar, 8 st, "Louis Ghost", formgjuten', 8),
    ("STOLAR, 2 stycken, gustavianska, Lindome", 2),
    ("Matstolar 4 st ek", 4),
    ("Möbelben i vitt, 4-pack till säng", 4),
    ('Fåtöljer "Mina", ett par, för Bruno Mathsson', 2),
    ("Stolar, 1 par, Wegner", 2),
    ("Fåtöljer, ett par", 2),
])
def test_counts_are_detected(title, expected):
    assert units(title) == expected


# --------------------------------------------------------------------------
# Får ALDRIG detekteras — fällorna
# --------------------------------------------------------------------------
@pytest.mark.parametrize("title", [
    "SOFFA, 3-sits, benställning i ek",          # sitsantal
    "Soffa 3 sits grå",
    "Bäddsoffa 2-sits",
    "Soffa, 2 år gammal, mycket bra skick",      # ålder
    "Matbord 180 cm",                            # mått
    "Bord 90x180 cm ek",
    "3delar, bok, Avanti, DUX. tv-bänk",         # tredelad möbel, ej 3 enheter
    "Soffgrupp 3 delar",
    "Byrå med 6 lådor",                          # lådor är inte enheter
    "Ektorp 2-sitssoffa",
    "Vitrinskåp 4 hyllplan",
])
def test_traps_are_not_counted(title):
    assert units(title) is None, title


def test_seat_count_and_unit_count_together():
    """Ett sitsantal ska inte blockera ett äkta styckantal i samma titel."""
    assert units("Soffa 3-sits + fåtöljer, 2 st") == 2


def test_conflicting_counts_are_refused():
    """Två olika antal -> rör inte priset.

    Att gissa vilket som gäller är precis den sorts gissning som gör felet
    katastrofalt i stället för bara fel.
    """
    assert units("Stolar 4 st och bord 2 st") is None


def test_one_is_not_a_count():
    """"1 st" betyder ingen delning."""
    assert units("Fåtölj, 1 st, Lamino") is None


def test_absurd_counts_are_refused():
    assert units("Skruvar 200 st") is None
    assert units(f"Stolar {MAX_UNITS + 1} st") is None


def test_empty_and_none_are_safe():
    assert units("") is None
    assert units(None) is None


# --------------------------------------------------------------------------
# per_unit: delningen
# --------------------------------------------------------------------------
def test_per_unit_divides():
    price, count = per_unit(2667.0, 'Stolar, 6 st, "Victoria Ghost"')
    assert count == 6
    assert 444 <= price <= 445         # facit för b1#8 var 1 000-2 000 per stol


def test_per_unit_leaves_price_alone_when_unknown():
    price, count = per_unit(2667.0, "SOFFA, 3-sits, ek")
    assert count is None
    assert price == 2667.0


def test_per_unit_refuses_nonpositive_price():
    assert per_unit(0.0, "Stolar 6 st") == (0.0, None)
    assert per_unit(None, "Stolar 6 st") == (None, None)
