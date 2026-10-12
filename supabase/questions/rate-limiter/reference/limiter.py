"""In-memory sliding-window rate limiter."""
import time
from collections import deque


class RateLimiter:
    def __init__(self, limit, window, clock=time.monotonic):
        if limit < 1 or window <= 0:
            raise ValueError("limit must be >= 1 and window > 0")
        self.limit = limit
        self.window = window
        self.clock = clock
        self._hits = {}  # key -> deque of timestamps, one entry per unit of cost

    def _live_hits(self, key, now):
        """Timestamps still inside the window for `key` (expired ones are dropped)."""
        hits = self._hits.get(key)
        if hits is None:
            return deque()
        while hits and hits[0] <= now - self.window:
            hits.popleft()
        if not hits:
            del self._hits[key]
            return deque()
        return hits

    def used(self, key):
        return len(self._live_hits(key, self.clock()))

    def remaining(self, key):
        return self.limit - self.used(key)

    def allow(self, key, cost=1):
        """Try to spend `cost` units for `key`. True if allowed, False if rejected."""
        if cost < 1:
            raise ValueError("cost must be >= 1")
        now = self.clock()
        hits = self._live_hits(key, now)
        if len(hits) + cost > self.limit:
            return False
        hits = self._hits.setdefault(key, deque())
        hits.extend([now] * cost)
        return True

    def retry_after(self, key):
        """Seconds until one more unit would be allowed (0.0 if allowed right now)."""
        now = self.clock()
        hits = self._live_hits(key, now)
        if len(hits) < self.limit:
            return 0.0
        return hits[0] + self.window - now
