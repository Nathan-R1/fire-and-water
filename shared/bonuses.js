// Challenge mode bonus catalogue, shared by server (rules) and client (names, icons).
//
//   type    'instant'  applied once when chosen (Heal)
//           'power'    a personal passive on the player who picked it
//           'item'     goes into the team inventory (unlimited):
//                        color 'yellow' = active: a player equips it and uses it with ✦
//                        color 'green'  = passive: always on for the team
//   pool    'shared'   offered in the team vote; 'personal' offered to each player
//   rarity  'common' after normal rooms, 'rare' after boss rooms

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Bonuses = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // 24×24 SVG icons, drawn with currentColor so the bar can tint them.
  const svg = (body) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  const LIST = [
    // ── shared, common ──
    { id: 'heal2', type: 'instant', pool: 'shared', rarity: 'common', name: 'Heal 2',
      desc: 'The team gets 2 hearts back.',
      icon: svg('<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/><path d="M12 9v6M9 12h6"/>') },
    { id: 'shield', type: 'item', color: 'green', pool: 'shared', rarity: 'common', name: 'Guardian',
      desc: 'Passive. Once per room, the first thing that would kill either of you is ignored instead.',
      icon: svg('<path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z"/>') },
    { id: 'blast', type: 'item', color: 'yellow', pool: 'shared', rarity: 'common', name: 'Blast',
      desc: 'Active. Destroys enemies and shots close to you and stuns bosses for a moment. Recharges every room.',
      icon: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/>') },
    // ── shared, rare (after bosses) ──
    { id: 'swap', type: 'item', color: 'yellow', pool: 'shared', rarity: 'rare', name: 'Swap',
      desc: 'Active, one use. You and your partner swap places instantly.',
      icon: svg('<path d="M4 8h13l-3-3M20 16H7l3 3"/>') },
    { id: 'reroll', type: 'item', color: 'yellow', pool: 'shared', rarity: 'rare', name: 'Reroll',
      desc: 'Active, one use. Swaps the current room for a different one. Not in boss rooms.',
      icon: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="9" cy="15" r="1"/>') },
    { id: 'fullheal', type: 'instant', pool: 'shared', rarity: 'rare', name: 'Second Wind',
      desc: 'Hearts refilled to the maximum, and the maximum goes up by 1.',
      icon: svg('<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/><path d="M12 8v6M9.5 10.5L12 8l2.5 2.5"/>') },
    // ── personal, common ──
    { id: 'spring', type: 'power', pool: 'personal', rarity: 'common', name: 'Spring',
      desc: 'Passive. You jump higher.',
      icon: svg('<path d="M6 20h12M8 16l8-2-8-2 8-2-8-2 8-2"/><path d="M12 4V2"/>') },
    { id: 'acidskin', type: 'power', pool: 'personal', rarity: 'common', name: 'Acid Skin',
      desc: 'Passive. Acid can\'t hurt you, including the boss\'s acid floor.',
      icon: svg('<path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z"/><path d="M9 14l2 2 4-4"/>') },
    { id: 'magnet', type: 'power', pool: 'personal', rarity: 'common', name: 'Magnet',
      desc: 'Passive. You collect stars from further away.',
      icon: svg('<path d="M6 4v8a6 6 0 0 0 12 0V4"/><path d="M6 8h4M14 8h4"/>') },
    { id: 'swift', type: 'power', pool: 'personal', rarity: 'common', name: 'Swift',
      desc: 'Passive. You run faster.',
      icon: svg('<path d="M4 12h10M6 8h8M6 16h8"/><path d="M15 6l5 6-5 6"/>') },
    // ── personal, rare (after bosses) ──
    { id: 'doublejump', type: 'power', pool: 'personal', rarity: 'rare', name: 'Double Jump',
      desc: 'Passive. Jump again in mid-air.',
      icon: svg('<path d="M12 21V11M8 15l4-4 4 4"/><path d="M12 11V3M8 7l4-4 4 4"/>') },
    { id: 'wings', type: 'item', color: 'yellow', pool: 'personal', rarity: 'rare', name: 'Wings',
      desc: 'Active. Fly upwards for 3 seconds. Recharges every room.',
      icon: svg('<path d="M12 12c-3-6-8-6-10-5 1 4 4 7 10 7"/><path d="M12 12c3-6 8-6 10-5-1 4-4 7-10 7"/><path d="M12 12v8"/>') },
  ];

  const BY_ID = Object.fromEntries(LIST.map((b) => [b.id, b]));
  const pool = (p, rarity) => LIST.filter((b) => b.pool === p && b.rarity === rarity);

  // Per-character physics modifiers for a list of power ids.
  function mods(powers) {
    const has = (id) => powers.includes(id);
    return {
      jumpMul: has('spring') ? 1.15 : 1,
      speedMul: has('swift') ? 1.15 : 1,
      maxAirJumps: has('doublejump') ? 1 : 0,
      acidImmune: has('acidskin'),
      magnet: has('magnet') ? 30 : 0,
    };
  }

  return { LIST, BY_ID, pool, mods, WINGS_SECONDS: 3 };
});
