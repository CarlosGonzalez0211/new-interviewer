"""Hidden acceptance tests: daily totals, species rules, normalization, immutability.

These only use day_totals / counts_as_species / normalize_species / add_sighting,
so on the buggy starter they fail because of the planted defects.
"""
from datetime import date, datetime

from question import LogError, SightingLog, counts_as_species, is_expected, normalize_species

D14 = date(2026, 5, 14)
D15 = date(2026, 5, 15)


def t(day, hhmm):
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime(2026, 5, day, h, m)


def submitted(log, observer, start, sightings):
    cid = log.start_checklist(observer, t(*start))
    for species, count, day, hhmm in sightings:
        log.add_sighting(cid, species, count, t(day, hhmm))
    log.submit(cid)
    return cid


def test_acc_daily_count_is_highest_across_checklists():
    log = SightingLog()
    submitted(log, "Ana", (14, "06:45"), [("Ring-billed Gull", 40, 14, "06:50")])
    submitted(log, "Ben", (14, "07:00"), [("Ring-billed Gull", 35, 14, "07:05")])
    submitted(log, "Cara", (14, "08:00"), [("Ring-billed Gull", 22, 14, "08:20")])
    assert log.day_totals(D14) == {normalize_species("Ring-billed Gull"): 40}


def test_acc_daily_count_takes_max_within_one_checklist():
    # Assumption: repeats of a species on a single checklist are not summed.
    log = SightingLog()
    submitted(log, "Ana", (14, "07:00"), [
        ("American Robin", 5, 14, "07:05"),
        ("American Robin", 8, 14, "07:40"),
    ])
    assert log.day_totals(D14) == {normalize_species("American Robin"): 8}


def test_acc_sighting_belongs_to_day_it_was_seen():
    log = SightingLog()
    submitted(log, "Ana", (14, "23:40"), [
        ("Mallard", 3, 14, "23:50"),
        ("Mallard", 9, 15, "00:10"),
        ("Canada Goose", 4, 15, "00:20"),
    ])
    assert log.day_totals(D14) == {normalize_species("Mallard"): 3}
    assert log.day_totals(D15) == {
        normalize_species("Mallard"): 9,
        normalize_species("Canada Goose"): 4,
    }


def test_acc_checklist_started_earlier_does_not_claim_next_day_sightings():
    log = SightingLog()
    submitted(log, "Ana", (14, "23:40"), [("Mallard", 2, 15, "00:05")])
    assert log.day_totals(D14) == {}
    assert log.day_totals(D15) == {normalize_species("Mallard"): 2}


def test_acc_slash_entries_are_not_species():
    assert not counts_as_species("Greater/Lesser Scaup")
    assert not counts_as_species("  Greater / Lesser Scaup ")
    assert counts_as_species("Lesser Scaup")
    log = SightingLog()
    submitted(log, "Ana", (14, "07:00"), [
        ("Greater/Lesser Scaup", 6, 14, "07:05"),
        ("Mallard", 2, 14, "07:10"),
    ])
    assert log.day_totals(D14) == {normalize_species("Mallard"): 2}


def test_acc_sp_entries_ignore_case_and_spacing():
    for name in ("gull sp.", "Gull SP.", "  Gull sp.  ", "Gull   sp."):
        assert not counts_as_species(name), name
    assert counts_as_species("Spotted Sandpiper")
    log = SightingLog()
    submitted(log, "Ana", (14, "07:00"), [
        ("Gull SP.", 12, 14, "07:05"),
        (" warbler sp. ", 2, 14, "07:06"),
        ("Herring Gull", 2, 14, "07:10"),
    ])
    assert log.day_totals(D14) == {normalize_species("Herring Gull"): 2}


def test_acc_species_names_ignore_case_and_surrounding_spaces():
    assert normalize_species("  AMERICAN robin ") == normalize_species("American Robin")
    assert normalize_species("Mallard") != normalize_species("Herring Gull")
    log = SightingLog()
    submitted(log, "Ana", (14, "07:00"), [("American Robin", 3, 14, "07:05")])
    submitted(log, "Ben", (14, "07:00"), [("  american ROBIN ", 7, 14, "07:10")])
    totals = log.day_totals(D14)
    assert len(totals) == 1, totals
    assert list(totals.values()) == [7]


def test_acc_expected_species_lookup_ignores_case_and_spaces():
    assert is_expected("  mallard ", 5)
    assert is_expected("RING-BILLED GULL", 6)
    assert not is_expected("Kirtland's Warbler", 5)


def test_acc_submitted_checklist_rejects_new_sightings():
    log = SightingLog()
    cid = submitted(log, "Ana", (14, "07:00"), [("Mallard", 2, 14, "07:05")])
    try:
        log.add_sighting(cid, "Mallard", 50, t(14, "07:30"))
    except LogError:
        pass
    else:
        raise AssertionError("expected LogError for a submitted checklist")
    assert log.day_totals(D14) == {normalize_species("Mallard"): 2}


def test_acc_submit_is_idempotent():
    log = SightingLog()
    cid = submitted(log, "Ana", (14, "07:00"), [("Mallard", 2, 14, "07:05")])
    log.submit(cid)
    assert log.day_totals(D14) == {normalize_species("Mallard"): 2}
