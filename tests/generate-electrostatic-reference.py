"""Regenerate independent sparse-LU reference; requires numpy/scipy and pinned Git source.

python tests/generate-electrostatic-reference.py --solver-repo /path/to/simulate-return-current
This is a numerical cross-section reference, not full-board EM ground truth.
"""
import argparse
import hashlib
import importlib.util
import json
import subprocess
import tempfile
from pathlib import Path

import numpy
import scipy

COMMIT = "b7f92962ab2d1763158049786018bd669d8d48c0"
SOURCE_PATH = "lib/palace/python/crosstalk_extract.py"
parser = argparse.ArgumentParser()
parser.add_argument("--solver-repo", type=Path, required=True)
parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "fixtures/electrostatic-reference.json")
args = parser.parse_args()
original = subprocess.run(["git", "-C", str(args.solver_repo), "show", f"{COMMIT}:{SOURCE_PATH}"], check=True, capture_output=True, text=True).stdout
replacements = {
    "xedge+.0004,xedge+.001,xedge+.002,xedge+margin_mm*1e-3]))": "xedge+.0004,xedge+.001,xedge+.002,xedge+margin_mm*1e-3] + [v for d in (.004,.008) if d < margin_mm*1e-3 for v in (-xedge-d,xedge+d)]))",
    "top_mm*1e-3]))": "top_mm*1e-3] + [v for v in (.004,.008) if h+t < v < top_mm*1e-3]))",
    "200000": "400000",
}
adapted = original
for before, after in replacements.items():
    if before not in adapted:
        raise RuntimeError("Pinned extraction source changed unexpectedly")
    adapted = adapted.replace(before, after)
assumptions = {"geometry": {"trace_width_mm": .3, "trace_thickness_mm": .035, "substrate_height_mm": .2}, "materials": {"relative_permittivity": 4.2, "trace_conductivity_s_per_m": 5.8e7}}
with tempfile.TemporaryDirectory() as temporary:
    path = Path(temporary) / "reference.py"
    path.write_text(adapted)
    spec = importlib.util.spec_from_file_location("independent_cross_section", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    cases = [module.extract(assumptions, .3, grid, domain, domain)[0] for grid, domain in [(.025, 2), (.0125, 2), (.00625, 2), (.00625, 4), (.025, 4), (.0125, 4), (.00625, 8)]]
payload = {"provenance": {"source_repo": "https://github.com/tscircuit/simulate-return-current", "source_commit": COMMIT, "source_path": SOURCE_PATH, "source_sha256": hashlib.sha256(original.encode()).hexdigest(), "adapted_source_sha256": hashlib.sha256(adapted.encode()).hexdigest(), "source_adaptations": ["Add fixed 4/8 mm outer mesh breakpoints inside the selected domain, keeping existing near-field cells unchanged during expansion.", "Raise only resource guard from 200000 to 400000 nodes for independently expanded 8mm domain; equations unchanged."], "solver": "independent SciPy sparse LU", "numpy": numpy.__version__, "scipy": scipy.__version__, "scope": "same conservative finite-volume cross-section; independent implementation/linear solver, not full-board EM ground truth"}, "geometry": assumptions["geometry"], "material": assumptions["materials"], "cases": cases}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(payload, indent=2) + "\n")
print(f"Wrote {len(cases)} independently solved references to {args.output}")
