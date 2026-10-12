from limiter import RateLimiter


class Clock:
    def __init__(self, now=0.0):
        self.now = now

    def __call__(self):
        return self.now


def make(limit=3, window=10, now=0.0):
    clock = Clock(now)
    return RateLimiter(limit, window, clock=clock), clock


def raises_value_error(fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except ValueError:
        return True
    return False


def test_allows_up_to_the_limit_then_rejects():
    lim, _ = make(limit=3)
    assert [lim.allow("a") for _ in range(4)] == [True, True, True, False]


def test_requests_are_allowed_again_after_the_window():
    lim, clock = make(limit=2, window=10)
    assert lim.allow("a") and lim.allow("a")
    clock.now = 15
    assert lim.allow("a")


def test_window_edge_is_exclusive():
    # A request made at t=0 stops counting at exactly t=10.
    lim, clock = make(limit=2, window=10)
    assert lim.allow("a") and lim.allow("a")
    clock.now = 9.99
    assert not lim.allow("a")
    clock.now = 10
    assert lim.allow("a")


def test_rejected_requests_do_not_count():
    lim, clock = make(limit=2, window=10)
    assert lim.allow("a") and lim.allow("a")
    for t in (1, 2, 3, 4, 5):
        clock.now = t
        assert not lim.allow("a")
    clock.now = 10
    assert lim.allow("a"), "the t=0 requests expired; rejected ones must not have been recorded"


def test_keys_are_independent():
    lim, _ = make(limit=1)
    assert lim.allow("a")
    assert not lim.allow("a")
    assert lim.allow("b")


def test_instances_do_not_share_state():
    first, _ = make(limit=1)
    assert first.allow("user")
    second, _ = make(limit=1)
    assert second.allow("user")


def test_remaining_counts_down():
    lim, clock = make(limit=3, window=10)
    assert lim.remaining("a") == 3
    lim.allow("a")
    assert lim.remaining("a") == 2
    clock.now = 10
    assert lim.remaining("a") == 3


def test_cost_consumes_that_many_units():
    lim, _ = make(limit=5)
    assert lim.allow("a", cost=3)
    assert lim.remaining("a") == 2
    assert not lim.allow("a", cost=3)
    assert lim.remaining("a") == 2
    assert lim.allow("a", cost=2)
    assert lim.remaining("a") == 0


def test_cost_larger_than_limit_is_never_allowed():
    lim, _ = make(limit=2)
    assert not lim.allow("a", cost=3)
    assert lim.remaining("a") == 2


def test_retry_after():
    lim, clock = make(limit=2, window=10)
    assert lim.retry_after("a") == 0.0
    clock.now = 3
    lim.allow("a")
    clock.now = 4
    lim.allow("a")
    clock.now = 5
    assert not lim.allow("a")
    assert lim.retry_after("a") == 8
    clock.now = 13
    assert lim.retry_after("a") == 0.0
    assert lim.allow("a")


def test_invalid_arguments():
    assert raises_value_error(RateLimiter, 0, 10)
    assert raises_value_error(RateLimiter, 1, 0)
    lim, _ = make()
    assert raises_value_error(lim.allow, "a", cost=0)
