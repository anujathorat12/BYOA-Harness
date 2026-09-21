"""Deliberately hostile agents run in the REAL sandbox. Each test asserts the harness contained it."""
import asyncio
import subprocess
import time

import pytest

pytestmark = pytest.mark.docker

ALLOW_ALL = "id: allow-all\nrules:\n - {id: all, decision: allow, match: {type: '*'}}\n"


def leftover_containers() -> list[str]:
    out = subprocess.run(["docker", "ps", "-aq", "--filter", "label=byoa.managed=1"],
                         capture_output=True, text=True, check=False).stdout
    return out.split()


PROBE = '''
import os, socket, subprocess, sys

def attempt(fn):
    try:
        return "ALLOWED:" + str(fn())
    except BaseException as e:
        return "blocked:" + type(e).__name__

def run(ctx):
    r = {}
    def net():
        s = socket.socket(); s.settimeout(2); s.connect(("1.1.1.1", 53)); return "connected"
    def dns():
        return socket.gethostbyname("example.com")
    def write_root():
        open("/etc/pwned", "w").write("x")
    def write_opt():
        open("/opt/byoa_runtime/bootstrap.py", "a").write("#")
    def exec_tmp():
        open("/tmp/x.sh", "w").write("#!/bin/sh\\necho hi\\n"); os.chmod("/tmp/x.sh", 0o755)
        return subprocess.run(["/tmp/x.sh"], capture_output=True).returncode
    def docker_sock():
        return os.path.exists("/var/run/docker.sock")
    def setuid():
        os.setuid(0)
    def mount():
        return subprocess.run(["mount", "-t", "tmpfs", "none", "/mnt"], capture_output=True).returncode
    def big_tmp():
        with open("/tmp/big", "wb") as f:
            f.write(b"0" * (200 * 1024 * 1024))
    r["net"] = attempt(net)
    r["dns"] = attempt(dns)
    r["write_root"] = attempt(write_root)
    r["write_runtime"] = attempt(write_opt)
    r["exec_tmp"] = attempt(exec_tmp)
    r["docker_sock"] = attempt(docker_sock)
    r["setuid0"] = attempt(setuid)
    r["mount"] = attempt(mount)
    r["big_tmp"] = attempt(big_tmp)
    r["uid"] = os.getuid()
    status = open("/proc/self/status").read()
    r["cap_eff"] = [l.split()[1] for l in status.splitlines() if l.startswith("CapEff")][0]
    r["no_new_privs"] = [l.split()[1] for l in status.splitlines() if l.startswith("NoNewPrivs")][0]
    r["env_secrets"] = [k for k in os.environ if any(t in k for t in ("KEY", "TOKEN", "SECRET", "PASSWORD"))]
    r["hostname"] = socket.gethostname()
    r["procs"] = len(os.listdir("/proc"))
    return r
'''


async def test_isolation_probe_everything_blocked(harness):
    harness.package_agent("probe", PROBE, harness.add_policy(ALLOW_ALL))
    row = await harness.run("probe")
    assert row["status"] == "succeeded", row["error"]
    r = row["result"]
    assert r["net"].startswith("blocked"), r["net"]
    assert r["dns"].startswith("blocked"), r["dns"]
    for k in ("write_root", "write_runtime", "setuid0", "big_tmp"):
        assert r[k].startswith("blocked"), (k, r[k])
    # subprocess-based probes "complete" even when refused, so assert on the exit code (0 would be success)
    for k in ("exec_tmp", "mount"):
        assert r[k].startswith("blocked") or r[k] != "ALLOWED:0", (k, r[k])
    assert r["docker_sock"] == "ALLOWED:False"
    assert r["uid"] == 10001 and r["cap_eff"] == "0000000000000000" and r["no_new_privs"] == "1"
    # The harness passes no -e flags, so no harness secret can be present. GPG_KEY is inherited from the
    # official python base image (a public release-signing key id) and is the only tolerated match.
    assert set(r["env_secrets"]) <= {"GPG_KEY"} and r["hostname"] == "sandbox"


async def test_fork_bomb_is_contained_and_cleaned_up(harness):
    harness.package_agent("forkbomb", "import os\ndef run(ctx):\n    n=0\n    while True:\n        try:\n"
                                       "            if os.fork()==0:\n                import time; time.sleep(30)\n"
                                       "            n+=1\n        except OSError:\n            return {'forks':n}\n",
                          harness.add_policy(ALLOW_ALL))
    t0 = time.monotonic()
    row = await harness.run("forkbomb")
    assert time.monotonic() - t0 < 25
    if row["status"] == "succeeded":
        assert row["result"]["forks"] <= harness.settings.sandbox_pids  # pids-limit refused further forks
    await asyncio.sleep(0.5)
    assert leftover_containers() == []


async def test_memory_hog_is_oom_killed(harness):
    harness.package_agent("memhog", "def run(ctx):\n    a=[]\n    while True:\n        a.append(bytearray(20*1024*1024))\n",
                          harness.add_policy(ALLOW_ALL), memory_mb=64)
    row = await harness.run("memhog")
    assert row["status"] == "failed" and "memory" in row["error"].lower(), row["error"]
    assert leftover_containers() == []


