# Levels

The game plays the files `NN-name.json` in number order. When both characters stand in their doors for half a second, the level is complete and the next one loads. After level 32 it goes back to level 1.

To check every level, run `npm run levels`. It also runs as part of `npm test`. The checker approximates movement on the tile grid. It catches exits, gems and switches that can't be reached, but it **does not prove a level is solvable**, so you still need to playtest. To jump straight to a level, open `/?level=N`. This only works in a new room.

## Format

Each level is 40×23 tiles of 24px. The `rows` field is a picture of the level in characters:

| Char | Meaning |
|---|---|
| `#` | Rock |
| `.` | Empty |
| `L` | Lava pool. Fire is safe; Water dies |
| `~` | Water pool. Water is safe; Fire dies |
| `A` | Acid pool. Both die |
| `^` | Fan shaft. Pushes characters up while they're inside it |
| `F` / `W` | Fire / Water spawn point, the cell the character stands in |
| `f` / `w` | Fire / Water exit door, the cell the character stands in. It needs rock below it |
| `r` / `b` | Red gem (Fire only) / blue gem (Water only) |

Pools replace a floor tile: a character dies by standing on one, not by touching it from the side.

`objects` holds the mechanisms. Objects on the same **channel** (`ch`) are linked together and share a colour in the game.

```json
{ "type": "plate", "at": [x, y], "ch": 1 }
{ "type": "lever", "at": [x, y], "ch": 1, "dir": 1, "toggle": false }
{ "type": "gate",  "at": [x, y], "size": [w, h], "ch": 1, "invert": false }
```

- **plate**: active while anyone stands on it.
- **lever**: turns on when someone walks through it in direction `dir` (1 = right, -1 = left) and stays on. With `"toggle": true`, walking through it the other way turns it off again.
- **gate**: solid while its channel is off and open while it's on. `invert` swaps this. A gate never closes on top of a character. Vertical gates must be at least 2 tiles tall, because characters are 30px tall.

## The 32 draft levels

There are four worlds of eight levels each. Each world introduces one idea and the later levels combine them.

| World | Levels | Introduces |
|---|---|---|
| 1. Cinder Caves | 1–8 | Walking, jumping, pools, gems, partner boost (4), split routes (3, 6), first plate (8) |
| 2. Tide Halls | 9–16 | Levers, plates on ledges, holding gates for each other (11), inverted gates (12), several channels (15, 16) |
| 3. Gale Spire | 17–24 | Fans, gates across fan shafts (19, 23), mirrored halves where each player opens the other's gate (22, 24) |
| 4. Twin Core | 25–32 | Everything together: long mirrored climbs, acid runs, plate relays (27), toggle switchbacks (28), the finale (32) |

These are **first drafts**. The checker passes all 32, but none has been played yet. The difficulty curve, timing and fun all need tuning on real phones.
