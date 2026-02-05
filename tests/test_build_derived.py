import json
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path
import unittest


class TestBuildDerivedEndToEnd(unittest.TestCase):
    def _write_minimal_gtfs_zip(self, path: Path):
        stops_txt = "\n".join(
            [
                "stop_id,stop_name,stop_lat,stop_lon,parent_station",
                "A,Stop A,40.7000,-73.9900,",
                "B,Stop B,40.7200,-73.9800,",
            ]
        )
        trips_txt = "\n".join(
            [
                "route_id,service_id,trip_id",
                "R,WKD,T1",
                "R,WKD,T2",
            ]
        )
        routes_txt = "\n".join(
            [
                "route_id,route_short_name,route_long_name,route_type,route_color,route_text_color",
                "R,Q,Route R,1,FCCC0A,000000",
            ]
        )
        calendar_txt = "\n".join(
            [
                "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
                "WKD,1,1,1,1,1,1,1,20250101,20261231",
            ]
        )
        stop_times_txt = "\n".join(
            [
                "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
                "T1,07:00:00,07:00:00,A,1",
                "T2,07:10:00,07:10:00,B,1",
                "T1,07:05:00,07:05:00,B,2",
                "T2,07:15:00,07:15:00,A,2",
            ]
        )

        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("stops.txt", stops_txt)
            zf.writestr("routes.txt", routes_txt)
            zf.writestr("trips.txt", trips_txt)
            zf.writestr("calendar.txt", calendar_txt)
            zf.writestr("stop_times.txt", stop_times_txt)

    def _write_two_neighborhoods_geojson(self, path: Path):
        features = []
        squares = [
            ("N1", "Near A", -73.991, 40.699, -73.989, 40.701, "Brooklyn"),
            ("N2", "Near B", -73.981, 40.719, -73.979, 40.721, "Queens"),
        ]
        for code, name, minx, miny, maxx, maxy, borough in squares:
            features.append(
                {
                    "type": "Feature",
                    "properties": {"NTACode": code, "NTAName": name, "borough": borough},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [
                            [
                                [minx, miny],
                                [maxx, miny],
                                [maxx, maxy],
                                [minx, maxy],
                                [minx, miny],
                            ]
                        ],
                    },
                }
            )

        gj = {"type": "FeatureCollection", "features": features}
        path.write_text(json.dumps(gj), encoding="utf-8")

    def _write_gazetteer_geojson(self, path: Path):
        # Use NTA-style keys: ntaname, nta2020, boroname.
        features = []
        squares = [
            ("BK0101", "Greenpoint", -73.991, 40.699, -73.989, 40.701, "Brooklyn"),
            ("QN0101", "Astoria", -73.981, 40.719, -73.979, 40.721, "Queens"),
        ]
        for code, name, minx, miny, maxx, maxy, borough in squares:
            features.append(
                {
                    "type": "Feature",
                    "properties": {"nta2020": code, "ntaname": name, "boroname": borough},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [
                            [
                                [minx, miny],
                                [maxx, miny],
                                [maxx, maxy],
                                [minx, maxy],
                                [minx, miny],
                            ]
                        ],
                    },
                }
            )
        gj = {"type": "FeatureCollection", "features": features}
        path.write_text(json.dumps(gj), encoding="utf-8")

    def test_build_derived_outputs(self):
        repo_root = Path(__file__).resolve().parents[1]
        builder = repo_root / "tools" / "build_matrix.py"
        derived_builder = repo_root / "tools" / "build_derived.py"

        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            gtfs_zip = td / "subway_gtfs.zip"
            neighborhoods = td / "neighborhoods.geojson"
            out_dir = td / "out"
            out_dir.mkdir(parents=True, exist_ok=True)

            self._write_minimal_gtfs_zip(gtfs_zip)
            self._write_two_neighborhoods_geojson(neighborhoods)
            self._write_gazetteer_geojson(td / "neighborhoods_gazetteer.geojson")

            subprocess.check_call(
                [
                    os.environ.get("PYTHON", "python3"),
                    str(builder),
                    "--gtfs",
                    str(gtfs_zip),
                    "--neighborhoods",
                    str(neighborhoods),
                    "--out",
                    str(out_dir),
                    "--transfer-minutes",
                    "2.0",
                ]
            )

            subprocess.check_call(
                [
                    os.environ.get("PYTHON", "python3"),
                    str(derived_builder),
                    "--neighborhoods",
                    str(neighborhoods),
                    "--graph",
                    str(out_dir / "graph_weekday_am.json"),
                    "--matrix-dir",
                    str(out_dir),
                    "--out",
                    str(out_dir),
                    "--grid-step",
                    "0.002",
                    "--profiles",
                    "weekday_am",
                ]
            )

            derived_geo = json.loads((out_dir / "derived_regions.geojson").read_text(encoding="utf-8"))
            self.assertGreater(len(derived_geo.get("features", [])), 0)
            props = derived_geo["features"][0]["properties"]
            self.assertIn("primary_name", props)
            self.assertIn("name_confidence", props)
            self.assertIn("anchor_station", props)
            names = []
            fallback = 0
            for feat in derived_geo.get("features", []):
                p = feat.get("properties") or {}
                name = p.get("primary_name") or p.get("name") or ""
                names.append(name)
                if " area" in name.lower() or not name.strip():
                    fallback += 1
            if names:
                self.assertLess(fallback / len(names), 0.7)

            derived_matrix = json.loads((out_dir / "matrix_weekday_am_derived.json").read_text(encoding="utf-8"))
            self.assertIn("minutes", derived_matrix)
            self.assertIn("neighborhoods", derived_matrix)
            self.assertGreaterEqual(len(derived_matrix["neighborhoods"]), 1)

            derived_graph = json.loads((out_dir / "graph_weekday_am_derived.json").read_text(encoding="utf-8"))
            self.assertIn("neighborhoods", derived_graph)
            self.assertIn("stops", derived_graph)

            tele = json.loads((out_dir / "teleport_corridors_derived.json").read_text(encoding="utf-8"))
            self.assertIn("windows", tele)
            self.assertIn("weekday_am", tele["windows"])
