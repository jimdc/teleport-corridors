import json
import os
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path


class TestBuildMatrixUnits(unittest.TestCase):
    def test_parse_gtfs_time_to_seconds(self):
        from tools.build_matrix import parse_gtfs_time_to_seconds

        self.assertEqual(parse_gtfs_time_to_seconds("00:00:00"), 0)
        self.assertEqual(parse_gtfs_time_to_seconds("07:05:30"), 7 * 3600 + 5 * 60 + 30)
        self.assertEqual(parse_gtfs_time_to_seconds("25:10:00"), 25 * 3600 + 10 * 60)
        self.assertEqual(parse_gtfs_time_to_seconds("7:00:00"), 7 * 3600)
        self.assertIsNone(parse_gtfs_time_to_seconds(""))
        self.assertIsNone(parse_gtfs_time_to_seconds(None))
        self.assertIsNone(parse_gtfs_time_to_seconds("07:00"))
        self.assertIsNone(parse_gtfs_time_to_seconds("07:99:00"))

    def test_build_graph_transfer_edges(self):
        from tools.build_matrix import build_graph

        stops = {
            "A": {"stop_id": "A"},
            "B": {"stop_id": "B"},
            "C": {"stop_id": "C"},
        }
        parent_to_children = {"P": ["A", "B"]}
        segment_weights = {("A", "C"): 120}
        segment_routes = {("A", "C"): "R"}
        g = build_graph(stops, parent_to_children, segment_weights, segment_routes, transfer_seconds=60)

        self.assertIn(("C", 120, "R"), g["A"])
        self.assertIn(("B", 60, None), g["A"])
        self.assertIn(("A", 60, None), g["B"])

    def test_dijkstra_shortest(self):
        from tools.build_matrix import dijkstra

        graph = {
            "A": [("B", 10), ("C", 100)],
            "B": [("C", 10)],
            "C": [],
        }
        dist = dijkstra(graph, "A")
        self.assertEqual(dist["A"], 0)
        self.assertEqual(dist["B"], 10)
        self.assertEqual(dist["C"], 20)


class TestBuildMatrixEndToEnd(unittest.TestCase):
    def _write_minimal_gtfs_zip(self, path: Path):
        # Two stops, two trips (A->B and B->A), weekday service.
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
                "WKD,1,1,1,1,1,0,0,20250101,20261231",
            ]
        )
        # Both trips depart at 07:00 so they land in weekday_am.
        # Intentionally interleave trip rows to ensure we don't assume stop_times is grouped by trip_id.
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
        # Two small square polygons near the stops.
        features = []
        squares = [
            ("N1", "Near A", -73.991, 40.699, -73.989, 40.701),
            ("N2", "Near B", -73.981, 40.719, -73.979, 40.721),
        ]
        for code, name, minx, miny, maxx, maxy in squares:
            features.append(
                {
                    "type": "Feature",
                    "properties": {"NTACode": code, "NTAName": name},
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

    def test_build_matrix_produces_reachable_minutes(self):
        repo_root = Path(__file__).resolve().parents[1]
        builder = repo_root / "tools" / "build_matrix.py"

        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            gtfs_zip = td / "subway_gtfs.zip"
            neighborhoods = td / "neighborhoods.geojson"
            out_dir = td / "out"
            out_dir.mkdir(parents=True, exist_ok=True)

            self._write_minimal_gtfs_zip(gtfs_zip)
            self._write_two_neighborhoods_geojson(neighborhoods)

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

            am = json.loads((out_dir / "matrix_weekday_am.json").read_text(encoding="utf-8"))
            minutes = am["minutes"]
            routes = am["routes"]
            first_route = am["first_route"]
            centrality = am["centrality"]

            # 2x2 matrix, diagonals 0, off-diagonals ~5 minutes.
            self.assertEqual(len(minutes), 2)
            self.assertEqual(len(minutes[0]), 2)
            self.assertEqual(minutes[0][0], 0)
            self.assertEqual(minutes[1][1], 0)
            self.assertEqual(minutes[0][1], 5)
            self.assertEqual(minutes[1][0], 5)

            # Should include the route and label it "Q".
            self.assertGreaterEqual(len(routes), 1)
            self.assertEqual(routes[0]["short_name"], "Q")
            # For off-diagonal, first route should be set.
            self.assertEqual(first_route[0][1], 0)
            self.assertEqual(first_route[1][0], 0)

            self.assertIn("metrics", centrality)
            self.assertIn("harmonic", centrality["metrics"])
            harm = centrality["metrics"]["harmonic"]
            self.assertTrue(harm["higher_is_better"])
            self.assertEqual(len(harm["scores"]), 2)
            self.assertGreater(harm["scores"][0], 0)

            graph = json.loads((out_dir / "graph_weekday_am.json").read_text(encoding="utf-8"))
            self.assertIn("stops", graph)
            self.assertIn("edges", graph)
            self.assertIn("routes", graph)
            self.assertGreaterEqual(len(graph["stops"]), 2)
            self.assertGreaterEqual(len(graph["edges"]), 2)
            self.assertEqual(graph["routes"][0]["short_name"], "Q")

            tele = json.loads((out_dir / "teleport_corridors.json").read_text(encoding="utf-8"))
            self.assertIn("generated_at", tele)
            self.assertIn("windows", tele)
            self.assertIn("weekday_am", tele["windows"])
            self.assertIn("weekend", tele["windows"])
            self.assertIn("hubs", tele["windows"]["weekday_am"])
            self.assertIn("corridors", tele["windows"]["weekday_am"])


if __name__ == "__main__":
    unittest.main()
