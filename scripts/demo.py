"""End-to-end demo against a running harness (`docker compose up --build`).

    python scripts/demo.py            # uses keys from .env.example defaults or ADMIN_KEY/DEV_KEY/... env vars

Shows: BYOA registration of two agent shapes, three sector policy bundles on one engine, live event
streaming, a real pause/resume approval by a separate human identity, a denied approval, a rogue agent
contained by the sandbox, audit reconstruction, hash-chain verification and a policy dry-run.
"""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from byoa_harness.client import HarnessClient

BASE = os.environ.get("HARNESS_URL", "http://localhost:8080")
EX = Path(__file__).resolve().parents[1] / "examples"
admin = HarnessClient(BASE, os.environ.get("ADMIN_KEY", "change-me-admin"))
dev = HarnessClient(BASE, os.environ.get("DEV_KEY", "change-me-dev"))
approver = HarnessClient(BASE, os.environ.get("APPROVER_KEY", "change-me-approver"))
auditor = HarnessClient(BASE, os.environ.get("AUDITOR_KEY", "change-me-auditor"))

ROGUE = '''
import socket, time
def run(ctx):
    out = {}
    try:
        socket.create_connection(("1.1.1.1", 53), timeout=2); out["network"] = "CONNECTED"
    except OSError as e:
        out["network"] = "blocked (" + type(e).__name__ + ")"
    try:
        open("/etc/backdoor", "w").write("x"); out["fs"] = "WROTE"
    except OSError as e:
        out["fs"] = "blocked (" + type(e).__name__ + ")"
    try:
        ctx.call("shell.exec", cmd="cat /etc/shadow")
    except Exception as e:
        out["shell"] = "refused: " + str(e)
    ctx.progress("rogue agent now hangs forever: " + str(out))
    time.sleep(3600)
'''


def h(title: str) -> None:
    print(f"\n\033[1;36m== {title} ==\033[0m")


def show(kind: str, msg: str) -> None:
    color = {"allow": "32", "deny": "31", "require-approval": "33"}.get(kind, "37")
    print(f"  \033[{color}m{kind:>17}\033[0m  {msg}")


def stream(sid: str) -> None:
    for e in dev.events(sid):
        k = e["event"]
        if k == "action.decided":
            d = e["payload"]["decision"]
            show(d["effect"], f"{e['action_type']} {e['resource']!r}  <- rule {d['rule_id']} ({d['policy_id']}@v{d['policy_version']})")
        elif k == "approval.requested":
            print("  \033[33m   ... agent PAUSED, waiting for a human approver ...\033[0m")
        elif k == "approval.resolved":
            print(f"  \033[33m   ... approval {e['payload']['status']} by {e['payload']['decided_by']} ...\033[0m")
        elif k == "agent.progress":
            print(f"  \033[90m   progress: {e['payload']['message']}\033[0m")
        elif k == "session.finished":
            print(f"  \033[1m   session {e['payload']['status']}\033[0m {e['payload'].get('reason', '')}")


def approver_thread(decide, stop: threading.Event) -> threading.Thread:
    def loop() -> None:
        seen = set()
        while not stop.is_set():
            for a in approver.pending_approvals():
                if a["id"] in seen:
                    continue
                seen.add(a["id"])
                time.sleep(2)  # a human thinking
                act = a["action"]
                ok = decide(a)
                print(f"  \033[35m[approver bob]\033[0m {'APPROVES' if ok else 'DENIES'} {act['type']} {act['resource']} {act['params']}")
                (approver.approve if ok else approver.deny)(a["id"], "demo decision")
            time.sleep(0.5)
    t = threading.Thread(target=loop, daemon=True)
    t.start()
    return t


def run(agent: str, task: dict | None = None) -> dict:
    s = dev.submit(agent, task)
    stream(s["id"])
    return dev.wait(s["id"])


