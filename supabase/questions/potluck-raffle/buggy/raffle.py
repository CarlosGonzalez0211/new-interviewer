"""Potluck raffle: sell tickets to participants, then draw one winner."""
import random
from dataclasses import dataclass

from pricing import prize_pool, ticket_cost

MAX_TICKETS_PER_PERSON = 5


@dataclass(frozen=True)
class Ticket:
    number: int
    owner: str


def person_key(name):
    """Identity of a participant."""
    key = name.strip()
    if not key:
        raise ValueError("name must not be empty")
    return key


class Raffle:
    def __init__(self, seed=None):
        self.rng = random.Random(seed)
        self.tickets = []
        self._owned = {}  # person key -> number of tickets bought

    def tickets_owned(self, name):
        return self._owned.get(person_key(name), 0)

    def buy_tickets(self, name, quantity):
        """Sell `quantity` tickets to `name`; returns the new Ticket objects.

        Raises ValueError (and sells nothing) for a bad quantity or when the
        purchase would take the person over MAX_TICKETS_PER_PERSON.
        """
        key = person_key(name)
        if quantity < 1:
            raise ValueError("quantity must be at least 1")
        owned = self._owned.get(key, 0)
        if owned + quantity >= MAX_TICKETS_PER_PERSON:
            raise ValueError("limit is %d tickets per person" % MAX_TICKETS_PER_PERSON)
        new = []
        for i in range(quantity):
            ticket = Ticket(owned + i + 1, name.strip())
            self.tickets.append(ticket)
            new.append(ticket)
        self._owned[key] = owned + quantity
        return new

    def total_sales(self):
        return ticket_cost(len(self.tickets))

    def prize_pool(self):
        return prize_pool(self.total_sales())

    def draw_winner(self):
        """Pick one sold ticket uniformly at random; None if nothing was sold."""
        if not self.tickets:
            return None
        return self.tickets[self.rng.randint(0, len(self.tickets))]
