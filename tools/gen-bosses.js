// Challenge mode boss arenas (levels/boss-*.json; not part of the campaign list).
// The enemies themselves are added by src/challenge.js. Exits are open from the start:
// each arena is a gauntlet to get both players out while the bosses attack.
// Usage: node tools/gen-bosses.js

const { level } = require('./gen-levels-33-58');

// Boss 1: a flyer sweeping the upper air and a walker on the floor that grows over 60 s.
// Early on you can jump the walker; later you need the platforms to get past it.
level('boss-1', 'boss-1', 'The Twins', 9, (L) => {
  L.extra = { boss: { flyer: { x0: 4, x1: 36, y: 9.5, amp: 3 }, walker: { x0: 6, x1: 33, x: 6 } } };
  L.put(3, 20, 'F'); L.put(2, 20, 'W');
  L.plat(8, 12, 17); L.plat(15, 19, 14); L.plat(22, 26, 17); L.plat(29, 32, 14);
  L.pool(13, 14, 21, 'L'); L.pool(27, 28, 21, '~');
  L.put(10, 15, 'r'); L.put(17, 12, 'b'); L.put(24, 15, 'r'); L.put(30, 12, 'b');
  L.put(37, 20, 'f'); L.put(35, 20, 'w');
});

// Boss 1, arena 2: three layers. The ground twin patrols the bottom row, the middle
// layer is a long ledge full of acid pits, and the flying twin guards the top layer
// where the exits are. Bottom → steps at the far right → middle (left) → top (right).
level('boss-1b', 'boss-1b', 'The Twins: Three Layers', 9, (L) => {
  L.extra = { boss: { flyer: { x0: 6, x1: 36, y: 4.5, amp: 2 }, walker: { x0: 1, x1: 38, x: 14 } } };
  L.put(3, 20, 'F'); L.put(2, 20, 'W');
  L.plat(36, 38, 18); L.plat(37, 38, 15);                    // up to the middle layer
  L.plat(6, 35, 14);                                         // middle layer…
  for (const [x0, x1] of [[9, 10], [14, 15], [19, 21], [25, 26], [30, 31]]) L.pool(x0, x1, 14, 'A'); // …full of acid
  L.plat(2, 4, 11);                                          // up to the top layer
  L.plat(6, 38, 8);                                          // top layer
  L.pool(18, 19, 8, 'L'); L.pool(26, 27, 8, '~');
  L.put(12, 19, 'r'); L.put(24, 19, 'b'); L.put(17, 12, 'r'); L.put(28, 12, 'b'); L.put(14, 6, 'b'); L.put(30, 6, 'r');
  L.put(37, 7, 'f'); L.put(35, 7, 'w');
});

// Boss 1, arena 3: half-height walls. The middle and right rooms are roofed over, so
// the only ways in are gates at the bottom of the walls. Climb onto the roof, pull the
// two levers on the high ledges (the flying twin guards them), then go back down and
// through the gates. The ground twin starts shut in the middle room; open gates let
// it roam further.
level('boss-1c', 'boss-1c', 'The Twins: Half Walls', 9, (L) => {
  L.extra = { boss: { flyer: { x0: 4, x1: 36, y: 5, amp: 2.5 }, walker: { x0: 1, x1: 38, x: 18 } } };
  L.put(3, 20, 'F'); L.put(2, 20, 'W');
  L.rect(12, 10, 38, 10);                                    // roof over the middle and right rooms
  L.wall(12, 11, 16); L.gate(12, 17, 1, 4, 1);               // left wall, with its gate
  L.wall(27, 11, 16); L.gate(27, 17, 1, 4, 2);               // right wall, with its gate
  L.plat(2, 5, 18); L.plat(7, 10, 15); L.plat(2, 5, 12); L.plat(8, 11, 10); // up onto the roof
  L.plat(16, 19, 7); L.lever(17, 6, 1);                      // the high levers
  L.plat(29, 32, 7); L.lever(30, 6, 2);
  L.pool(22, 23, 10, 'L'); L.pool(34, 35, 10, '~');           // one of each element on the roof
  L.put(19, 18, 'r'); L.put(21, 18, 'b'); L.put(18, 4, 'r'); L.put(31, 4, 'b'); L.put(9, 8, 'r'); L.put(23, 7, 'b');
  L.put(37, 20, 'f'); L.put(35, 20, 'w');
});

// Boss 2: a turret firing at you from the top, and every few seconds a 3-2-1 countdown
// after which all ground is acid for half a second: be in the air. Climb to the exits.
level('boss-2', 'boss-2', 'Acid Rain', 9, (L) => {
  L.put(3, 20, 'F'); L.put(2, 20, 'W');
  L.plat(7, 11, 18); L.plat(13, 17, 15); L.plat(19, 23, 12); L.plat(25, 29, 9);
  L.plat(31, 38, 6);
  L.pool(15, 16, 15, 'L'); L.pool(21, 22, 12, '~');
  L.put(9, 16, 'r'); L.put(15, 12, 'b'); L.put(21, 9, 'r'); L.put(27, 7, 'b');
  L.put(37, 5, 'f'); L.put(34, 5, 'w');
});

if (require.main === module) console.log('boss arenas written');
