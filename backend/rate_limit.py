"""Small in-memory per-IP rolling-hour limiter. It intentionally persists nothing."""
from __future__ import annotations

import time
from collections import defaultdict, deque
from threading import Lock


class RateLimitExceeded(Exception):
    def __init__(self, retry_after: int = 3600) -> None:
        self.retry_after = max(1, retry_after)
        super().__init__("Too many scans. Please try again later.")


class InMemoryRateLimiter:
    def __init__(self, limit: int = 20, window_seconds: int = 3600, clock=time.monotonic) -> None:
        self.limit = max(1, int(limit))
        self.window_seconds = max(1, int(window_seconds))
        self._clock = clock
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def check(self, key: str) -> None:
        now = self._clock()
        cutoff = now - self.window_seconds
        with self._lock:
            # Periodically remove inactive keys so public traffic cannot grow memory forever.
            for existing_key in list(self._events):
                queue = self._events[existing_key]
                while queue and queue[0] <= cutoff:
                    queue.popleft()
                if not queue:
                    self._events.pop(existing_key, None)
            queue = self._events[key]
            while queue and queue[0] <= cutoff:
                queue.popleft()
            if len(queue) >= self.limit:
                wait = int(self.window_seconds - (now - queue[0])) + 1
                raise RateLimitExceeded(wait)
            queue.append(now)

    def clear(self) -> None:
        with self._lock:
            self._events.clear()
