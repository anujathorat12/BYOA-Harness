"""Concurrent-session benchmark against a running harness: N sessions of the txn-analyst agent at once."""
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from byoa_harness.client import HarnessClient  # noqa: E402

BASE = os.environ.get("HARNESS_URL", "http://localhost:8080")
dev = HarnessClient(BASE, os.environ.get("DEV_KEY", "change-me-dev"))
N = int(sys.argv[1]) if len(sys.argv) > 1 else 16


def one(i: int) -> tuple[float, str]:
    t = time.monotonic()
    s = dev.submit("txn-analyst", {"to": f"v{i}", "amount": 50})
    return time.monotonic() - t, dev.wait(s["id"], timeout=300)["status"]


t0 = time.monotonic()
with ThreadPoolExecutor(N) as ex:
    res = list(ex.map(one, range(N)))
wall = time.monotonic() - t0
lat = sorted(r[0] for r in res)  # submit->submit-returned is instant; measure end-to-end instead below
print(f"sessions={N} succeeded={sum(r[1]=='succeeded' for r in res)} wall={wall:.1f}s "
      f"throughput={N/wall:.2f} sessions/s (max_concurrent=8, excess queued)")
