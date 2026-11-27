// Generator for levels 59–64: the harder Grand Machine levels. Each one combines the
// advanced mechanics below; the intended solutions run through the real physics in
// test/solutions.test.js. Usage: node tools/gen-levels-59-64.js
//
//   stepping stone  a box pushed into the middle of a pool too wide to jump, by the
//                   player who can wade in it, so the other player can hop across
//   box door        a box sitting in a 2-tall pool tunnel; only the player who can
//                   stand in that pool can push it out of the way
//   lid             a pulley platform plugging a shaft: it moves only when the other
//                   side of the pulley gets heavier (or lighter)
//   ratchet         with equal weights, each time you jump off your platform the other
//                   side is briefly heavier, so yours rises a little: jump, jump, jump
//   lift a box      ratchet a box up and push it onto a plate on the upper floor
//   tiers           stacked floors, each with its own hazards and switches

const { level } = require('./gen-levels-33-58');

level(59, 'stepping-stones', 'Stepping Stones', 8, (L) => {
  L.put(3, 20, 'F'); L.put(2, 20, 'W');
  L.pool(7, 13, 21, 'L');            // too wide for water: fire wades out…
  L.box(17, 20);                     // …fetches this box and pushes it into the middle
  L.pool(22, 28, 21, '~');           // too wide for fire: water does the same…
  L.box(31, 20);                     // …with this one, then shoves it on to the ledge as a step
  L.ground(33, 38, 17);
  L.put(10, 17, 'r'); L.put(25, 17, 'b'); L.put(16, 18, 'b'); L.put(19, 18, 'r');
  L.put(37, 16, 'f'); L.put(35, 16, 'w');   // fire gets up first, so his door is the far one
});

level(60, 'three-tiers', 'Three Tiers', 8, (L) => {
  L.put(3, 20, 'F'); L.put(2, 20, 'W');
  L.plat(5, 7, 18);                                    // up to tier 1
  // tier 0 (the floor): the box has to go on the plate that opens tier 1's gate
  L.box(12, 20); L.plate(30, 20, 1);
  // tier 1
  L.plat(9, 38, 15);
  L.pool(14, 16, 15, 'L'); L.pool(20, 22, 15, '~'); L.pool(26, 27, 15, 'A');
  L.gate(33, 10, 1, 5, 1);
  L.plat(35, 37, 12);                                  // up to tier 2
  // tier 2: one holds the plate while the other rides the fan to the top…
  L.plat(8, 34, 9);
  L.pool(28, 29, 9, '~'); L.pool(21, 22, 9, 'L');
  L.plate(15, 8, 2);
  L.wall(12, 1, 4); L.gate(12, 5, 1, 4, 2);
  L.fan(8, 9, 4, 8);
  // tier 3: …and latches the lever up there so the gate stays open for the other
  L.plat(1, 7, 4);
  L.lever(5, 3, 2, { dir: -1 });
  L.put(2, 3, 'f'); L.put(3, 3, 'w');
  L.put(20, 18, 'r'); L.put(24, 18, 'b'); L.put(15, 12, 'b'); L.put(21, 12, 'r');
  L.put(28, 6, 'b'); L.put(21, 6, 'r'); L.put(6, 1, 'r'); L.put(4, 1, 'b');
});

level(61, 'ratchet', 'Ratchet', 8, (L) => {
  L.put(24, 20, 'F'); L.put(22, 20, 'W');
  // Water's pulley side (b) with a box on it; the counterweight side (a) up on the right.
  L.pulley([26, 10], [4, 18], 3, 0, 8);
  L.box(6, 17);
  L.plat(7, 15, 10); L.plate(11, 9, 1);                 // the box goes on this plate
  // fire's way up to the counterweight side, with the second box
  L.plat(30, 32, 18); L.plat(34, 35, 15); L.plat(36, 38, 12);
  L.plat(29, 33, 10); L.box(30, 9);
  // fire's exit, behind the gate the plate opens
  L.wall(37, 13, 15); L.gate(37, 16, 1, 5, 1);
  L.put(38, 20, 'f'); L.put(8, 9, 'w');      // water's exit is before the plate, so she doesn't push the box off
  L.put(5, 13, 'b'); L.put(5, 11, 'b'); L.put(32, 7, 'r'); L.put(35, 12, 'r'); L.put(10, 19, 'r');
});

