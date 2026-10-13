"""Deterministic MAGIC HEDGE scenario for the implementation portion.

Run this after implementing ``rare_bird_alerts`` in question.py. Change a time,
an observer, or a species and predict the result before running it again.

The scenario is one May morning built from explicit checklists.

Edits worth trying:
- Move Ben's warbler to 08:11 (61 minutes after Ana's). Predict first.
- Give Ana a second warbler at 08:00 and move Ben's to 08:40.
- Add a Piping Plover to Ben's list at 08:50. Then give it to Cara instead.
"""

from datetime import date, datetime
from question import SightingLog


DAY = date(2026, 5, 14)

# observer -> (checklist start, [(species, count, "HH:MM"), ...])
CHECKLISTS = {
    "Ana": ("06:45", [
        ("Ring-billed Gull", 40, "06:50"),
        ("gull sp.", 12, "06:55"),
        ("Kirtland's Warbler", 1, "08:11"),
        ("American Robin", 6, "07:20"),
    ]),
    "Ben": ("07:00", [
        ("Ring-billed Gull", 35, "07:05"),
        ("Red-winged Blackbird", 8, "07:30"),
        ("Kirtland's Warbler", 1, "07:45"),  # 35 minutes after Ana's
    ]),
    "Cara": ("08:00", [
        ("Piping Plover", 1, "08:15"),  # a lone plover; Monty and Rose would understand
        ("Ring-billed Gull", 22, "08:20"),
    ]),
}


def at(hhmm: str) -> datetime:
    hour, minute = (int(part) for part in hhmm.split(":"))
    return datetime(DAY.year, DAY.month, DAY.day, hour, minute)


def main() -> None:
    log = SightingLog()
    for observer, (started, sightings) in CHECKLISTS.items():
        checklist_id = log.start_checklist(observer, at(started))
        for species, count, seen in sightings:
            log.add_sighting(checklist_id, species, count, at(seen))
        log.submit(checklist_id)
        print(f"{checklist_id}: {observer}, {len(sightings)} sightings")

    print(f"\ntotals for {DAY}:")
    for species, count in sorted(log.day_totals(DAY).items()):
        print(f"  {species}: {count}")

    try:
        alerts = log.rare_bird_alerts(DAY)
    except NotImplementedError:
        print("\nalerts: rare_bird_alerts is not implemented yet")
        return

    print("\nalerts:")
    if not alerts:
        print("  (none)")
    for alert in alerts:
        observers = ", ".join(alert.observers)
        print(f"  {alert.confirmed_at:%H:%M} {alert.species} ({observers})")


if __name__ == "__main__":
    main()
