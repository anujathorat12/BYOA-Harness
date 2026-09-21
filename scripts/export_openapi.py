"""Write docs/openapi.json from the live app definition (run in CI to detect drift)."""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "src"))
from byoa_harness.api.app import create_app
from byoa_harness.config import Settings

app = create_app(Settings(env="dev", database_url="sqlite:///:memory:"))
(root / "docs" / "openapi.json").write_text(json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n")
print("wrote docs/openapi.json,", len(app.openapi()["paths"]), "paths")