level(62, 'lids', 'Lids', 8, (L) => {
  L.rect(1, 12, 38, 13);                                // the slab between the hall and the cavern
  L.pool(1, 38, 21, 'L');                               // the cavern floor is lava
  L.put(3, 11, 'F'); L.put(10, 11, 'W');
  // Lid 1 (a) over a drop shaft, held shut by the box on its other side (b)
  L.pulley([6, 12], [12, 12], 3, 0, 8);
  L.box(13, 11);
  // Down in the cavern: the lever that opens the exit gate
  L.lever(20, 20, 1);
  // Lid 2 (a) over a fan shaft back up; stand on its other side (b) to lift it
  L.fan(30, 32, 12, 20);
  L.pulley([30, 12], [24, 12], 3, -2, 0);
  L.wall(34, 1, 7); L.gate(34, 8, 1, 4, 1);
  L.put(38, 11, 'f'); L.put(36, 11, 'w');
  L.put(15, 18, 'r'); L.put(25, 18, 'r'); L.put(31, 9, 'r'); L.put(18, 9, 'b'); L.put(28, 9, 'b');
});

level(63, 'box-doors', 'Box Doors', 8, (L) => {
  L.rect(8, 1, 31, 5);                                  // the corridor's ceiling
  L.plat(17, 22, 8);                                    // start, between two tunnels
  L.put(18, 7, 'W'); L.put(21, 7, 'F');                 // each starts next to their own tunnel
  L.pool(8, 16, 8, '~'); L.box(13, 7);                  // water tunnel: only water can push this box
  L.pool(23, 31, 8, 'L'); L.box(26, 7);                 // lava tunnel: only fire can push this one
  L.pool(2, 8, 21, '~');                                // its box becomes fire's stepping stone…
  L.pool(31, 37, 21, 'L');                              // …and this box water's
  L.put(1, 20, 'f'); L.put(38, 20, 'w');
  L.put(5, 17, 'r'); L.put(34, 17, 'b'); L.put(11, 6, 'b'); L.put(28, 6, 'r');
});

level(64, 'grand-machine', 'The Grand Machine', 8, (L) => {
  L.rect(1, 13, 38, 14);                         // slab: the lower hall (rows 15–20) and the upper hall
  L.put(3, 20, 'F'); L.put(2, 20, 'W');
  // 1. lower hall: fire fetches a box across the lava to be water's stepping stone
  L.pool(6, 12, 21, 'L'); L.box(15, 20);
  // 2. the lid: a box keeps it shut; both stand on its counterweight to lift it, fire rides
  //    the fan up; up top he pushes the box off so water can open it alone and follow
  L.pulley([25, 13], [19, 18], 3, -2, 0);
  L.box(26, 12);
  L.fan(25, 27, 13, 20);
  // 3. the ratchet: water + that box on b, fire + the box from the mid ledge on a
  L.pulley([14, 5], [31, 13], 3, 0, 7);   // a stops just above the slab, so no hole
  L.plat(4, 6, 10); L.plat(7, 9, 7); L.plat(10, 13, 5); L.box(12, 4);
  // 4. the box goes on the plate up on the high ledge; that opens fire's gate
  L.plat(34, 38, 6); L.plate(36, 5, 1);
  L.wall(37, 7, 8); L.gate(37, 9, 1, 4, 1);
  L.put(38, 12, 'f'); L.put(34, 5, 'w');
  L.put(9, 17, 'r'); L.put(22, 19, 'b'); L.put(32, 9, 'b'); L.put(11, 2, 'r'); L.put(28, 11, 'r'); L.put(5, 7, 'b');
});

if (require.main === module) console.log('levels 59–64 written');
