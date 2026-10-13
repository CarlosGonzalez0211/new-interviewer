"""Hidden acceptance tests for rare_bird_alerts(day)."""
from datetime import date, datetime

from question import SightingLog, normalize_species

D14 = date(2026, 5, 14)
D15 = date(2026, 5, 15)
WARBLER = normalize_species("Kirtland's Warbler")


def t(day, hhmm, month=5):
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime(2026, month, day, h, m)


def submitted(log, observer, start, sightings, month=5, submit=True):
    """start: (day, 'HH:MM'); sightings: [(species, count, day, 'HH:MM')]."""
    cid = log.start_checklist(observer, t(start[0], start[1], month))
    for species, count, day, hhmm in sightings:
        log.add_sighting(cid, species, count, t(day, hhmm, month))
    if submit:
        log.submit(cid)
    return cid


def pair(log, first, second, species="Kirtland's Warbler", names=("Ana", "Ben")):
    submitted(log, names[0], (14, "06:00"), [(species, 1, 14, first)])
    submitted(log, names[1], (14, "06:00"), [(species, 1, 14, second)])


def test_alert_confirmed_at_second_report():
    log = SightingLog()
    pair(log, "08:11", "07:45")
    alerts = log.rare_bird_alerts(D14)
    assert len(alerts) == 1, alerts
    a = alerts[0]
    assert a.species == WARBLER
    assert a.confirmed_at == t(14, "08:11")
    assert a.observers == ("Ana", "Ben")


def test_alert_exactly_sixty_minutes_counts():
    log = SightingLog()
    pair(log, "07:00", "08:00")
    alerts = log.rare_bird_alerts(D14)
    assert [a.confirmed_at for a in alerts] == [t(14, "08:00")]


def test_alert_sixty_one_minutes_does_not_count():
    log = SightingLog()
    pair(log, "07:00", "08:01")
    assert log.rare_bird_alerts(D14) == []


def test_alert_same_observer_twice_never_confirms():
    log = SightingLog()
    submitted(log, "Ana", (14, "06:00"), [
        ("Kirtland's Warbler", 1, 14, "07:00"),
        ("Kirtland's Warbler", 1, 14, "07:10"),
    ])
    submitted(log, "  ana ", (14, "07:00"), [("kirtland's warbler", 1, 14, "07:20")])
    assert log.rare_bird_alerts(D14) == []


def test_alert_ignores_unsubmitted_checklists():
    log = SightingLog()
    submitted(log, "Ana", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "07:00")])
    submitted(log, "Ben", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "07:10")], submit=False)
    assert log.rare_bird_alerts(D14) == []


def test_alert_never_for_expected_species():
    log = SightingLog()
    pair(log, "07:00", "07:10", species="Mallard")
    assert log.rare_bird_alerts(D14) == []


def test_alert_expected_list_depends_on_month():
    # Cedar Waxwing is expected in June, rare in May.
    may = SightingLog()
    pair(may, "07:00", "07:10", species="Cedar Waxwing")
    assert [a.species for a in may.rare_bird_alerts(D14)] == [normalize_species("Cedar Waxwing")]

    june = SightingLog()
    submitted(june, "Ana", (14, "06:00"), [("Cedar Waxwing", 2, 14, "07:00")], month=6)
    submitted(june, "Ben", (14, "06:00"), [("Cedar Waxwing", 1, 14, "07:10")], month=6)
    assert june.rare_bird_alerts(date(2026, 6, 14)) == []


def test_alert_month_comes_from_seen_at_not_checklist_start():
    log = SightingLog()
    # Checklists start on May 31 but the birds are seen on June 1, when
    # Cedar Waxwing is expected.
    for who in ("Ana", "Ben"):
        cid = log.start_checklist(who, datetime(2026, 5, 31, 23, 50))
        log.add_sighting(cid, "Cedar Waxwing", 1, datetime(2026, 6, 1, 0, 10))
        log.submit(cid)
    assert log.rare_bird_alerts(date(2026, 6, 1)) == []


def test_alert_sp_and_slash_entries_never_alert():
    log = SightingLog()
    pair(log, "07:00", "07:10", species="warbler sp.")
    pair(log, "07:00", "07:10", species="Greater/Lesser Scaup")
    pair(log, "07:00", "07:10", species="Gull SP.")
    assert log.rare_bird_alerts(D14) == []


def test_alert_case_and_space_variants_are_the_same_species():
    log = SightingLog()
    submitted(log, "Ana", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "07:00")])
    submitted(log, "Ben", (14, "06:00"), [("  KIRTLAND'S warbler ", 1, 14, "07:30")])
    alerts = log.rare_bird_alerts(D14)
    assert len(alerts) == 1, alerts
    assert alerts[0].species == WARBLER
    assert alerts[0].observers == ("Ana", "Ben")


def test_alert_observer_names_ignore_case_and_spaces():
    log = SightingLog()
    submitted(log, "Ana", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "07:00")])
    submitted(log, "ANA ", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "07:30")])
    assert log.rare_bird_alerts(D14) == []


