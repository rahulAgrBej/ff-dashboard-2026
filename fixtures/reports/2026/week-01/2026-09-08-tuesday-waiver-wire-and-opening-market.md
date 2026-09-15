# Waiver wire and opening market -- 2026 week 1

## Freshness
- sleeper: 2026-09-08 08:11:02
- espn: 2026-09-08 09:08:19
- odds: **insufficient data** -- the `slate` job has not produced a snapshot this week

## Waiver settlements
- Team G won RB #24 off waivers, bid_amount=14, is_pending=False.
- Team C's claim on WR #81 is still pending.

| rank | team | waiver_rank | ours |
|---|---|---|---|
| 1 | Jaxon Smith-Kachigga | 1 |  |
| 4 | Caleb Williams' Baby Mamas | 4 | <-- |
| 12 | Cheek clappers | 12 |  |

## Add candidates
### D/ST
_insufficient data -- no eligible bench player at this slot to set a floor._

| player | position | pro_team | week_projected | gap | percent_owned | implied_team_total | trending_add | drop |
|---|---|---|---|---|---|---|---|---|
| Buccaneers D/ST | D/ST | TB | 8.0 | insufficient data | 12.8 | insufficient data | -- | De'Zhaun Stribling |
| Bears D/ST | D/ST | CHI | 6.5 | insufficient data | 9.7 | insufficient data | -- | Tre Tucker |
| 49ers D/ST | D/ST | SF | 6.4 | insufficient data | 7.3 | insufficient data | -- | RJ Harvey |

## Opening market
- Implied team totals for the coming week: **insufficient data** -- odds layer has never produced data.

## What this report cannot see
- `player-pool.csv` carries `on_team_id = 0` on every row -- the free-agent pool is a derived anti-join, not a vendor fact.
- `percent_owned` has no final state; it is a rough signal, not a settled one.
