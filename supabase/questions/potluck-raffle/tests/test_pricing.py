from pricing import TICKET_PRICE_CENTS, format_money, prize_pool, ticket_cost


def test_ticket_price_is_two_fifty():
    assert TICKET_PRICE_CENTS == 250


def test_ticket_cost():
    assert ticket_cost(0) == 0
    assert ticket_cost(3) == 750


def test_prize_pool_with_no_sales_is_zero():
    assert prize_pool(0) == 0


def test_prize_pool_exact_fee():
    # 15% of 1000 = 150
    assert prize_pool(1000) == 850


def test_prize_pool_rounds_the_fee_down():
    # 15% of 250 = 37.5 -> fee 37 cents, pool 213
    assert prize_pool(250) == 213, "expected 213, got %r" % prize_pool(250)
    # 15% of 750 = 112.5 -> fee 112, pool 638
    assert prize_pool(750) == 638


def test_format_money():
    assert format_money(250) == "$2.50"
    assert format_money(5) == "$0.05"