def test_alert_after_midnight_belongs_to_next_day():
    log = SightingLog()
    for who, hhmm in (("Ana", "00:10"), ("Ben", "00:40")):
        cid = log.start_checklist(who, t(14, "23:40"))
        log.add_sighting(cid, "Kirtland's Warbler", 1, t(15, hhmm))
        log.submit(cid)
    assert log.rare_bird_alerts(D14) == []
    alerts = log.rare_bird_alerts(D15)
    assert [(a.species, a.confirmed_at) for a in alerts] == [(WARBLER, t(15, "00:40"))]


def test_alert_pair_straddling_midnight_does_not_alert_either_day():
    log = SightingLog()
    submitted(log, "Ana", (14, "23:00"), [("Kirtland's Warbler", 1, 14, "23:50")])
    submitted(log, "Ben", (14, "23:00"), [("Kirtland's Warbler", 1, 15, "00:20")])
    assert log.rare_bird_alerts(D14) == []
    assert log.rare_bird_alerts(D15) == []


def test_alert_identical_timestamp_confirms():
    log = SightingLog()
    pair(log, "07:30", "07:30")
    alerts = log.rare_bird_alerts(D14)
    assert [(a.confirmed_at, a.observers) for a in alerts] == [(t(14, "07:30"), ("Ana", "Ben"))]


def test_alert_lists_only_observers_up_to_confirmation_sorted():
    log = SightingLog()
    submitted(log, "Cara", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "07:00")])
    submitted(log, "Ben", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "07:20")])
    submitted(log, "Ana", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "07:50")])
    alerts = log.rare_bird_alerts(D14)
    assert len(alerts) == 1, alerts
    assert alerts[0].confirmed_at == t(14, "07:20")  # earliest confirmation
    assert alerts[0].observers == ("Ben", "Cara")  # Ana reported after it


def test_alert_three_observers_all_within_the_hour():
    log = SightingLog()
    submitted(log, "Cara", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "07:00")])
    submitted(log, "Ana", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "07:10")])
    submitted(log, "Ben", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "07:10")])
    alerts = log.rare_bird_alerts(D14)
    assert len(alerts) == 1, alerts
    assert alerts[0].confirmed_at == t(14, "07:10")
    assert alerts[0].observers == ("Ana", "Ben", "Cara")


def test_alert_observers_exclude_reports_older_than_window():
    log = SightingLog()
    submitted(log, "Zed", (14, "05:00"), [("Kirtland's Warbler", 1, 14, "05:00")])
    submitted(log, "Ana", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "07:00")])
    submitted(log, "Ben", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "07:30")])
    alerts = log.rare_bird_alerts(D14)
    assert [(a.confirmed_at, a.observers) for a in alerts] == [(t(14, "07:30"), ("Ana", "Ben"))]


def test_alert_only_one_alert_per_species_per_day():
    log = SightingLog()
    for who, hhmm in (("Ana", "07:00"), ("Ben", "07:10"), ("Cara", "10:00"), ("Dev", "10:05")):
        submitted(log, who, (14, "06:00"), [("Kirtland's Warbler", 1, 14, hhmm)])
    alerts = log.rare_bird_alerts(D14)
    assert [(a.species, a.confirmed_at) for a in alerts] == [(WARBLER, t(14, "07:10"))]


def test_alert_first_qualifying_pair_skips_reports_too_far_apart():
    log = SightingLog()
    # Ana at 07:00 is too far from Ben at 08:30, but Cara at 09:00 pairs with Ben.
    submitted(log, "Ana", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "07:00")])
    submitted(log, "Ben", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "08:30")])
    submitted(log, "Cara", (14, "06:00"), [("Kirtland's Warbler", 1, 14, "09:00")])
    alerts = log.rare_bird_alerts(D14)
    assert [(a.confirmed_at, a.observers) for a in alerts] == [(t(14, "09:00"), ("Ben", "Cara"))]


def test_alert_results_sorted_by_time_then_species():
    log = SightingLog()
    pair(log, "09:00", "09:10", species="Piping Plover")
    pair(log, "07:00", "07:10", species="Snowy Owl")
    pair(log, "07:00", "07:10", species="Black-necked Stilt")
    alerts = log.rare_bird_alerts(D14)
    assert [(a.confirmed_at, a.species) for a in alerts] == [
        (t(14, "07:10"), normalize_species("Black-necked Stilt")),
        (t(14, "07:10"), normalize_species("Snowy Owl")),
        (t(14, "09:10"), normalize_species("Piping Plover")),
    ]


def test_alert_day_filter():
    log = SightingLog()
    pair(log, "07:00", "07:10")
    assert len(log.rare_bird_alerts(D14)) == 1
    assert log.rare_bird_alerts(D15) == []
    assert log.rare_bird_alerts(date(2026, 5, 13)) == []


def test_alert_lone_rare_species_gives_no_alert():
    log = SightingLog()
    submitted(log, "Cara", (14, "08:00"), [("Piping Plover", 1, 14, "08:15")])
    assert log.rare_bird_alerts(D14) == []


def test_alert_no_checklists_gives_empty_list():
    assert SightingLog().rare_bird_alerts(D14) == []
