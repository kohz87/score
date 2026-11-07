"""Bounded hook admission queue shared by a sender."""
from __future__ import annotations

import queue


class HookQueue(queue.Queue):
    def __init__(self, sender, capacity):
        super().__init__(maxsize=capacity)
        self.sender = sender

    def put_nowait(self, item):
        sender = self.sender
        if not self.mutex.acquire(timeout=0.002):
            sender.contended += 1
            sender._contention.append(item["profile"])
            return
        try:
            if sender._closed:
                sender.dropped += 1
                return
            profile = item["profile"]
            sender._observed[profile] = sender._observed.get(profile, 0) + 1
            item["observation"] = sender._observed[profile]
            if self._qsize() >= self.maxsize:
                old = self._get()
                sender.dropped += 1
                sender._loss(old["profile"], old["observation"], old["observation"], old["at"])
            self._put(item)
            self.not_empty.notify()
            ready = self._qsize() >= 100
        finally:
            self.mutex.release()
        if ready:
            sender._wake.set()
