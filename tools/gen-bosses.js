// Challenge mode boss arenas (levels/boss-*.json; not part of the campaign list).
// The enemies themselves are added by src/challenge.js. Exits are open from the start:
// each arena is a gauntlet to get both players out while the bosses attack.
// Usage: node tools/gen-bosses.js

const { level } = require('./gen-levels-33-58');

// Boss 1: a flyer sweeping the upper air and a walker on the floor that grows over 60 s.
// Early on you can jump the walker; later you need the platforms to get past it.
level('boss-1', 'boss-1', 'The Twins', 9, (L) => {
  L.put(3, 20, 'F'); L.put(2, 20, 'W');
  L.plat(8, 12, 17); L.plat(15, 19, 14); L.plat(22, 26, 17); L.plat(29, 32, 14);
  L.pool(13, 14, 21, 'L'); L.pool(27, 28, 21, '~');
  L.put(10, 15, 'r'); L.put(17, 12, 'b'); L.put(24, 15, 'r'); L.put(30, 12, 'b');
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
