"""Cancellable stdlib HTTP for long polls; bridge credentials never follow redirects."""
from __future__ import annotations

import http.client
import json
import os
import socket
import threading
from urllib.error import HTTPError
from urllib.parse import urlsplit


class DecisionTransport:
    def __init__(self):
        self._lock = threading.Lock()
        self._connection = None
        self._closed = False

    def __call__(self, url, token, body, timeout):
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username:
            raise ValueError("invalid bridge URL")
        kind = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        connection = kind(parsed.hostname, parsed.port, timeout=1.0)
        with self._lock:
            if self._closed:
                raise InterruptedError()
            self._connection = connection
        try:
            connection.connect()
            with self._lock:
                if self._closed:
                    raise InterruptedError()
                connection.sock.settimeout(timeout)
            data = None if body is None else json.dumps(body, allow_nan=False).encode("utf-8")
            connection.request("GET" if body is None else "POST",
                               parsed.path + ("?" + parsed.query if parsed.query else ""), data,
                               {"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
            response = connection.getresponse()
            raw = response.read(1_048_577)
            if response.status not in (200, 204):
                raise HTTPError(url, response.status, "bridge request failed", {}, None)
            if len(raw) > 1_048_576:
                raise ValueError("oversized bridge response")
            return {} if response.status == 204 else json.loads(raw)
        finally:
            with self._lock:
                if self._connection is connection:
                    self._connection = None
            connection.close()

    def close(self):
        with self._lock:
            self._closed = True
            connection = self._connection
            sock = connection.sock if connection else None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        if connection is not None:
            connection.close()

    def after_fork(self):
        # The parent's poller may have held this lock or a buffered reader's lock at fork time; those owners don't
        # exist in the child. Take no locks: detach the child's copy of the socket descriptor and close only it
        # (shutdown would also interrupt the parent's connection).
        self._lock = threading.Lock()
        connection, self._connection = self._connection, None
        sock = getattr(connection, "sock", None) if connection is not None else None
        if sock is not None:
            try:
                fd = sock.detach()
                if fd >= 0:
                    os.close(fd)
            except OSError:
                pass
