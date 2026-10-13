"""MAGIC HEDGE starter implementation.

The shipped tests pass, but that does not mean the implementation matches the
volunteer notes. Review the behavior before implementing ``rare_bird_alerts``.
"""

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Dict, List, Tuple


# Every time in this log is a naive datetime in sanctuary local time (Chicago).
# There are no time zones to convert, and nobody is counting warblers at 2am on
# the night the clocks change.
ALERT_WINDOW = timedelta(minutes=60)

# Species the sanctuary expects to see, by month number. Trimmed for the
# exercise; the real list is much longer. Anything not on its month's list is
# rare.
EXPECTED_BY_MONTH = {
    5: (
        "Ring-billed Gull", "Herring Gull", "American Robin", "Red-winged Blackbird",
        "Canada Goose", "Mallard", "Song Sparrow", "Yellow Warbler",
        "Common Grackle", "Barn Swallow", "White-throated Sparrow",
        "Double-crested Cormorant",
    ),
    6: (
        "Ring-billed Gull", "Herring Gull", "American Robin", "Red-winged Blackbird",
        "Canada Goose", "Mallard", "Song Sparrow", "Yellow Warbler",
        "Common Grackle", "Barn Swallow", "Cedar Waxwing",
    ),
}


class LogError(Exception):
    pass


@dataclass(frozen=True)
class Sighting:
    species: str  # exactly as the volunteer typed it
    count: int
    seen_at: datetime


@dataclass
class Checklist:
    id: str
    observer: str
    started_at: datetime
    sightings: List[Sighting] = field(default_factory=list)
    submitted: bool = False


@dataclass(frozen=True)
class Alert:
    species: str  # normalized name, as returned by normalize_species
    confirmed_at: datetime  # seen_at of the report that made it two observers
    observers: Tuple[str, ...]  # sorted, distinct, within the hour ending then


def normalize_species(name: str) -> str:
    return name.strip()


def counts_as_species(name: str) -> bool:
    return not normalize_species(name).endswith(" sp.")


def is_expected(species: str, month: int) -> bool:
    expected = {normalize_species(name) for name in EXPECTED_BY_MONTH.get(month, ())}
    return normalize_species(species) in expected


class SightingLog:
    def __init__(self):
        self._checklists: Dict[str, Checklist] = {}
        self._next_id = 1

    def _get(self, checklist_id: str) -> Checklist:
        if checklist_id not in self._checklists:
            raise LogError(f"unknown checklist: {checklist_id}")
        return self._checklists[checklist_id]

    def start_checklist(self, observer: str, started_at: datetime) -> str:
        if not observer or not observer.strip():
            raise LogError("observer is required")
        if not isinstance(started_at, datetime):
            raise LogError("started_at must be a datetime")

        checklist_id = f"checklist-{self._next_id}"
        self._next_id += 1
        self._checklists[checklist_id] = Checklist(
            id=checklist_id, observer=observer.strip(), started_at=started_at
        )
        return checklist_id

    def add_sighting(
        self, checklist_id: str, species: str, count: int, seen_at: datetime
    ) -> Sighting:
        checklist = self._get(checklist_id)
        if not species or not species.strip():
            raise LogError("species is required")
        if isinstance(count, bool) or not isinstance(count, int) or count < 1:
            raise LogError("count must be a whole number of at least 1")
        if not isinstance(seen_at, datetime):
            raise LogError("seen_at must be a datetime")

        sighting = Sighting(species=species, count=count, seen_at=seen_at)
        checklist.sightings.append(sighting)
        return sighting

    def submit(self, checklist_id: str) -> None:
        self._get(checklist_id).submitted = True

    def day_totals(self, day: date) -> Dict[str, int]:
        totals: Dict[str, int] = {}
        for checklist in self._checklists.values():
            if not checklist.submitted:
                continue
            if checklist.started_at.date() != day:
                continue
            for sighting in checklist.sightings:
                if not counts_as_species(sighting.species):
                    continue
                name = normalize_species(sighting.species)
                totals[name] = totals.get(name, 0) + sighting.count
        return totals

    def rare_bird_alerts(self, day: date) -> List[Alert]:
        """Return the rare bird alerts for one day.

        Implement this after reviewing the existing code. Use the clarified
        rules, and add tests for cases the shipped suite misses.
        """

        raise NotImplementedError("candidate task")


# === SHIPPED TESTS ===

MAY_14 = date(2026, 5, 14)


def at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 5, 14, hour, minute)


def test_checklist_ids_are_assigned():
    log = SightingLog()
    assert log.start_checklist("Ana", at(7)) == "checklist-1"
    assert log.start_checklist("Ben", at(7, 5)) == "checklist-2"


def test_submitted_checklist_counts_toward_totals():
    log = SightingLog()
    checklist = log.start_checklist("Ana", at(7))
    log.add_sighting(checklist, "Ring-billed Gull", 40, at(7, 5))
    log.add_sighting(checklist, "  American Robin ", 3, at(7, 10))
    log.submit(checklist)

    assert log.day_totals(MAY_14) == {
        normalize_species("Ring-billed Gull"): 40,
        normalize_species("American Robin"): 3,
    }


def test_unsubmitted_checklist_is_ignored():
    log = SightingLog()
    checklist = log.start_checklist("Ana", at(7))
    log.add_sighting(checklist, "Ring-billed Gull", 40, at(7, 5))

    assert log.day_totals(MAY_14) == {}


def test_unidentified_gull_is_not_a_species():
    log = SightingLog()
    checklist = log.start_checklist("Ben", at(8))
    log.add_sighting(checklist, "gull sp.", 12, at(8, 5))
    log.add_sighting(checklist, "Herring Gull", 2, at(8, 10))
    log.submit(checklist)

    assert counts_as_species("Herring Gull")
    assert not counts_as_species("gull sp.")
    assert log.day_totals(MAY_14) == {normalize_species("Herring Gull"): 2}


def test_zero_count_is_rejected():
    log = SightingLog()
    checklist = log.start_checklist("Ana", at(7))
    try:
        log.add_sighting(checklist, "Mallard", 0, at(7, 5))
    except LogError:
        pass
    else:
        raise AssertionError("expected LogError")


def _run_tests() -> None:
    failures = 0
    tests = [
        value
        for name, value in globals().items()
        if name.startswith("test_") and callable(value)
    ]
    tests.sort(key=lambda test: test.__name__)
    for test in tests:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception as exc:  # Simple dependency-free runner for CodePair.
            failures += 1
            print(f"FAIL {test.__name__}: {exc}")

    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    _run_tests()