async def test_cpu_spin_and_hang_are_killed_by_wall_clock(harness):
    pid = harness.add_policy(ALLOW_ALL)
    harness.package_agent("spin", "def run(ctx):\n    while True:\n        pass\n", pid, timeout_s=3)
    harness.package_agent("hang", "import time\ndef run(ctx):\n    time.sleep(3600)\n", pid, timeout_s=3)
    a, b = await asyncio.gather(harness.run("spin"), harness.run("hang"))
    for row in (a, b):
        assert row["status"] == "failed" and row["error"].startswith("timeout")
    assert leftover_containers() == []


async def test_crashing_agent_fails_cleanly(harness):
    harness.package_agent("crash", "import os\ndef run(ctx):\n    os._exit(3)\n", harness.add_policy(ALLOW_ALL))
    row = await harness.run("crash")
    assert row["status"] == "failed" and "code 3" in row["error"]
    assert harness.store.query_audit(session_id=row["id"], kind="session.finished")


async def test_raising_agent_reports_error_not_result(harness):
    harness.package_agent("raiser", "def run(ctx):\n    raise ValueError('boom')\n", harness.add_policy(ALLOW_ALL))
    row = await harness.run("raiser")
    assert row["status"] == "failed" and "ValueError: boom" in row["error"]


@pytest.mark.parametrize("name,payload", [
    ("forged_decision", "ctx._ch.send({'type':'decision','allow':True})"),
    ("forged_response", "ctx._ch.send({'type':'response','id':'1','ok':True,'result':{}})"),
    ("garbage", "ctx._ch._w.write('not json at all\\n'); ctx._ch._w.flush()"),
    ("giant_line", "ctx._ch._w.write('x'*(3*1024*1024)); ctx._ch._w.flush()"),
])
async def test_protocol_abuse_terminates_session(harness, name, payload):
    harness.package_agent(name, f"import time\ndef run(ctx):\n    {payload}\n    time.sleep(30)\n",
                          harness.add_policy(ALLOW_ALL))
    row = await harness.run(name)
    assert row["status"] == "failed" and "protocol violation" in row["error"], row["error"]
    assert leftover_containers() == []


async def test_stray_prints_cannot_forge_protocol(harness):
    src = ("import sys, os\ndef run(ctx):\n    print('{\"type\":\"result\",\"ok\":true,\"output\":\"FORGED\"}')\n"
           "    os.write(1, b'{\"type\":\"result\",\"ok\":true,\"output\":\"FORGED2\"}\\n')\n    return 'genuine'\n")
    harness.package_agent("printer", src, harness.add_policy(ALLOW_ALL))
    row = await harness.run("printer")
    assert row["status"] == "succeeded" and row["result"] == "genuine"


async def test_concurrent_agents_cannot_see_each_other(harness):
    src = ("import time, os\ndef run(ctx):\n    me = ctx.task['me']\n    open('/tmp/marker-'+me,'w').write(me)\n"
           "    time.sleep(2)\n    return sorted(f for f in os.listdir('/tmp') if f.startswith('marker'))\n")
    harness.package_agent("iso", src, harness.add_policy(ALLOW_ALL))
    rows = await asyncio.gather(*[harness.run("iso", {"me": str(i)}) for i in range(4)])
    for i, row in enumerate(rows):
        assert row["status"] == "succeeded" and row["result"] == [f"marker-{i}"]


async def test_noisy_neighbour_does_not_stop_others(harness):
    pid = harness.add_policy(ALLOW_ALL)
    harness.package_agent("spinner", "def run(ctx):\n    while True:\n        pass\n", pid, timeout_s=6)
    harness.package_agent("worker", "def run(ctx):\n    return ctx.call('ticket.create', title='ok')\n", pid)
    spin = asyncio.create_task(harness.run("spinner"))
    await asyncio.sleep(1)
    t0 = time.monotonic()
    good = await harness.run("worker")
    assert good["status"] == "succeeded" and time.monotonic() - t0 < 10
    assert (await spin)["status"] == "failed"


async def test_concurrency_cap_queues_excess_sessions(make_harness):
    h = make_harness(max_concurrent_sessions=2)
    h.package_agent("sleepy", "import time\ndef run(ctx):\n    time.sleep(3)\n    return 1\n", h.add_policy(ALLOW_ALL))
    subs = [await h.manager.submit("sleepy", {}, "alice", []) for _ in range(4)]
    await asyncio.sleep(1.5)
    statuses = [h.store.get_session(s["id"])["status"] for s in subs]
    assert statuses.count("running") == 2 and statuses.count("queued") == 2
    rows = [await h.wait(s["id"]) for s in subs]
    assert all(r["status"] == "succeeded" for r in rows)


async def test_cancel_kills_container(harness):
    harness.package_agent("long", "import time\ndef run(ctx):\n    time.sleep(600)\n", harness.add_policy(ALLOW_ALL))
    s = await harness.manager.submit("long", {}, "alice", [])
    await asyncio.sleep(2)
    assert await harness.manager.cancel(s["id"])
    row = await harness.wait(s["id"], 20)
    assert row["status"] == "cancelled"
    await asyncio.sleep(0.5)
    assert leftover_containers() == []