def main() -> None:
    h("1. Register agents (two shapes) and attach admin-owned policies")
    it_src = (EX / "agents" / "it-ops-agent" / "main.py").read_text()
    dev.register_agent(id="it-ops-agent", shape="package", description="IT ops (code agent)",
                       package={"entrypoint": "main:run", "files": {"main.py": it_src}})
    for name in ("txn-analyst", "clinical-assistant"):
        dev.register_agent(**yaml.safe_load((EX / "agents" / f"{name}.yaml").read_text()))
    dev.register_agent(id="rogue-agent", shape="package", description="hostile test agent",
                       package={"entrypoint": "main:run", "files": {"main.py": ROGUE}}, resources={"timeout_s": 8})
    for agent, pol in (("it-ops-agent", "enterprise-it"), ("txn-analyst", "financial-ops"),
                       ("clinical-assistant", "healthcare-data")):
        p = admin.put_policy((EX / "policies" / f"{pol}.yaml").read_text())
        admin.attach_policy(agent, pol)
        print(f"  {agent:<20} shape={'package' if agent == 'it-ops-agent' else 'declarative':<12} policy={pol}@v{p['version']}")
    admin.put_policy("id: nothing\nrules: []")
    admin.attach_policy("rogue-agent", "nothing")
    print("  rogue-agent          shape=package      policy=nothing (deny-all)")

    stop = threading.Event()

    h("2. Enterprise IT (package agent): allow / escalate / deny - approver APPROVES the prod change")
    approver_thread(lambda _a: True, stop)
    s = run("it-ops-agent")
    print("  result:", s["result"])

    h("3. Financial ops (declarative agent): small transfer allowed, account master denied")
    s = run("txn-analyst", {"to": "vendor-1", "amount": 200})
    print("  result: transfer =", s["result"]["transfer"], "| master data =", s["result"]["master_data"]["rule_id"])
    print(f"  spend tracked: {s['spent_amount']} USD, {s['spent_tokens']} tokens")

    stop.set()
    time.sleep(1)
    stop = threading.Event()
    h("4. Financial ops: high-value transfer - approver DENIES; the transfer never happens")
    approver_thread(lambda _a: False, stop)
    s = run("txn-analyst", {"to": "vendor-9", "amount": 5000})
    print("  result: transfer =", s["result"]["transfer"])

    stop.set()
    time.sleep(1)
    stop = threading.Event()
    h("5. Healthcare-style bundle, same engine: restricted denied, export escalated and APPROVED")
    approver_thread(lambda _a: True, stop)
    s = run("clinical-assistant")
    print("  restricted:", s["result"]["restricted"]["rule_id"], "| export:", s["result"]["export"])
    stop.set()

    h("6. Failure case: rogue agent (network, filesystem, unknown tool, then hangs)")
    s = run("rogue-agent")
    print("  final:", s["status"], "-", s["error"])

    h("7. Audit reconstruction: every denied action, with the rule that fired")
    for e in auditor.audit(effect="deny", kind="action.decided", limit=50)["events"]:
        print(f"  {e['ts']}  {e['agent_id']:<18} {e['action_type']!s:<18} {e['resource']!s:<28} rule={e['rule_id']}")
    print("\n  hash-chain verification per session:")
    for sess in dev.sessions(limit=6):
        v = auditor.verify_chain(sess['id'])
        print(f"  {sess['id']}  {sess['agent_id']:<18} events={v['events']:<3} valid={v['valid']}")

    h("8. Policy dry-run: what if the transfer threshold were 100? (history replayed, no agent runs)")
    stricter = (EX / "policies" / "financial-ops.yaml").read_text().replace("value: 1000", "value: 100")
    sim = auditor.simulate(documents=[stricter], agent_id="txn-analyst")
    print(f"  replayed {sim['total']} historical actions; {sim['changed']} would change:")
    for r in sim["results"]:
        if r["changed"]:
            print(f"    {r['type']} {r['resource']}: {r['original']['effect']} -> {r['simulated']['effect']} (rule {r['simulated']['rule_id']})")

    h("9. Operator view")
    ov = auditor.overview()
    print("  decisions:", ov["decisions"], "| sessions:", ov["sessions"])


if __name__ == "__main__":
    main()
