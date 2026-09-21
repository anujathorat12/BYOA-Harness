"""Policy evaluation latency benchmark (pure engine, no I/O). Prints results to paste into docs."""
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from byoa_harness.policy import Action, EvalContext, evaluate_all, parse_policy  # noqa: E402

rules = "\n".join(
    f" - {{id: r{i}, decision: allow, match: {{type: data.read, resource: 'ds{i}.*', when: [{{field: params.limit, op: lte, value: 100}}]}}}}"
    for i in range(200))
policy = parse_policy(f"id: big\nrules:\n{rules}\n - {{id: deny-x, decision: deny, match: {{type: production.delete}}}}").with_version(1)
ctx = EvalContext("a", "s")
action = Action.build("data.read", "ds150.table", {"limit": 10})
N = 20000
samples = []
for _ in range(N):
    t = time.perf_counter()
    evaluate_all([policy], action, ctx)
    samples.append((time.perf_counter() - t) * 1e6)
samples.sort()
print(f"rules=201 evaluations={N}  p50={statistics.median(samples):.0f}us  p99={samples[int(N*.99)]:.0f}us  max={samples[-1]:.0f}us")
