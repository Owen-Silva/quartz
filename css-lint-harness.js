// css-lint-harness.js -- tools/css-lint.js, the check that holds stylesheets to tokens.css's scale.
// Pure node, no browser, well under a second.
//
// Fixture strings for every rule, each with its near misses (what must NOT be a finding is as much the
// contract as what must): raw radii against 0, 50%, var(--radius-*) and calc() over the scale; type
// sizes in px / pt / rem against em, %, keywords and the `font:` shorthand's line-height; the old --fg
// names in stylesheets, inline styles and scripts; comments that hold fake declarations; the allow
// comment with and without its reason, on the line and the line above; the baseline's over / under /
// equal logic; unused --space-N steps against a tiny made-up token set. Last, a real run over this
// repository: nothing may be over tools/css-lint-baseline.json (the harness only READS the baseline;
// `node tools/css-lint.js --write-baseline` is the one thing that writes it).
//
// One summary line: "css-lint: N passed, M failed".
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./tools/css-lint.js');

let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond || detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
}
const css = (t) => L.lintText('t.css', t);
const rules = (vs, r) => vs.filter((v) => v.rule === r);
const one = (t, r) => rules(css(t), r);

try {
  // ---- raw-radius ----
  let v = one('a { border-radius: 3px; }', 'raw-radius');
  check(v.length === 1 && /3px -> nearest var\(--radius-xs\) 4px/.test(v[0].message), 'radius: 3px is a finding naming --radius-xs', v);
  check(one('a{border-radius:6px}', 'raw-radius')[0].message.includes('6px = var(--radius-s)'), 'radius: a value ON the scale names its token', one('a{border-radius:6px}', 'raw-radius'));
  check(/= var\(--radius-pill\)/.test(one('a{border-radius:999px}', 'raw-radius')[0].message), 'radius: 999px = --radius-pill');
  check(/var\(--radius-m\) 10px/.test(one('a{border-top-left-radius: 8px}', 'raw-radius')[0].message), 'radius: longhand counts; 8px sits between 6 and 10, a tie goes UP to --radius-m', one('a{border-top-left-radius: 8px}', 'raw-radius'));
  check(one('a{border-start-end-radius: 2px}', 'raw-radius').length === 1, 'radius: logical longhand counts');
  check(/: \.25rem \(~4px\) = var\(--radius-xs\)/.test(one('a{border-radius: .25rem}', 'raw-radius')[0].message), 'radius: rem converts at 16px and names its token', one('a{border-radius: .25rem}', 'raw-radius'));
  check(one('a{border-radius: 7px 0 0 7px}', 'raw-radius').length === 1 && /7px.*7px/.test(one('a{border-radius: 7px 0 0 7px}', 'raw-radius')[0].message), 'radius: one finding per declaration, every raw value named');
  for (const ok of ['0', '0px', '50%', 'inherit', 'initial', 'unset', 'var(--radius-m)', 'var(--radius-s) var(--radius-s) 0 0', 'var(--radius-m, 10px)', 'calc(var(--radius-s) + 0px)', 'calc(var(--radius-l) - var(--radius-xs))', 'var(--lv-radius)', 'calc(var(--qfav) * 0.2857)']) {
    check(one('a{border-radius: ' + ok + '}', 'raw-radius').length === 0, 'radius near miss passes: ' + ok);
  }
  check(one('a{border-radius: calc(var(--radius-s) + 3px)}', 'raw-radius').length === 1, 'radius: calc() with a raw length beside the token is a finding');
  check(one('a{border-radius: var(--my-radius, 6px)}', 'raw-radius').length === 1, 'radius: a raw fallback inside a NON-radius var is a finding');
  check(one('a{border-radius: 50% / 10px}', 'raw-radius').length === 1, 'radius: the elliptical part after / is checked too');

  // ---- raw-font-size ----
  v = one('a{font-size: 13px}', 'raw-font-size');
  check(v.length === 1 && /13px = var\(--fs-s\)/.test(v[0].message), 'font: 13px names --fs-s', v);
  check(/12\.5px -> nearest var\(--fs-s\) 13px/.test(one('a{font-size:12.5px}', 'raw-font-size')[0].message), 'font: 12.5px -> nearest --fs-s (a tie goes up)');
  check(/1rem \(~16px\) = var\(--fs-l\)/.test(one('a{font-size:1rem}', 'raw-font-size')[0].message), 'font: rem counts and converts');
  check(/10pt \(~13\.33px\) -> nearest var\(--fs-s\)/.test(one('a{font-size:10pt}', 'raw-font-size')[0].message), 'font: pt counts and converts', one('a{font-size:10pt}', 'raw-font-size'));
  v = one('a{font: 600 13px/1.2 var(--font)}', 'raw-font-size');
  check(v.length === 1 && /^font: 13px = var\(--fs-s\)$/.test(v[0].message), 'font shorthand: the size is found', v);
  check(one('a{font: 600 var(--fs-s)/18px var(--font)}', 'raw-font-size').length === 0, 'font shorthand: a px line-height after / is not a size');
  check(one('a{font: 600 var(--fs-l, 17px)/1.3 var(--font-display)}', 'raw-font-size').length === 0, 'font shorthand: a fallback inside var(--fs-*) passes');
  check(one('a{font: 500 var(--fs-s)/1.4 var(--font, "Segoe 14px", sans-serif)}', 'raw-font-size').length === 0, 'font shorthand: a length inside a quoted family name is not a size');
  v = one('a{font: 650 clamp(30px, 3vw, 46px)/1.1 var(--font)}', 'raw-font-size');
  check(v.length === 1 && /30px.*46px/.test(v[0].message), 'font shorthand: clamp() sizes are found, the vw middle is not', v);
  check(one('a{font: 650 var(--ka-fs, 20px)/1.12 var(--font)}', 'raw-font-size').length === 1, 'font: a raw fallback inside a non --fs var is a finding');
  for (const ok of ['font-size: 0.9em', 'font-size: 120%', 'font-size: small', 'font-size: larger', 'font-size: inherit', 'font-size: unset', 'font-size: var(--fs-xs)', 'font: inherit', 'font: caption', 'font-family: x', '--my-font-size: 13px', 'font-weight: 600', 'line-height: 18px']) {
    check(one('a{' + ok + '}', 'raw-font-size').length === 0, 'font near miss passes: ' + ok);
  }

  // ---- comments ----
  v = css('/* border-radius: 3px; font-size: 9px; color: var(--fg); */\na {\n  /* multi\n     line border-radius: 2px */\n  border-radius: 5px;\n}\n');
  check(v.length === 1 && v[0].rule === 'raw-radius' && v[0].line === 5, 'comments: fake declarations inside comments are blanked, line numbers stay right', v);
  check(css('a{content:"/*"; border-radius:3px}').length === 1, 'comments: a "/*" inside a string does not open a comment');

  // ---- legacy-fg ----
  v = rules(css(':root { --fg: #eee; --fg-2: #aaa; }\na { color: var(--fg-3); }\nb { color: var(--fg-hover); }'), 'legacy-fg');
  check(v.length === 4, 'fg: definitions and uses all count', v);
  check(/--fg -> use --text$/.test(v[0].message) && /--fg-2 -> use --text-2$/.test(v[1].message) && /--fg-3 -> use --text-3$/.test(v[2].message), 'fg: each names its --text replacement', v.map((x) => x.message));
  check(/--fg-hover -> use the --text/.test(v[3].message), 'fg: an unknown --fg-* still counts, pointing at the --text family');
  check(v[2].line === 2 && v[3].line === 3, 'fg: line numbers');
  check(rules(css('a{color:var(--text); --fgx: 1; --my-fg: 2; color: var(--text-fg)}'), 'legacy-fg').length === 0, 'fg near misses: --fgx, --my-fg, --text-fg pass');
  v = L.lintText('p.html', '<p>var(--fg) in text</p>\n<div style="color: var(--fg-2)" title="--fg"></div>\n<i style=\'x:1\'></i>');
  check(v.length === 1 && v[0].line === 2 && /inline style/.test(v[0].message), 'fg in .html: only style="" attributes, with the right line', v);
  v = L.lintText('p.js', "const a = '--fg';\nel.style.color = 'var(--fg-3)';\nconst b = 'var(--fgx)';");
  check(v.length === 1 && v[0].line === 2 && /--text-3/.test(v[0].message), 'fg in .js: only var(--fg...) strings', v);
  check(L.lintText('x.txt', 'border-radius: 3px').length === 0, 'other extensions are not linted');

  // ---- allow comments ----
  check(one('a{border-radius:3px} /* css-lint: allow raw-radius sized to the 6px dot */', 'raw-radius').length === 0, 'allow on the same line suppresses');
  check(one('a{\n  /* css-lint: allow raw-radius sized to the dot */\n  border-radius: 3px;\n}', 'raw-radius').length === 0, 'allow on the line directly above suppresses');
  check(one('a{\n  /* css-lint: allow raw-radius sized to the dot */\n\n  border-radius: 3px;\n}', 'raw-radius').length === 1, 'allow two lines above does not');
  check(one('a{border-radius:3px} /* css-lint: allow raw-font-size wrong rule */', 'raw-radius').length === 1, 'allow for another rule does not suppress');
  v = css('a{border-radius:3px} /* css-lint: allow raw-radius */');
  check(rules(v, 'raw-radius').length === 1 && rules(v, 'allow-without-reason').length === 1, 'allow without a reason: suppresses nothing and is itself a finding', v);
  v = css('a{border-radius:3px} /* css-lint: allow raw-raduis typo here */');
  check(rules(v, 'raw-radius').length === 1 && rules(v, 'allow-unknown-rule').length === 1, 'allow naming an unknown rule: suppresses nothing, reported', v);
  check(rules(css('/* css-lint: allow legacy-fg alias kept for an extension */\n:root{ --fg: var(--text); }'), 'legacy-fg').length === 0, 'allow works for legacy-fg too');

  // ---- unused-space ----
  const tok = ':root {\n  --space-1: 4px;\n  --space-2: 8px;\n  --space-10: 40px;\n  --gap: var(--space-10);\n}\n';
  v = L.unusedSpace('tokens.css', tok, { 'a.css': 'a{margin:var(--space-2)}\n/* var(--space-1) */', 'b.js': "x('var(--space-1x)')" });
  check(v.length === 1 && v[0].message.startsWith('--space-1 ') && v[0].line === 2 && v[0].file === 'tokens.css', 'unused-space: only --space-1 (a comment and --space-1x are not uses; tokens.css own var() is)', v);
  v = L.unusedSpace('tokens.css', tok, { 'p.html': '<b style="gap: var(--space-1)">', 'a.css': 'a{margin:var(--space-2)}' });
  check(v.length === 0, 'unused-space: a use in .html counts', v);
  v = L.unusedSpace('tokens.css', tok.replace('  --space-2: 8px;', '  --space-2: 8px; /* css-lint: allow unused-space kept for the next page */'), {});
  check(v.length === 1 && v[0].message.startsWith('--space-1 '), 'unused-space: an allow on the definition suppresses it (--space-2 allowed, --space-1 still reported)', v);
  const sc = L.scaleFromTokens(':root{ --radius-s: 5px; --fs-m: 15px; --radius-pill: 999px; }');
  check(sc.radius['--radius-s'] === 5 && sc.fs['--fs-m'] === 15 && !sc.fs['--fs-s'], 'scaleFromTokens reads the steps from tokens.css', sc);

  // ---- baseline ----
  const counts = { 'a.css': { 'raw-radius': 3, 'legacy-fg': 1 }, 'b.css': { 'raw-font-size': 2 } };
  const base = { files: { 'a.css': { 'raw-radius': { count: 3, why: 'x' }, 'legacy-fg': { count: 0, why: 'x' } }, 'b.css': { 'raw-font-size': { count: 5, why: 'x' } }, 'c.css': { 'raw-radius': { count: 1, why: 'x' } } } };
  let r = L.compare(counts, base, false);
  check(r.over.length === 1 && r.over[0].file === 'a.css' && r.over[0].rule === 'legacy-fg', 'baseline: over fails (a.css legacy-fg 1 > 0); equal (raw-radius 3 = 3) is fine', r);
  check(r.under.length === 2 && r.under.some((u) => u.file === 'b.css') && r.under.some((u) => u.file === 'c.css' && u.count === 0), 'baseline: under is a tighten note (b.css 2 < 5, c.css 0 < 1)', r.under);
  r = L.compare({ 'n.css': { 'raw-radius': 1 } }, base, false);
  check(r.over.length === 1 && r.over[0].baseline === 0, 'baseline: a file it does not list has a baseline of 0');
  r = L.compare(counts, base, true);
  check(r.over.length === 3 && r.under.length === 0, 'strict: every non-zero count is over, the baseline ignored', r);
  check(L.compare(counts, null, false).over.length === 3, 'no baseline file: everything is over');
  const built = L.buildBaseline({ 'newtab.css': { 'raw-radius': 2 }, 'a.css': { 'raw-radius': 1, 'legacy-fg': 4 } }, { files: { 'a.css': { 'raw-radius': { count: 9, why: 'kept why' } } } });
  check(built.files['a.css']['raw-radius'].count === 1 && built.files['a.css']['raw-radius'].why === 'kept why', 'buildBaseline: today\'s count, the old why kept');
  check(/Not this lane's file/.test(built.files['a.css']['legacy-fg'].why) && /drops to 0/.test(built.files['newtab.css']['raw-radius'].why), 'buildBaseline: a new entry gets its default why', built.files);

  // ---- the real repository ----
  const t0 = Date.now();
  const real = L.lintRepo(path.join(__dirname));
  const ms = Date.now() - t0;
  const bl = L.readBaseline();
  check(!!bl && bl.files && Object.keys(bl.files).length > 0, 'tools/css-lint-baseline.json exists and parses');
  check(!!bl && Object.values(bl.files).every((rs) => Object.values(rs).every((e) => Number.isInteger(e.count) && typeof e.why === 'string' && e.why.length > 10)), 'every baseline entry has a count and a why');
  check(real.files.includes('tokens.css') && real.files.includes('newtab.css') && !real.files.some((f) => /-harness\.js$/.test(f)), 'the scan covers the root stylesheets and skips the harnesses', real.files.length);
  r = L.compare(L.countByFile(real.violations), bl, false);
  check(r.over.length === 0, 'the repository: nothing over the baseline (' + real.violations.length + ' findings, ' + r.under.length + ' under)', r.over.map((o) => o.file + ' ' + o.rule + ' ' + o.count + '>' + o.baseline));
  check(ms < 5000, 'the scan is quick (' + ms + ' ms)');
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'tools', 'css-lint.js')], { encoding: 'utf8' });
  const last = (cli.stdout || '').trim().split('\n').pop();
  check(cli.status === 0 && /^css-lint: \d+ files, \d+ violations, 0 over baseline$/.test(last), 'the CLI exits 0 with its summary line', { status: cli.status, last, err: cli.stderr });
} catch (e) {
  check(false, 'HARNESS ERROR ' + (e && e.stack || e));
} finally {
  console.log(`css-lint: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
