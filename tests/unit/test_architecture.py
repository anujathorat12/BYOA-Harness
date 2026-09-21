"""Architecture guard: the PDP must stay pure and independent of the rest of the app."""
import ast
from pathlib import Path

POLICY_DIR = Path(__file__).resolve().parents[2] / "src" / "byoa_harness" / "policy"
FORBIDDEN = {"socket", "subprocess", "asyncio", "sqlalchemy", "httpx", "requests", "os", "time", "datetime",
             "random", "byoa_harness.api", "byoa_harness.runtime", "byoa_harness.broker",
             "byoa_harness.store", "byoa_harness.audit"}


def _imports(path: Path):
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            yield from (a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            yield ("byoa_harness.policy" if node.level else "") + ("." + mod if node.level and mod else mod)


def test_policy_package_has_no_io_or_app_imports():
    for f in POLICY_DIR.glob("*.py"):
        for imp in _imports(f):
            root = imp.split(".")[0]
            assert imp not in FORBIDDEN and root not in FORBIDDEN, f"{f.name} imports {imp}"
