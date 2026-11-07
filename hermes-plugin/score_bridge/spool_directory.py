"""Directory-quota eviction for the bounded spool."""
from __future__ import annotations


class _DirectoryCapMixin:
    def _enforce_directory(self):
        paths = [p for p in self.directory.glob("*.jsonl") if not p.is_symlink()]
        for path in paths:
            # Only files that changed since this process last saw them are re-read; and a re-read file is
            # rewritten only when its bytes are not already what the loss-aware encoding would produce.
            if self._verified.get(path) == self._signature(path):
                continue
            records = self._read(path)
            self._fit_file(path, records)
            if not records or self._size(path, records) != path.stat().st_size:
                self._write(path, records)
            else:
                self._verified[path] = self._signature(path)
        files = {}
        quarantine = self.directory / "quarantine"
        quarantined = []
        if quarantine.exists():
            self._safe_directory(quarantine)
            quarantined = sorted(quarantine.glob("*.jsonl"), key=lambda p: p.stat().st_mtime_ns)
        for path in tuple(quarantined):
            if path.stat().st_size > self.file_cap:
                path.unlink()
                self._fsync_directory(quarantine)
                quarantined.remove(path)
                self.dropped += 1
        def total():
            return (sum(p.stat().st_size for p in paths if p.exists())
                    + sum(p.stat().st_size for p in quarantined))
        if total() > self.directory_cap:
            # Eviction needs the records; load them only when the directory is actually over its cap.
            for path in paths:
                records = self._read(path) if path.exists() else []
                if records:
                    files[path] = records
        while total() > self.directory_cap:
            self._check_deadline()
            if quarantined:
                quarantined.pop(0).unlink()
                self._fsync_directory(quarantine)
                self.dropped += 1
                continue
            candidates = [p for p, records in files.items() if any(not r.get("pendingGap") for r in records)]
            if candidates:
                path = min(candidates, key=lambda p: files[p][0]["events"][0]["at"])
                self._drop_prefix(files[path])
                self._write(path, files[path])
            else:
                path = min((p for p in files if p != self.path), default=self.path,
                           key=lambda p: files[p][0]["events"][0]["at"])
                self.dropped += 1
                del files[path]
                self._write(path, [])
                if files:
                    retained = self.path if self.path in files else next(iter(files))
                    files[retained][0]["producerHistoryEvicted"] = True
                    self._write(retained, files[retained])
