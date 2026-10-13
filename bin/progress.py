"""Report a job's progress to the Detaly mod (Claude Code): writes ~/.claude/progress/<id>.json.

    from progress import report
    for i in range(n):
        ...
        report("train", "train", i + 1, n, "it")
    report("train", "train", n, n, "it", finished=True)

Call it as often as you like: it writes at most every 2 s (and always when finished).
"""
import json
import os
import time
from pathlib import Path

DIR = Path.home() / ".claude" / "progress"
EVERY_S = 2.0
KEEP_DAYS = 7  # progress files older than this are removed when a job starts reporting
_started: dict[str, float] = {}
_written: dict[str, float] = {}


def _prune():
    """Remove the progress files nobody has written for KEEP_DAYS (the mod cannot delete files)."""
    for f in DIR.glob("*.json"):
        try:
            if time.time() - f.stat().st_mtime > KEEP_DAYS * 86400:
                f.unlink()
        except OSError:
            pass


def report(id, title, done, total, unit="it", eta_s=None, finished=False):
    now = time.time()
    if not finished and now - _written.get(id, 0.0) < EVERY_S:
        return
    if not _written:
        DIR.mkdir(parents=True, exist_ok=True)
        _prune()
    _written[id] = now
    job = {"title": title, "done": done, "total": total, "unit": unit, "started": int(_started.setdefault(id, now)),
           "eta_s": eta_s, "updated": int(now), "finished": finished,
           "session": os.environ.get("CLAUDE_JOB_SESSION"), "project": os.getcwd()}  # whose band shows it
    DIR.mkdir(parents=True, exist_ok=True)
    tmp = DIR / f"{id}.json.tmp"
    tmp.write_text(json.dumps(job), encoding="utf-8")
    try:
        os.replace(tmp, DIR / f"{id}.json")  # atomic: the mod never reads half a file
    except PermissionError:
        pass  # the file is open in a reader right now (Windows); the next report writes it
