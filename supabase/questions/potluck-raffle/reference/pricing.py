"""Money helpers for the raffle. All amounts are integer cents."""

TICKET_PRICE_CENTS = 250
FEE_PERCENT = 15


def ticket_cost(quantity):
    """Cost in cents of `quantity` tickets."""
    return quantity * TICKET_PRICE_CENTS


def prize_pool(total_sales):
    """Sales minus the organizer fee. The fee is rounded down to a whole cent."""
    fee = total_sales * FEE_PERCENT // 100
    return total_sales - fee


def format_money(cents):
    return "$%d.%02d" % (cents // 100, cents % 100)
