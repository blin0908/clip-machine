"""Regenerate docs/formula.json from clipper.py so the web app scores clips exactly like the desktop engine.
Run after changing any scoring constant:  .venv/bin/python scripts/export_formula.py  (add --check to only compare)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import clipper as c  # noqa: E402

data = {"platforms": c.PLATFORMS, "hype": c.HYPE, "sponsor": list(c.SPONSOR), "stop": sorted(c.STOP),
        "weak": sorted(c.WEAK), "midstart": sorted(c.MIDSTART), "fillers": sorted(c.FILLERS),
        "weights": c.WEIGHTS, "raw": sorted(c.RAW), "captionFonts": c.CAPTION_FONTS, "version": c.VERSION}
out = ROOT / "docs" / "formula.json"
if "--check" in sys.argv:
    same = json.loads(out.read_text()) == json.loads(json.dumps(data))
    print("formula.json is up to date" if same else "formula.json is STALE: run scripts/export_formula.py")
    sys.exit(0 if same else 1)
out.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")   # indented: readable diffs
print(f"wrote {out} ({out.stat().st_size} bytes)")
