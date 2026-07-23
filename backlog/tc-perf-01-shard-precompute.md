---
id: teleport-corridors/tc-perf-01
title: "Blazing-fast UI via build-time sharding + typed-array matrices (datasette theory, static-host edition)"
status: ready
wave: null
builds_on: []
blocks: []
effort: M
spec: The UI is slow because every interaction re-processes multi-MB JSON shipped whole - 2.9MB
  teleport_corridors_derived.json + three 1.6MB OD matrices fetched then filtered/joined
  client-side per click. Apply the query-surface/storage split (the estate's "datasette
  theory") WITHOUT any server or new runtime, GH-Pages-safe and license-neutral - (1) SHARD AT
  BUILD TIME: every view is keyed by (hub, time-window, metric); extend buildonly.sh to emit
  per-hub shard JSONs (~10-50KB) + a tiny manifest; the UI fetches exactly the shard an
  interaction needs. This alone should cut interaction latency ~50-100x. (2) TYPED-ARRAY
  MATRICES: emit the station-OD minutes matrices as flat Int16 binary (or quantized base64)
  loaded once into a TypedArray - O(1) lookups, ~4x smaller than JSON, no per-click parsing.
  (3) HYGIENE: cache fetched shards in-memory, drop the HEAD probe, precompute the Judge Mode
  disqualification sets per hub at build time. (4) ONLY IF ad-hoc query UX is later wanted:
  sql.js-httpvfs (MIT; static SQLite over HTTP range requests, works on GH Pages) or
  duckdb-wasm (MIT) - both license-clean; the data is already public in the repo so no new
  licensing exposure. Measure before/after: time-to-interactive per view and per-interaction
  latency, recorded in README.
context:
  - buildonly.sh
  - site/app.js
  - site/teleport-corridors.js
  - site/data/
verify: "test -f /Users/james/dev/teleport-corridors/site/data/shards/manifest.json && python3 -c \"import os,glob; s=[os.path.getsize(p) for p in glob.glob('/Users/james/dev/teleport-corridors/site/data/shards/*.json')]; assert s and max(s) < 200_000, 'shards must stay small'\""
needs_james: null
session: null
---

# Blazing-fast UI via sharding + typed arrays

**Before:** every click pays a multi-megabyte parse-and-scan tax; the atlas
feels slow despite being static.
**After:** interactions fetch a 20KB precomputed shard and index a typed
array; the map answers at pointer speed, still a dumb static site, nothing
new to license.
