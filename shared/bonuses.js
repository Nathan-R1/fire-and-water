// Challenge mode bonus catalogue, shared by server (rules) and client (names, icons).
//
//   type    'instant'  applied once when chosen (Heal)
//           'item'     kept for the rest of the run
//   scope   'team'     goes in the team inventory (unlimited), either player can use it
//           'personal' belongs to the player who picked it; never in the team inventory
//   color   'yellow'   active: equip one at a time (each player separately), use with ✦
//           'green'    passive: always on (for the team, or for its owner)
//   rarity  'common' | 'uncommon' after normal rooms (stars raise the uncommon chance),
//           'rare' after boss rooms
//   repeat  true: keeps being offered after you have it, and copies stack
//   exclusive  true: replaces your other actives. Once you have it it's equipped for
//           good: you can't switch away from it or use any other active item
//   uses    'toggle'   switch it on and off as often as you like
//   uses    'combat'   once per room attempt (recharges when the room starts or restarts)
//           'once'     once per run; stays in the bar afterwards, used up
//           'cooldown' unlimited, with `cooldown` seconds between uses
//           'free'     unlimited

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Bonuses = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // 24×24 SVG icons, drawn with currentColor so the bar can tint them.
  const svg = (body) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  const LIST = [
    // ── team, common ──
    { id: 'heal2', type: 'instant', scope: 'team', rarity: 'common', name: 'Heal 2',
      desc: 'The team gets 2 hearts back.',
      icon: svg('<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/><path d="M12 9v6M9 12h6"/>') },
    { id: 'guardian', type: 'item', scope: 'team', color: 'green', rarity: 'common', name: 'Guardian',
      desc: 'Each room, the first time either of you takes damage you\'re shielded for 1 second instead: nothing can hurt you.',
      icon: svg('<path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z"/>') },
    { id: 'blast', type: 'item', scope: 'team', color: 'yellow', rarity: 'common', uses: 'combat', name: 'Blast',
      desc: 'Destroys enemies and shots close to you and stuns bosses for a moment. Once per room.',
      icon: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/>') },
    { id: 'crate', type: 'item', scope: 'team', color: 'yellow', rarity: 'common', uses: 'combat', name: 'Create Box',
      desc: 'Drops a box right in front of you. Once per room.',
      icon: svg('<rect x="4" y="6" width="16" height="14" rx="1"/><path d="M4 6l8 6 8-6M12 2v4"/>') },
    { id: 'geyser', type: 'item', scope: 'team', color: 'yellow', rarity: 'common', uses: 'combat', name: 'Geyser',
      desc: 'An updraft bursts up where you\'re standing for 5 seconds, carrying anyone in it upwards. Once per room.',
      icon: svg('<path d="M8 21v-6M12 21V9M16 21v-6"/><path d="M9 6l3-3 3 3M6 10l2-2 2 2M14 10l2-2 2 2"/>') },
    { id: 'keeneye', type: 'item', scope: 'team', color: 'green', rarity: 'common', name: 'Keen Eye',
      desc: 'Decoys can\'t fool you: mimic boxes show their eyes and can\'t hurt you.',
      icon: svg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>') },
    // ── team, rare (after bosses) ──
    { id: 'slowtime', type: 'item', scope: 'team', color: 'green', rarity: 'rare', repeat: true, name: 'Slow Time',
      desc: 'Enemies and their shots move 25% slower. Stacks.',
      icon: svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>') },
    { id: 'lastchance', type: 'item', scope: 'team', color: 'green', rarity: 'rare', name: 'Last Chance',
      desc: 'Once per room, when one of you would die they turn intangible for 5 seconds instead: get back to your start in time and the room restarts with no heart lost.',
      icon: svg('<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/><path d="M12 8v4l2 1"/>') },
    { id: 'swap', type: 'item', scope: 'team', color: 'yellow', rarity: 'rare', uses: 'cooldown', cooldown: 1, name: 'Swap',
      desc: 'You and your partner swap places instantly. As often as you like.',
      icon: svg('<path d="M4 8h13l-3-3M20 16H7l3 3"/>') },
    { id: 'reroll', type: 'item', scope: 'team', color: 'yellow', rarity: 'rare', uses: 'once', name: 'Reroll',
      desc: 'Swaps the current room for a different one. One use for the whole team. Not in boss rooms.',
      icon: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="9" cy="15" r="1"/>') },
    { id: 'fullheal', type: 'instant', scope: 'team', rarity: 'rare', name: 'Second Wind',
      desc: 'Hearts refilled to the maximum, and the maximum goes up by 1.',
      icon: svg('<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/><path d="M12 8v6M9.5 10.5L12 8l2.5 2.5"/>') },
    // ── personal, common ──
    { id: 'spring', type: 'item', scope: 'personal', color: 'green', rarity: 'common', repeat: true, name: 'Spring',
      desc: 'You jump 15% higher. Stacks.',
      icon: svg('<path d="M6 20h12M8 16l8-2-8-2 8-2-8-2 8-2"/><path d="M12 4V2"/>') },
    { id: 'acidskin', type: 'item', scope: 'personal', color: 'green', rarity: 'common', name: 'Acid Skin',
      desc: 'Acid can\'t hurt you, including the boss\'s acid floor.',
      icon: svg('<path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z"/><path d="M9 14l2 2 4-4"/>') },
    { id: 'magnet', type: 'item', scope: 'personal', color: 'green', rarity: 'common', repeat: true, name: 'Magnet',
      desc: 'You collect stars from further away. Stacks.',
      icon: svg('<path d="M6 4v8a6 6 0 0 0 12 0V4"/><path d="M6 8h4M14 8h4"/>') },
    { id: 'swift', type: 'item', scope: 'personal', color: 'green', rarity: 'common', repeat: true, name: 'Swift',
      desc: 'You run 15% faster. Stacks.',
      icon: svg('<path d="M4 12h10M6 8h8M6 16h8"/><path d="M15 6l5 6-5 6"/>') },
    { id: 'recall', type: 'item', scope: 'personal', color: 'yellow', rarity: 'common', uses: 'combat', name: 'Recall',
      desc: 'Teleport back to your starting spot. Once per room.',
      icon: svg('<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v4h4"/><circle cx="12" cy="12" r="2"/>') },
    // ── personal, uncommon (stars raise the chance) ──
    { id: 'gun', type: 'item', scope: 'personal', color: 'yellow', rarity: 'uncommon', uses: 'cooldown', cooldown: 0.35, name: 'Blaster',
      desc: 'Fires a short-range shot the way you\'re facing: destroys sentries, stuns bosses. Unlimited ammo.',
      icon: svg('<path d="M3 9h13l3 2-3 2H9l-2 5H4l1-5H3z"/><path d="M21 11h1"/>') },
    { id: 'cloak', type: 'item', scope: 'personal', color: 'yellow', rarity: 'uncommon', uses: 'combat', duration: 10, name: 'Cloak',
      desc: 'For 10 seconds enemies can\'t see you: the turret won\'t aim at you and touching enemies is harmless. Pools and stray shots still count. Once per room.',
      icon: svg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><path d="M4 20L20 4"/>') },
    { id: 'shield', type: 'item', scope: 'personal', color: 'yellow', rarity: 'uncommon', uses: 'combat', duration: 5, name: 'Shield',
      desc: 'Invulnerable to everything for 5 seconds. Once per room.',
      icon: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v10M7 12h10"/>') },
    { id: 'ward', type: 'item', scope: 'personal', color: 'green', rarity: 'uncommon', repeat: true, name: 'Element Ward',
      desc: 'Stepping into your own element (lava for Fire, water for Water) shields you from everything for 1 second. Stacks: +1 second per copy.',
      icon: svg('<path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z"/><path d="M12 8c1.5 2 2.5 3 2.5 4.5a2.5 2.5 0 0 1-5 0C9.5 11 10.5 10 12 8z"/>') },
    { id: 'stomp', type: 'item', scope: 'personal', color: 'green', rarity: 'uncommon', name: 'Stomp',
      desc: 'Land on an enemy from above to destroy it (bigger ones and bosses are stunned instead) and bounce off.',
      icon: svg('<path d="M7 3h6l1 9h4v4H6z"/><path d="M4 21h16M8 18l-2 3M16 18l2 3"/>') },
    { id: 'solidify', type: 'item', scope: 'personal', color: 'yellow', rarity: 'uncommon', uses: 'combat', name: 'Solidify',
      desc: 'While standing in your own element, harden that whole pool so your teammate can walk on it, for the rest of the room. Once per room.',
      icon: svg('<path d="M3 17h18M5 17l2-5h10l2 5"/><path d="M8 12l1-3h6l1 3"/>') },
    { id: 'beacon', type: 'item', scope: 'personal', color: 'yellow', rarity: 'uncommon', uses: 'combat', name: 'Beacon',
      desc: 'Teleport to your teammate. Once per room.',
      icon: svg('<circle cx="12" cy="8" r="3"/><path d="M12 11v10M8 21h8"/><path d="M5 5a10 10 0 0 0 0 6M19 5a10 10 0 0 1 0 6"/>') },
    // ── personal, rare (after bosses) ──
    { id: 'doublejump', type: 'item', scope: 'personal', color: 'green', rarity: 'rare', name: 'Double Jump',
      desc: 'Jump again in mid-air.',
      icon: svg('<path d="M12 21V11M8 15l4-4 4 4"/><path d="M12 11V3M8 7l4-4 4 4"/>') },
    { id: 'dualwield', type: 'item', scope: 'personal', color: 'green', rarity: 'rare', name: 'Dual Wield',
      desc: 'A second active slot with its own button: two active items ready at once.',
      icon: svg('<rect x="3" y="7" width="8" height="10" rx="2"/><rect x="13" y="7" width="8" height="10" rx="2"/>') },
    { id: 'phase', type: 'item', scope: 'personal', color: 'yellow', rarity: 'rare', uses: 'toggle', exclusive: true, name: 'Phase',
      desc: 'Toggle on to pass through boxes, gates, platforms, mimics and your teammate (not walls or floors). You still take damage. Replaces your other actives: once you have it, it\'s your only one.',
      icon: svg('<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/><path d="M8 12h8"/>') },
    { id: 'wings', type: 'item', scope: 'personal', color: 'yellow', rarity: 'rare', uses: 'cooldown', cooldown: 5, duration: 3, name: 'Wings',
      desc: 'Fly upwards for 3 seconds. Unlimited, with 5 seconds between flights.',
      icon: svg('<path d="M12 12c-3-6-8-6-10-5 1 4 4 7 10 7"/><path d="M12 12c3-6 8-6 10-5-1 4-4 7-10 7"/><path d="M12 12v8"/>') },
  ];

  const BY_ID = Object.fromEntries(LIST.map((b) => [b.id, b]));
  const pool = (scope, rarity) => LIST.filter((b) => b.scope === scope && b.rarity === rarity);

  // Per-character physics modifiers from a player's personal passive items. Spring,
  // Swift and Magnet stack: each copy adds the same amount again.
  function mods(ids) {
    const count = (id) => ids.filter((x) => x === id).length;
    return {
      jumpMul: 1 + 0.15 * count('spring'),
      speedMul: 1 + 0.15 * count('swift'),
      maxAirJumps: count('doublejump') ? 1 : 0,
      acidImmune: count('acidskin') > 0,
      magnet: 30 * count('magnet'),
    };
  }

  return { LIST, BY_ID, pool, mods, WINGS_SECONDS: 3 };
});
