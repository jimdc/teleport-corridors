# Judge Mode

Judge Mode turns Teleport Corridors into a **decision tool**: it ranks neighborhoods and explicitly disqualifies others based on hard thresholds.

## How it works
1) **Hard constraints first**  
   Neighborhoods are **disqualified** if they fail any threshold:
   - Max commute to hub
   - Max walk to subway
   - Minimum nearby lines

2) **Pareto pruning**  
   Among the remaining options, we keep only the **Pareto‑optimal** set (no other neighborhood is strictly better on *all* metrics).

3) **Scoring for ranking**  
   The Pareto set is ranked using a simple weighted score:
   - Commute minutes (lower is better)
   - Walk minutes (lower is better)
   - Line diversity (higher is better)

4) **Tipping point**  
   The UI shows the minimal change needed to flip the top recommendation (e.g., +7 min commute or −1 line).

## Threshold defaults (v1)
- **Max commute**: 45 minutes  
- **Max walk**: 10 minutes  
- **Min lines**: 2 lines within ~650m

All thresholds are user‑adjustable.

## Why this design
- **Hard constraints** make “do not choose” explicit.  
- **Pareto** avoids hidden weighting until after dominance is removed.  
- **Tipping point** explains sensitivity without complex modeling.

## Limitations
- Walk distance uses neighborhood centroids, not exact entrances.  
- Line diversity is based on GTFS route/service presence, not reliability.  
- Thresholds are heuristics; tune them to your priorities.

