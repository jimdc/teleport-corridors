# Teleport Corridors — agent instructions

Offline-first NYC subway accessibility atlas: neighborhoods that look far on a map
but ride close by train. Pipeline: `tools/` builds travel-time matrices + derived
corridor data from GTFS (`data/raw/subway_gtfs.zip`) + neighborhoods GeoJSON into
`site/data/*.json`; `site/` is the static frontend. Build + serve: `./buildandrun.sh`
(env: `PORT`, `GTFS`, `NEIGHBORHOODS`); build only: `./buildonly.sh`.
Tests: Python (`tests/test_build_*.py`, pytest) + JS (`tests/test_judge.mjs`).
Run tests before committing pipeline or Judge-Mode changes.

`docs/architecture.md` is the engineer-register context page the estate kanban
reads — keep it current when structure changes. `docs/judge-mode.md` documents the
Decide/Judge-Mode thresholds.

## Provenance & governance

- **Origin: built with OpenAI Codex CLI** (Feb 2026, formerly `~/Documents/codex/teleport-corridors`).
  Migrated to `~/dev/` 2026-07-05. Codex conventions are native here; any harness
  (Codex, Claude Code, opencode) may work on this repo.
- **This file is the single source of truth for agent instructions.** `CLAUDE.md`
  is a shim that imports it — put nothing harness-specific there; add tool-specific
  notes in a clearly-marked section here instead.
- Estate tracking: kanban board scans this repo from `~/dev/`; improvement work
  arrives as waves (`backlog/` task cards) per `~/dev/agentic-engineering-principles/`.
