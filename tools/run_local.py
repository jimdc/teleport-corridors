#!/usr/bin/env python3

import argparse
import subprocess
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="Build matrices then serve the static site locally.")
    ap.add_argument("--gtfs", required=True, help="Path to MTA Subway GTFS zip")
    ap.add_argument("--neighborhoods", required=True, help="Path to neighborhoods GeoJSON")
    ap.add_argument("--port", type=int, default=8000, help="Port for local server")
    ap.add_argument("--transfer-minutes", type=float, default=2.0, help="Fixed transfer minutes within parent_station")
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    builder = repo_root / "tools" / "build_matrix.py"
    derived_builder = repo_root / "tools" / "build_derived.py"
    out_dir = repo_root / "site" / "data"

    # Friendly hint for the common case.
    default_raw = repo_root / "data" / "raw"
    if args.gtfs == "data/raw/subway_gtfs.zip" and args.neighborhoods == "data/raw/neighborhoods.geojson":
        if not default_raw.exists():
            print(f"Tip: create {default_raw} and download inputs first:", file=sys.stderr)
            print("  python3 tools/download_inputs.py", file=sys.stderr)

    gtfs_path = Path(args.gtfs)
    neighborhoods_path = Path(args.neighborhoods)

    if not gtfs_path.exists():
        print(f"GTFS zip not found: {gtfs_path}", file=sys.stderr)
        print("Put the file at `data/raw/subway_gtfs.zip` or pass the correct path via --gtfs.", file=sys.stderr)
        return 2

    if not neighborhoods_path.exists():
        print(f"Neighborhoods GeoJSON not found: {neighborhoods_path}", file=sys.stderr)
        print(
            "Put the file at `data/raw/neighborhoods.geojson` or pass the correct path via --neighborhoods.",
            file=sys.stderr,
        )
        return 2

    out_dir.mkdir(parents=True, exist_ok=True)

    subprocess.check_call(
        [
            sys.executable,
            str(builder),
            "--gtfs",
            str(gtfs_path),
            "--neighborhoods",
            str(neighborhoods_path),
            "--out",
            str(out_dir),
            "--transfer-minutes",
            str(args.transfer_minutes),
        ]
    )

    copied = []
    for key in ("population", "housing_units", "jobs"):
        raw_scalars = repo_root / "data" / "raw" / f"scalars_{key}.csv"
        if raw_scalars.exists():
            try:
                import shutil

                shutil.copyfile(raw_scalars, out_dir / f"scalars_{key}.csv")
                copied.append(key)
            except Exception:
                pass

    # Write scalar manifest so the client only requests files that exist.
    try:
        import json

        manifest = {"keys": sorted(set(copied))}
        (out_dir / "scalars_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    except Exception:
        pass

    # Build derived micro-units + derived neighborhoods.
    if derived_builder.exists():
        subprocess.check_call(
            [
                sys.executable,
                str(derived_builder),
                "--neighborhoods",
                str(neighborhoods_path),
                "--graph",
                str(out_dir / "graph_weekday_am.json"),
                "--matrix-dir",
                str(out_dir),
                "--out",
                str(out_dir),
            ]
        )

    site_dir = repo_root / "site"
    handler = lambda *a, **kw: SimpleHTTPRequestHandler(*a, directory=str(site_dir), **kw)
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"Serving {site_dir} at http://127.0.0.1:{args.port}", file=sys.stderr)
    print("Press Ctrl+C to stop.", file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
