import random

from raffle import MAX_TICKETS_PER_PERSON, Raffle


def make_raffle(seed=1):
    r = Raffle(seed=seed)
    r.buy_tickets("Ana", 2)
    r.buy_tickets("Bob", 3)
    r.buy_tickets("Cy", 1)
    return r


def raises_value_error(fn, *args):
    try:
        fn(*args)
    except ValueError:
        return True
    return False


def test_limit_constant():
    assert MAX_TICKETS_PER_PERSON == 5


def test_ticket_numbers_are_global_and_start_at_one():
    r = Raffle(seed=1)
    first = r.buy_tickets("Ana", 2)
    second = r.buy_tickets("Bob", 3)
    assert [t.number for t in first] == [1, 2]
    assert [t.number for t in second] == [3, 4, 5]
    assert [t.number for t in r.tickets] == [1, 2, 3, 4, 5]


def test_ticket_owner_is_recorded():
    r = Raffle(seed=1)
    tickets = r.buy_tickets("  Ana ", 2)
    assert all(t.owner == "Ana" for t in tickets)


def test_can_buy_exactly_the_limit():
    r = Raffle(seed=1)
    tickets = r.buy_tickets("Ana", 5)
    assert len(tickets) == 5
    assert r.tickets_owned("Ana") == 5


def test_cannot_go_over_the_limit():
    r = Raffle(seed=1)
    r.buy_tickets("Ana", 5)
    assert raises_value_error(r.buy_tickets, "Ana", 1)
    assert raises_value_error(r.buy_tickets, "Bob", 6)


def test_over_limit_purchase_sells_nothing():
    r = Raffle(seed=1)
    r.buy_tickets("Ana", 3)
    assert raises_value_error(r.buy_tickets, "Ana", 3)
    assert r.tickets_owned("Ana") == 3
    assert len(r.tickets) == 3


def test_same_person_with_different_spelling_shares_the_limit():
    r = Raffle(seed=1)
    r.buy_tickets("Ana", 3)
    assert raises_value_error(r.buy_tickets, " ANA ", 3)
    assert r.tickets_owned("ana") == 3


def test_invalid_quantity_rejected():
    r = Raffle(seed=1)
    assert raises_value_error(r.buy_tickets, "Ana", 0)
    assert raises_value_error(r.buy_tickets, "Ana", -2)
    assert r.tickets == []


def test_total_sales():
    assert make_raffle().total_sales() == 6 * 250


def test_prize_pool_is_sales_minus_fee():
    r = Raffle(seed=1)
    r.buy_tickets("Ana", 1)
    assert r.total_sales() == 250
    assert r.prize_pool() == 213
    assert make_raffle().prize_pool() == 1500 - 225


def test_no_winner_when_no_tickets_sold():
    assert Raffle(seed=1).draw_winner() is None


def test_draw_is_reproducible_for_a_seed():
    assert make_raffle(seed=7).draw_winner() == make_raffle(seed=7).draw_winner()


def test_draw_uses_one_randrange_over_sold_tickets():
    for seed in range(40):
        r = make_raffle(seed=seed)
        expected = r.tickets[random.Random(seed).randrange(len(r.tickets))]
        assert r.draw_winner() == expected, "seed %d" % seed


def test_every_ticket_can_win():
    winners = set()
    for seed in range(300):
        winners.add(make_raffle(seed=seed).draw_winner().number)
    assert winners == {1, 2, 3, 4, 5, 6}
