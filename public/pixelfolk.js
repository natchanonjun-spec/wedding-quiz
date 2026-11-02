/* Pixel folk - the wedding guests running across the lobby.
 *
 * Drawn here as text grids instead of image files so every guest can get
 * their own random look (outfit, hair style, colours, accessory) out of a few
 * shared shapes, recoloured per guest and baked once into a tiny 4-frame
 * walk-cycle sprite sheet. The dark outline is added automatically around the
 * silhouette, the way Stardew-style sprites are.
 *
 * Grid legend (fills only - no outline, '.' is empty):
 *   h/k/H hair base/shade/highlight   s/S skin/shade   e eye   c blush
 *   t/T   outfit base/shade (jacket, gown)              w shirt   x tie/bow
 *   p/P   trousers base/shade   b shoe   a/A accessory   f flower
 */
(function () {
  'use strict';

  var W = 16, H = 33;           // art size; the sheet adds a 1px outline margin

  // Head, facing right. Rows 0-1 are headroom for buns and hats.
  var HEAD = [
    '................',
    '................',
    '.......hhhh.....',
    '.....hhHHHhh....',
    '....hhHHhhhhh...',
    '....khhhhhhhhh..',
    '...kkhhhhhhhhh..',
    '...kkhhhhhhsss..',
    '...kkhhhhhsssss.',
    '...kkhhhhsssess.',
    '...kkkhhSsssess.',
    '...kkkhhssssssss',
    '....kkkhSsscsss.',
    '.....kkSssssss..',
    '.......SSsss....',
    '........SSs.....'
  ];
  var BOB = [0, -1, 0, -1];     // passing frames ride a pixel higher

  // Arms, drawn over the torso: swung back / at the side / swung forward.
  // 'q' is the sleeve (jacket colour or bare skin) and 's' the hand.
  var ARMS = [
    ['........', '.......q', '......q.', '.....q..', '....q...', '....s...'],
    ['.......q', '.......q', '.......q', '.......q', '.......q', '.......s'],
    ['.......q', '........q', '.........q', '.........q', '..........q', '..........s']
  ];
  var ARM_FOR_FRAME = [0, 1, 2, 1];

  // --- suits: jacket, white shirt front, bow tie; trousers below.
  var SUIT_TORSO = [
    '......tttwww....',
    '.....ttttwxx....',
    '.....Tttttww....',
    '.....Tttttttw...',
    '.....TTtttttt...',
    '.....TTtttttt...',
    '.....TTttttt....',
    '......Tttttt....'
  ];
  var TROUSERS = [
    ['......pppppp....', '......pppppp....', '.....PPp..ppp...', '.....PP....ppp..', '....PP......pp..',
     '....PP......pp..', '...PP........pp.', '...PP........pp.', '..bbb........bbb'],
    ['......pppppp....', '......pppppp....', '......pPPppp....', '......PPppp.....', '......PP.pp.....',
     '......PP.pp.....', '......PP.pp.....', '......PP.pp.....', '.....bbb.bbb....'],
    ['......pppppp....', '......pppppp....', '.....ppp..PPp...', '....ppp....PPP..', '....pp......PP..',
     '....pp......PP..', '...pp........PP.', '...pp........PP.', '..bbb........bbb'],
    ['......pppppp....', '......pppppp....', '......pppPPp....', '.......pppPP....', '.......pp.PP....',
     '.......pp.PP....', '.......pp.PP....', '.......pp.PP....', '......bbb.bbb...']
  ];

  // --- gowns: bodice, then a long skirt whose hem sways with the step.
  var GOWN_TORSO = [
    '......tttss.....',
    '......ttttt.....',
    '.....Tttttt.....',
    '.....Tttttt.....',
    '.....TTtttt.....',
    '......tttt......',
    '......tttt......',
    '.....tttttt.....'
  ];
  var GOWN_SKIRT = [
    ['.....Tttttt.....', '....Ttttttttt...', '....TTtttttt....', '...TTtttttttt...', '...TTttttttttt..',
     '..TTtttttttttt..', '..TTttttttttttt.', '..TTTTTTTTTTTTt.', '...bbb......bb..'],
    ['.....Tttttt.....', '.....Tttttttt...', '....TTtttttt....', '....TTttttttt...', '...TTttttttttt..',
     '...TTttttttttt..', '...TTtttttttt...', '...TTTTTTTTTT...', '.....bbbbbb.....'],
    ['.....Tttttt.....', '....Ttttttttt...', '....TTttttttt...', '...TTttttttttt..', '...TTtttttttttt.',
     '..TTttttttttttt.', '.TTtttttttttttt.', '.tTTTTTTTTTTTT..', '..bb......bbb...'],
    ['.....Tttttt.....', '.....Tttttttt...', '....TTtttttt....', '....TTttttttt...', '...TTttttttttt..',
     '...TTttttttttt..', '...TTtttttttt...', '...TTTTTTTTTT...', '.....bbbbbb.....']
  ];

  // --- cocktail dress: to the knee, then bare legs.
  var SHORT_SKIRT = [
    ['.....Tttttt.....', '....Ttttttttt...', '....TTTTTTTTT...', '.....SS....ss...', '....SS......ss..',
     '....SS......ss..', '...SS........ss.', '...SS........ss.', '..bbb........bbb'],
    ['.....Tttttt.....', '.....Tttttttt...', '.....TTTTTTTT...', '......SS.ss.....', '......SS.ss.....',
     '......SS.ss.....', '......SS.ss.....', '......SS.ss.....', '.....bbb.bbb....'],
    ['.....Tttttt.....', '....Ttttttttt...', '....TTTTTTTTT...', '.....ss....SS...', '....ss......SS..',
     '....ss......SS..', '...ss........SS.', '...ss........SS.', '..bbb........bbb'],
    ['.....Tttttt.....', '.....Tttttttt...', '.....TTTTTTTT...', '.......ss.SS....', '.......ss.SS....',
     '.......ss.SS....', '.......ss.SS....', '.......ss.SS....', '......bbb.bbb...']
  ];

  // --- hair styles, overlaid on the head rows.
  var HAIR = {
    short: [],
    long: ['', '', '', '', '', '', '', '', '', '', '', '', '...kh...........', '...khh..........',
           '...kkhh.........', '....kkh.........', '.....kk.........', '.....kk.........', '......k.........'],
    bun: ['......hhh.......', '.....hHhhh......', '.....hhhhh......'],
    pony: ['', '', '', '', '', '', '', '..hh............', '.hhk............', '.hkk............',
           '.hk.............', '.kk.............', '..k.............', '..k.............'],
    curly: ['', '', '......h.h.h.....', '....hhhhhhhh....', '...hhhhhhhhhh...', '...h..........h.']
  };

  var ACC = {
    none: [],
    flower: ['', '', '', '.........ff.....', '........fAf.....', '.........f......'],
    hat: ['.....aaaaa......', '.....aAAAa......', '...aaaaaaaaa....'],
    veil: ['', '', '', '...aa...........', '..aaa...........', '..aa............', '..aa............',
           '.aaa............', '.aa.............', '.aa.............', '.aa.............', 'aa..............',
           'aa..............']
  };

  /* ---- Facing the viewer: the podium, and each guest's own phone. Same
     palette letters and the same 16x33 box as the side view, drawn symmetric,
     standing still (the frames only breathe a pixel up and down). ---- */
  var F_HEAD = [
    '................',
    '................',
    '.....hhhhhh.....',
    '....hhHHHhhh....',
    '...hhHHhhhhhh...',
    '...hhhhhhhhhh...',
    '...hhsssssshh...',
    '...hssssssssh...',
    '...hsessssesh...',
    '...hsessssesh...',
    '...hcssssssch...',
    '....ssssssss....',
    '....SssccssS....',
    '.....SssssS.....',
    '......SssS......',
    '.......SS.......'
  ];
  var F_SUIT_TORSO = [
    '...ttttwwtttt...',
    '...tttwxxwttt...',
    '...Tttwwwwttt...',
    '...TTttwwttTT...',
    '...TTttttttTT...',
    '...TTttttttTT...',
    '....TttttttT....',
    '....TttttttT....'
  ];
  var F_TROUSERS = [
    '....pppppppp....', '....pppppppp....', '....ppp..ppp....', '....pPp..pPp....', '....pPp..pPp....',
    '....pPp..pPp....', '....pPp..pPp....', '....pPp..pPp....', '...bbbb..bbbb...'
  ];
  var F_GOWN_TORSO = [
    '....ssttttss....',
    '.....tttttt.....',
    '.....TttttT.....',
    '.....TttttT.....',
    '.....TttttT.....',
    '......tttt......',
    '......tttt......',
    '.....tttttt.....'
  ];
  var F_GOWN_SKIRT = [
    '.....TttttT.....', '....TttttttT....', '....TttttttT....', '...TTttttttTT...', '...TTttttttTT...',
    '..TTttttttttTT..', '..TTttttttttTT..', '..TTTTTTTTTTTT..', '....bb....bb....'
  ];
  var F_SHORT_SKIRT = [
    '.....TttttT.....', '....TttttttT....', '....TTTTTTTT....', '.....ss..ss.....', '.....ss..ss.....',
    '.....sS..Ss.....', '.....sS..Ss.....', '.....sS..Ss.....', '....bbb..bbb....'
  ];
  // Arms hang at the sides: just outside the jacket for suits, beside the
  // narrower bodice for gowns and dresses.
  var F_ARMS_SUIT = ['..q..........q..', '..q..........q..', '..q..........q..', '..q..........q..',
                     '..q..........q..', '..q..........q..', '..s..........s..'];
  var F_ARMS_BARE = ['...q........q...', '...q........q...', '...q........q...', '...q........q...',
                     '...q........q...', '...q........q...', '...s........s...'];
  var F_HAIR = {
    short: [],
    long: ['', '', '', '', '', '', '..kh........hk..', '..kh........hk..', '..kh........hk..', '..kh........hk..',
           '..kh........hk..', '..kh........hk..', '..kk........kk..', '..kk........kk..', '..kk........kk..',
           '...k........k...'],
    bun: ['.....hhhhh......', '....hHhhhhh.....'],
    pony: ['', '', '', '', '', '', '', '..hh............', '..hk............', '..k.............'],
    curly: ['', '', '....h.h.h.h.....', '...hhhhhhhhhh...', '..hhhhhhhhhhhh..', '..h..........h..']
  };
  var F_ACC = {
    none: [],
    flower: ['', '', '', '...........ff...', '..........fAf...', '...........f....'],
    hat: ['....aaaaaaaa....', '....aAAAAAAa....', '..aaaaaaaaaaaa..'],
    veil: ['', '', '', '..aa........aa..', '..aa........aa..', '..aa........aa..', '.aaa........aaa.',
           '.aa..........aa.', '.aa..........aa.', '.aa..........aa.', '.aa..........aa.', 'aaa..........aaa',
           'aa............aa', 'aa............aa', 'aa............aa', 'aa............aa']
  };

  // Muted, warm colours picked to sit in the generated scenes rather than pop
  // off them like UI - with the same brown outline the scenes use for shadow.
  var OUTLINE = '#2a1a14';
  var SKINS = [['#f5d0ae', '#d9a07a'], ['#e8b38a', '#c08558'], ['#c68a5e', '#98603c'], ['#8c5a3b', '#653d27']];
  var HAIRS = [
    ['#6b4128', '#4a2b19', '#8e5f3a'], ['#322a33', '#1f1a22', '#51475a'], ['#e0bb5c', '#b08c3c', '#f3d98c'],
    ['#b95a31', '#88401f', '#d67d4c'], ['#c4c3cc', '#95939f', '#e6e5ec'], ['#8a5a3b', '#63402a', '#a97650'],
    ['#1f1a20', '#120f13', '#3a3240'], ['#dd8ea7', '#ad6580', '#f0b6c8']
  ];
  // Suits in classic wedding tones; ties/bows are where the colour goes.
  var SUITS = [['#2e2f3a', '#1d1e26'], ['#2f4468', '#1f2f4a'], ['#6e6e78', '#4f4f58'], ['#c9b48f', '#a38e6a'],
               ['#6b2f3a', '#4b1f28'], ['#4a5a3e', '#34412b']];
  var TIES = ['#c0392b', '#e89ab0', '#d9a441', '#4b7bb5', '#2e2f3a', '#9c7cc4'];
  // Pastel gowns and dresses.
  var GOWNS = [['#f2b8c6', '#d68ea2'], ['#c7b6e6', '#a28fc6'], ['#b9d4b0', '#93b289'], ['#f3dfb0', '#d6bd86'],
               ['#b3d3ec', '#89b0d2'], ['#e8a598', '#c77f72'], ['#d8a7c9', '#b680a6'], ['#9fd0c8', '#76aea5']];
  var FLOWERS = [['#ff8fb1', '#f5d36b'], ['#ffffff', '#f5d36b'], ['#f5d36b', '#c0392b'], ['#c7b6e6', '#fff3d6']];
  var SHOE = '#3a2418';
  var EYE = '#1d1420';
  var BLUSH = '#ec8f86';

  function hex(c) {
    return [parseInt(c.substr(1, 2), 16), parseInt(c.substr(3, 2), 16), parseInt(c.substr(5, 2), 16), 255];
  }
  function darker(rgba, k) { return [rgba[0] * k | 0, rgba[1] * k | 0, rgba[2] * k | 0, 255]; }

  function paint(grid, map, px, ox, oy) {
    for (var y = 0; y < grid.length; y++) {
      var row = grid[y] || '';
      for (var x = 0; x < row.length; x++) {
        var col = map[row[x]];
        if (!col) continue;
        var xx = x + ox, yy = y + oy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        px[yy * W + xx] = col;
      }
    }
  }

  // mulberry32: a tiny seeded PRNG, so a guest's id always gives the same look
  // but neighbouring ids still land on unrelated ones.
  function rng(seed) {
    var a = seed >>> 0;
    return function (m) {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * m) | 0;
    };
  }

  var OUTFITS = ['suit', 'suit', 'gown', 'gown', 'dress'];
  var STYLES_BY_OUTFIT = { suit: ['short', 'short', 'curly', 'pony'], gown: ['long', 'bun', 'long', 'pony', 'curly'],
                           dress: ['long', 'bun', 'short', 'pony', 'curly'] };
  var ACCS_BY_OUTFIT = { suit: ['none', 'none', 'flower', 'hat'], gown: ['none', 'flower', 'flower', 'none'],
                         dress: ['none', 'flower', 'hat', 'none'] };

  /* Clothes a guest can pick on their phone: [base, shade] and a Thai name for
     the swatch's label. Index order is part of the saved data - append only. */
  var CLOTHES = [
    ['#2e2f3a', '#1d1e26', 'ดำ'], ['#2f4468', '#1f2f4a', 'กรมท่า'], ['#6e6e78', '#4f4f58', 'เทา'],
    ['#fbf7f0', '#e2dbcd', 'ขาว'], ['#c9b48f', '#a38e6a', 'ครีม'], ['#6b2f3a', '#4b1f28', 'แดงเลือดหมู'],
    ['#c0392b', '#8e2a1f', 'แดง'], ['#4a5a3e', '#34412b', 'เขียว'], ['#f2b8c6', '#d68ea2', 'ชมพู'],
    ['#c7b6e6', '#a28fc6', 'ม่วง'], ['#b3d3ec', '#89b0d2', 'ฟ้า'], ['#f3dfb0', '#d6bd86', 'เหลือง']
  ];
  var CHOICE_STYLES = { m: ['short', 'curly', 'pony'], f: ['long', 'bun', 'pony', 'curly', 'short'] };
  var CHOICE_ACCS = { m: ['none', 'none', 'flower', 'hat'], f: ['none', 'flower', 'flower', 'none'] };

  // A guest's picks ({g, top, bottom, skin, hair, style, acc}) as a makeSheet()
  // override. Anything missing or out of range falls back to the random look.
  function choiceForce(c) {
    if (!c || (c.g !== 'm' && c.g !== 'f')) return null;
    var f = { outfit: c.g === 'f' ? 'gown' : 'suit' };
    if (CLOTHES[c.top]) f.color = CLOTHES[c.top];
    if (CLOTHES[c.bottom]) f.bottom = CLOTHES[c.bottom];
    if (SKINS[c.skin]) f.skin = c.skin;
    if (HAIRS[c.hair]) f.hair = c.hair;
    if (CHOICE_STYLES[c.g].indexOf(c.style) >= 0) f.style = c.style;
    if (CHOICE_ACCS[c.g].indexOf(c.acc) >= 0) f.acc = c.acc;
    return f;
  }

  // A fresh random face and outfit for the phone's character picker.
  function randomChoice(keep) {
    var r = function (m) { return Math.floor(Math.random() * m); };
    var g = (keep && keep.g) || (r(2) ? 'f' : 'm');
    return {
      g: g,
      top: keep && keep.top != null ? keep.top : r(CLOTHES.length),
      bottom: keep && keep.bottom != null ? keep.bottom : r(CLOTHES.length),
      skin: r(SKINS.length), hair: r(HAIRS.length),
      style: CHOICE_STYLES[g][r(CHOICE_STYLES[g].length)],
      acc: CHOICE_ACCS[g][r(CHOICE_ACCS[g].length)]
    };
  }

  function lookFor(seed) {
    var r = rng(seed);
    var outfit = OUTFITS[r(OUTFITS.length)];
    return {
      outfit: outfit, skin: r(SKINS.length), hair: r(HAIRS.length),
      style: STYLES_BY_OUTFIT[outfit][r(STYLES_BY_OUTFIT[outfit].length)],
      acc: ACCS_BY_OUTFIT[outfit][r(ACCS_BY_OUTFIT[outfit].length)],
      suit: r(SUITS.length), tie: r(TIES.length), gown: r(GOWNS.length), flower: r(FLOWERS.length)
    };
  }

  /* A (W+2)*4 x (H+2) canvas: four walk frames side by side.
     `force` overrides parts of the random look (the couple, and previews). */
  function makeSheet(seed, force, facing) {
    var front = facing === 'front';
    var look = lookFor(seed);
    if (force) for (var key in force) look[key] = force[key];
    // Forcing the outfit (a guest picking ชาย/หญิง) can leave a hair style or
    // accessory from the other outfit's list; swap those for valid ones.
    if (force && force.outfit && STYLES_BY_OUTFIT[look.outfit]) {
      var okStyles = STYLES_BY_OUTFIT[look.outfit], okAccs = ACCS_BY_OUTFIT[look.outfit];
      if (okStyles.indexOf(look.style) < 0) look.style = okStyles[(seed >>> 0) % okStyles.length];
      if (look.acc !== 'veil' && okAccs.indexOf(look.acc) < 0) look.acc = okAccs[(seed >>> 0) % okAccs.length];
    }
    var sk = SKINS[look.skin], hr = HAIRS[look.hair], fl = FLOWERS[look.flower];
    var outfitCol = look.outfit === 'suit' ? SUITS[look.suit] : GOWNS[look.gown];
    if (look.color) outfitCol = look.color;                 // e.g. the bride's white
    var accCol = look.acc === 'hat' ? outfitCol : look.acc === 'veil' ? ['#fbf7f0', '#e6dfd2'] : [fl[0], fl[1]];

    var map = {
      h: hex(hr[0]), k: hex(hr[1]), H: hex(hr[2]), s: hex(sk[0]), S: hex(sk[1]),
      e: hex(EYE), c: hex(BLUSH), t: hex(outfitCol[0]), T: hex(outfitCol[1]),
      w: hex('#f7f3ea'), x: hex(TIES[look.tie]), p: hex(outfitCol[1]), P: darker(hex(outfitCol[1]), 0.7),
      b: hex(SHOE), a: hex(accCol[0]), A: hex(accCol[1]), f: hex(fl[0])
    };
    // Sleeves match the jacket for suits; gowns and dresses have bare arms.
    var armMap = Object.assign({}, map, { q: look.outfit === 'suit' ? map.T : map.s });
    // A chosen bottom colour: trousers (p/P) or the skirt (painted from t/T).
    var skirtMap = map;
    if (look.bottom) {
      map.p = hex(look.bottom[0]); map.P = hex(look.bottom[1]);
      skirtMap = Object.assign({}, map, { t: hex(look.bottom[0]), T: hex(look.bottom[1]) });
    }

    var FW = W + 2, FH = H + 2;
    var cv = document.createElement('canvas');
    cv.width = FW * 4; cv.height = FH;
    var g = cv.getContext('2d');
    var img = g.createImageData(cv.width, cv.height);
    var outline = hex(OUTLINE);

    for (var f = 0; f < 4; f++) {
      var px = new Array(W * H);
      var dy = BOB[f];
      if (front) {
        // Standing: the feet stay put and only the upper body breathes.
        if (look.acc === 'veil') paint(F_ACC.veil, map, px, 0, dy);
        paint(F_HEAD, map, px, 0, dy);
        if (F_HAIR[look.style] && F_HAIR[look.style].length) paint(F_HAIR[look.style], map, px, 0, dy);
        if (look.outfit === 'suit') {
          paint(F_TROUSERS, map, px, 0, 24);
          paint(F_SUIT_TORSO, map, px, 0, 16 + dy);
          paint(F_ARMS_SUIT, armMap, px, 0, 17 + dy);
        } else {
          paint(look.outfit === 'gown' ? F_GOWN_SKIRT : F_SHORT_SKIRT, skirtMap, px, 0, 24);
          paint(F_GOWN_TORSO, map, px, 0, 16 + dy);
          paint(F_ARMS_BARE, armMap, px, 0, 17 + dy);
        }
        if (look.acc !== 'none' && look.acc !== 'veil') paint(F_ACC[look.acc], map, px, 0, dy);
      } else {
        if (look.acc === 'veil') paint(ACC.veil, map, px, 0, dy);   // veil hangs behind the head
        paint(HEAD, map, px, 0, dy);
        if (HAIR[look.style] && HAIR[look.style].length) paint(HAIR[look.style], map, px, 0, dy);

        if (look.outfit === 'suit') {
          paint(SUIT_TORSO, map, px, 0, 16 + dy);
          paint(TROUSERS[f], map, px, 0, 24 + dy);
        } else {
          paint(GOWN_TORSO, map, px, 0, 16 + dy);
          paint((look.outfit === 'gown' ? GOWN_SKIRT : SHORT_SKIRT)[f], skirtMap, px, 0, 24 + dy);
        }
        paint(ARMS[ARM_FOR_FRAME[f]], armMap, px, 3, 17 + dy);
        if (look.acc !== 'none' && look.acc !== 'veil') paint(ACC[look.acc], map, px, 0, dy);
      }

      // Outline: any empty cell touching a filled one (4-way) becomes dark.
      for (var y = -1; y <= H; y++) {
        for (var x = -1; x <= W; x++) {
          var inside = x >= 0 && y >= 0 && x < W && y < H;
          var col = inside ? px[y * W + x] : null;
          if (!col) {
            var touch = false;
            for (var d = 0; d < 4 && !touch; d++) {
              var nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0), ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
              if (nx >= 0 && ny >= 0 && nx < W && ny < H && px[ny * W + nx]) touch = true;
            }
            if (touch) col = outline;
          }
          if (!col) continue;
          var i = ((y + 1) * cv.width + f * FW + x + 1) * 4;
          img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = col[3];
        }
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  /* Small props (the podium's crown and medals) in the same style: a text grid
     plus a map of letter -> '#rrggbb', outlined like the guests. */
  function icon(grid, colours) {
    var gw = 0, gh = grid.length, map = {};
    for (var r = 0; r < gh; r++) gw = Math.max(gw, grid[r].length);
    for (var k in colours) map[k] = hex(colours[k]);
    var cv = document.createElement('canvas');
    cv.width = gw + 2; cv.height = gh + 2;
    var g = cv.getContext('2d');
    var img = g.createImageData(cv.width, cv.height);
    var outline = hex(OUTLINE);
    var at = function (x, y) { return x >= 0 && y >= 0 && y < gh && x < grid[y].length ? map[grid[y][x]] : null; };
    for (var y = -1; y <= gh; y++) {
      for (var x = -1; x <= gw; x++) {
        var col = at(x, y);
        if (!col && (at(x + 1, y) || at(x - 1, y) || at(x, y + 1) || at(x, y - 1))) col = outline;
        if (!col) continue;
        var i = ((y + 1) * cv.width + x + 1) * 4;
        img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  // Shared props for the projector's podium and the guests' phones.
  var CROWN = ['y....y....y', 'yy..yyy..yy', 'yyy.yyy.yyy', 'ywyyyyyyyyy', 'yryyyryyyry', 'yyyyyyyyyyy',
               'YYYYYYYYYYY'];
  var MEDAL = ['RR.....BB', '.RR...BB.', '..RR.BB..', '..mmmmm..', '.mwmmmmm.', '.mwmmmmM.', '.mmmmmmM.',
               '.mmmmmMM.', '..MMMMM..'];
  var HEART = ['.rr...rr.', 'rwrr.rrrr', 'rwrrrrrrr', 'rrrrrrrrR', '.rrrrrrR.', '..rrrrR..', '...rrR...',
               '....R....'];
  var BROKEN = ['.rr...rr.', 'rwrr..rrr', 'rwrr.rrrr', 'rrr.rrrrR', '.rrr.rrR.', '..r.rrR..', '...r.R...',
                '....R....'];
  var BELL = ['.....h.....', '....yyy....', '...ywyyy...', '..yywyyyy..', '..ywyyyyY..', '..yyyyyyY..',
              '.yyyyyyyYY.', 'yyyyyyyyyYY', 'YYYYYYYYYYY', '....YrY....', '.....r.....'];
  var ICONS = {
    bell: { grid: BELL, c: { y: '#f7d154', Y: '#c8912a', w: '#fff6c8', h: '#8a5530', r: '#e0445a' } },
    crown: { grid: CROWN, c: { y: '#f7d154', Y: '#c8912a', w: '#fff6c8', r: '#e0445a' } },
    silver: { grid: MEDAL, c: { R: '#d64a5a', B: '#4b7bb5', m: '#d7dbe6', M: '#9a9fae', w: '#fffaf0' } },
    bronze: { grid: MEDAL, c: { R: '#d64a5a', B: '#4b7bb5', m: '#d58a4f', M: '#9c5a2c', w: '#f6c79a' } },
    heart: { grid: HEART, c: { r: '#e0445a', R: '#a82c40', w: '#ffd6dc' } },
    broken: { grid: BROKEN, c: { r: '#9a7a86', R: '#6e5560', w: '#d8c8ce' } }
  };
  function namedIcon(name) { return icon(ICONS[name].grid, ICONS[name].c); }

  // The same id -> look hash the projector uses, so a guest's phone draws the
  // exact character that walks across the big screen for them.
  function hashId(id) {
    var h = 0;
    id = String(id || '');
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  // The bride (white gown, veil) and groom, as they lead the projector's lobby
  // and greet guests on the phone's join screen.
  var COUPLE = [
    { outfit: 'gown', color: ['#fbf7f0', '#e2dbcd'], style: 'bun', acc: 'veil', hair: 1, skin: 1 },
    { outfit: 'suit', suit: 0, tie: 4, style: 'short', acc: 'none', hair: 1, skin: 1 }
  ];
  function coupleSheets(facing) {
    return COUPLE.map(function (look, i) { return makeSheet(7 + i, look, facing); });
  }

  window.PixelFolk = { CLOTHES: CLOTHES, choiceForce: choiceForce, randomChoice: randomChoice, makeSheet: makeSheet, icon: icon, namedIcon: namedIcon, ICONS: ICONS, hashId: hashId,
                       coupleSheets: coupleSheets, FRAME_W: W + 2, FRAME_H: H + 2 };
})();
