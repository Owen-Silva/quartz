// tools/css-lint.js -- keeps Quartz's look on its tokens when anyone (a person or a coding agent)
// edits CSS. Pure node, no dependencies, no browser: reads the page-root stylesheets as text and
// finishes in about a second.
//
//   node tools/css-lint.js [file ...] [--json] [--strict] [--write-baseline]
//
// Why it exists. tokens.css already holds a full scale (radius xs..pill, six text sizes, space 1..6,
// the --text family), but nothing held anyone to it: a stylesheet could drift to `border-radius: 3px`,
// `font-size: 12.5px` or the old `--fg` names and every test still passed, because no test looks at
// what a value IS, only at what the page does. This script is that missing check. It does not judge
// taste; it only asks "did this value come from the scale?".
//
// The rules (each finding prints as `file:line rule message`):
//   raw-radius      border-radius or one of its longhands (border-top-left-radius ...) with a px / rem /
//                   em / pt length that is not inside var(--radius-*). Allowed: 0 (any zero length, so
//                   `calc(var(--radius-s) + 0px)` passes), percentages (50%), inherit / initial / unset,
//                   var(--radius-*) (several, or mixed with 0, or with a fallback inside the var), and a
//                   calc() whose only lengths are var(--radius-*). A fallback inside ANOTHER variable
//                   (`var(--my-radius, 6px)`) is still a raw value and counts. The message names the
//                   token the value equals or, failing that, the nearest one (a tie goes UP, as the
//                   type scale's own rule does).
//   raw-font-size   font-size, and the size inside the `font:` shorthand (the token before the `/`
//                   line-height, which is not checked), with a px / pt / rem literal not via var(--fs-*).
//                   Allowed: var(--fs-*), inherit / initial / unset, the keywords, and em and % (they are
//                   relative to the parent, not an escape from the scale). The message names the equal
//                   or nearest --fs-* step.
//   legacy-fg       the old --fg custom property names (`--fg`, `--fg-2`, `--fg-3`, any `--fg-*`), both
//                   definitions and var() uses, in every stylesheet; plus `style="..."` attributes in the
//                   root .html pages and `var(--fg...` strings in the root .js files. The message names
//                   the --text name that replaces it.
//   unused-space    a --space-N step defined in tokens.css that nothing uses: zero `var(--space-N)` across
//                   the root .css, .html and .js. Reported against tokens.css at the definition's line.
//                   An unused step is either dead or a sign that pages are spacing by hand instead.
//
// Scope: every *.css in the repository root (so not node_modules, docs/, assets/ or tests/), the root
// *.html and *.js for the two scans above. The *-harness.js files are skipped: they are tests whose
// fixtures hold bad values on purpose. /* comments */ are blanked before any declaration is matched
// (a commented-out `border-radius: 3px` is not a finding), keeping every line number where it was.
//
// A deliberate exception: a comment on the same line as the finding or on the line directly above it,
//   /* css-lint: allow <rule> <reason> */          e.g.  /* css-lint: allow raw-font-size icon glyph sized to its 28px button */
// The reason is required. An allow without one suppresses nothing and is itself a finding
// (`allow-without-reason`); one naming a rule this script does not have is `allow-unknown-rule`.
//
// The baseline (tools/css-lint-baseline.json). Some stylesheets drift today and are not every
// change's to fix, so the baseline records, per file per rule, today's count and WHY it is allowed to
// be non-zero. A file/rule OVER its baseline fails (exit 1): that is new drift. UNDER it passes with a
// "tighten the baseline" note, so the number only ever goes down. `--strict` ignores the baseline (any
// finding fails). `--write-baseline` rewrites the file from the current counts, keeping each existing
// `why`; nothing else ever writes it, the unit suite (css-lint-harness.js) only reads it.
//
// Output: a per-file table of counts per rule, every finding in an over-baseline file/rule as
// file:line, then one summary line:  css-lint: N files, V violations, O over baseline
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'css-lint-baseline.json');
const RULES = ['raw-radius', 'raw-font-size', 'legacy-fg', 'unused-space', 'allow-without-reason', 'allow-unknown-rule'];

// The scale as tokens.css has it today. The CLI re-reads it from tokens.css (scaleFromTokens) so a
// changed step follows on its own; these are only the default for the pure functions.
const DEFAULT_SCALE = {
  radius: { '--radius-xs': 4, '--radius-s': 6, '--radius-m': 10, '--radius-l': 14, '--radius-xl': 18, '--radius-pill': 999 },
  fs: { '--fs-2xs': 11, '--fs-xs': 12, '--fs-s': 13, '--fs-m': 14, '--fs-l': 16, '--fs-xl': 20 },
};
const FG_REPLACE = { '--fg': '--text', '--fg-2': '--text-2', '--fg-3': '--text-3' };

// ---- text helpers -----------------------------------------------------------------------------------

// Blank every /* comment */ to spaces (newlines kept, so offsets and line numbers do not move).
// String-aware: a "/*" inside a quoted string is not a comment.
function stripComments(text) {
  const out = text.split('');
  let i = 0, q = null;
  while (i < text.length) {
    const c = text[i];
    if (q) { if (c === '\\') i += 2; else { if (c === q) q = null; i++; } continue; }
    if (c === '"' || c === "'") { q = c; i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (let k = i; k < stop; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
      i = stop; continue;
    }
    i++;
  }
  return out.join('');
}

// offset -> 1-based line number, via a table of line starts.
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (off) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; };
}

// Remove every var(<name matching re>, ...) call, nested parentheses included (a fallback such as
// var(--radius-m, calc(...)) goes with it). Other var() calls stay, fallback and all.
function stripVars(value, nameRe) {
  let out = '', i = 0;
  while (i < value.length) {
    const m = /var\(\s*(--[\w-]+)/y; m.lastIndex = i;
    const hit = value.startsWith('var(', i) ? m.exec(value) : null;
    if (hit && nameRe.test(hit[1])) {
      let depth = 0, k = i + 3;
      for (; k < value.length; k++) { if (value[k] === '(') depth++; else if (value[k] === ')') { depth--; if (depth === 0) break; } }
      out += ' '; i = k + 1; continue;
    }
    out += value[i++];
  }
  return out;
}

function lengths(value, units) {
  const re = new RegExp('(?<![\\w.#-])(\\d*\\.?\\d+)(' + units + ')(?![\\w-])', 'gi');
  const found = [];
  let m;
  while ((m = re.exec(value))) if (Number(m[1]) !== 0) found.push({ text: m[0], n: Number(m[1]), unit: m[2].toLowerCase() });
  return found;
}

const toPx = (l) => (l.unit === 'px' ? l.n : l.unit === 'pt' ? l.n * 4 / 3 : l.n * 16);   // rem/em at the 16px root
const fmt = (n) => String(Math.round(n * 100) / 100);

// The token a px value equals, else the nearest (a tie goes up).
function nearest(px, scale) {
  let best = null;
  for (const [name, v] of Object.entries(scale)) {
    const d = Math.abs(v - px);
    if (!best || d < best.d || (d === best.d && v > best.v)) best = { name, v, d };
  }
  return best;
}
function suggest(l, scale) {
  const px = toPx(l), t = nearest(px, scale);
  if (!t) return l.text;
  const approx = l.unit === 'px' ? '' : ' (~' + fmt(px) + 'px)';
  return t.d < 0.01 ? l.text + approx + ' = var(' + t.name + ')' : l.text + approx + ' -> nearest var(' + t.name + ') ' + t.v + 'px';
}

// Every `prop: value` declaration in comment-stripped CSS whose property matches propRe.
function declarations(clean, propRe) {
  const re = new RegExp('(^|[;{\\s])(' + propRe + ')\\s*:\\s*([^;{}]*)', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(clean))) out.push({ prop: m[2].toLowerCase(), value: m[3].trim(), at: m.index + m[1].length });
  return out;
}

// ---- allows -----------------------------------------------------------------------------------------

const ALLOW_RE = /\/\*\s*css-lint:\s*allow\b([^*]*(?:\*(?!\/)[^*]*)*)\*\//g;
function parseAllows(text) {
  const line = lineIndex(text);
  const allows = [], problems = [];
  let m;
  ALLOW_RE.lastIndex = 0;
  while ((m = ALLOW_RE.exec(text))) {
    const body = m[1].trim(), ln = line(m.index);
    const sp = body.search(/\s/);
    const rule = sp < 0 ? body : body.slice(0, sp), reason = sp < 0 ? '' : body.slice(sp).trim();
    if (!RULES.includes(rule)) { problems.push({ line: ln, rule: 'allow-unknown-rule', message: 'css-lint allow names "' + (rule || '(nothing)') + '", not one of ' + RULES.slice(0, 4).join(', ') + '; it suppresses nothing' }); continue; }
    if (!reason) { problems.push({ line: ln, rule: 'allow-without-reason', message: 'css-lint allow ' + rule + ' gives no reason; it suppresses nothing until it says why' }); continue; }
    allows.push({ line: ln, rule, reason });
  }
  return { allows, problems };
}
// Drop findings an allow covers (same line or the line directly above), add the bad-allow findings.
function applyAllows(text, found) {
  const { allows, problems } = parseAllows(text);
  const kept = found.filter((v) => !allows.some((a) => a.rule === v.rule && (a.line === v.line || a.line === v.line - 1)));
  return kept.concat(problems).sort((a, b) => a.line - b.line);
}

// ---- the rules --------------------------------------------------------------------------------------

const FG_RE = /(?<![\w-])--fg(?:-[\w-]+)?(?![\w-])/g;
function fgMessage(name) {
  const to = FG_REPLACE[name];
  return to ? 'legacy ' + name + ' -> use ' + to : 'legacy ' + name + ' -> use the --text / --text-2 / --text-3 step it stands for';
}

function lintCss(text, scale) {
  scale = scale || DEFAULT_SCALE;
  const clean = stripComments(text), line = lineIndex(text), found = [];
  for (const d of declarations(clean, 'border(?:-(?:top|bottom)-(?:left|right)|-(?:start|end)-(?:start|end))?-radius')) {
    const raw = lengths(stripVars(d.value, /^--radius-/), 'px|rem|em|pt');
    if (raw.length) found.push({ line: line(d.at), rule: 'raw-radius', message: d.prop + ': ' + raw.map((l) => suggest(l, scale.radius)).join(', ') });
  }
  for (const d of declarations(clean, 'font-size|font')) {
    let v = d.value.replace(/"[^"]*"|'[^']*'/g, ' ');
    v = stripVars(v, /^--fs-/);
    // the shorthand's line-height (after the "/") is not a size: drop it, a function call whole
    if (d.prop === 'font') v = v.replace(/\/\s*(?:[\w-]+\((?:[^()]|\([^()]*\))*\)|[^\s,]+)/g, ' ');
    const raw = lengths(v, 'px|rem|pt');
    if (raw.length) found.push({ line: line(d.at), rule: 'raw-font-size', message: d.prop + ': ' + raw.map((l) => suggest(l, scale.fs)).join(', ') });
  }
  let m;
  FG_RE.lastIndex = 0;
  while ((m = FG_RE.exec(clean))) found.push({ line: line(m.index), rule: 'legacy-fg', message: fgMessage(m[0]) });
  return found;
}

// .html: only inline style="..." attributes; .js: only var(--fg...) strings.
function lintHtml(text) {
  const line = lineIndex(text), found = [];
  const attr = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let a;
  while ((a = attr.exec(text))) {
    const body = a[2] != null ? a[2] : a[3], base = a.index + a[0].indexOf(a[1]) + 1;
    let m;
    FG_RE.lastIndex = 0;
    while ((m = FG_RE.exec(body))) found.push({ line: line(base + m.index), rule: 'legacy-fg', message: fgMessage(m[0]) + ' (inline style)' });
  }
  return found;
}
function lintJs(text) {
  const line = lineIndex(text), found = [];
  const re = /var\(\s*(--fg(?:-[\w-]+)?)(?![\w-])/g;
  let m;
  while ((m = re.exec(text))) found.push({ line: line(m.index), rule: 'legacy-fg', message: fgMessage(m[1]) + ' (in a script)' });
  return found;
}

// One file's findings (allows applied). `name` decides the kind by its extension.
function lintText(name, text, scale) {
  const ext = path.extname(name).toLowerCase();
  const found = ext === '.css' ? lintCss(text, scale) : ext === '.html' ? lintHtml(text) : ext === '.js' ? lintJs(text) : [];
  return applyAllows(text, found).map((v) => Object.assign({ file: name }, v));
}

// --space-N steps tokens.css defines that no file uses. `others` is { name: text } for every scanned
// file (tokens.css may be among them: its own var() uses count, its definitions do not).
function unusedSpace(tokensName, tokensText, others) {
  const clean = stripComments(tokensText), line = lineIndex(tokensText);
  const defs = [];
  const re = /(?<![\w-])(--space-(\d+))\s*:/g;
  let m;
  while ((m = re.exec(clean))) defs.push({ name: m[1], line: line(m.index) });
  const used = new Set();
  const all = Object.assign({}, others, { [tokensName]: tokensText });
  for (const [n, t] of Object.entries(all)) {
    const body = n.toLowerCase().endsWith('.css') ? stripComments(t) : t;
    const u = /var\(\s*(--space-\d+)(?![\w-])/g;
    let k;
    while ((k = u.exec(body))) used.add(k[1]);
  }
  const found = defs.filter((d) => !used.has(d.name)).map((d) => ({ line: d.line, rule: 'unused-space', message: d.name + ' is defined but nothing uses var(' + d.name + '): use it where pages space by hand, or drop the step' }));
  return applyAllows(tokensText, found).map((v) => Object.assign({ file: tokensName }, v));
}

// Read the radius and type steps from tokens.css; fall back to the defaults for any that are missing.
function scaleFromTokens(text) {
  const clean = stripComments(text), scale = { radius: {}, fs: {} };
  const re = /(?<![\w-])(--(radius|fs)-[\w-]+)\s*:\s*(\d*\.?\d+)px\s*;/g;
  let m;
  while ((m = re.exec(clean))) scale[m[2]][m[1]] = Number(m[3]);
  if (!Object.keys(scale.radius).length) scale.radius = DEFAULT_SCALE.radius;
  if (!Object.keys(scale.fs).length) scale.fs = DEFAULT_SCALE.fs;
  return scale;
}

// ---- counting and the baseline ----------------------------------------------------------------------

function countByFile(violations) {
  const c = {};
  for (const v of violations) { c[v.file] = c[v.file] || {}; c[v.file][v.rule] = (c[v.file][v.rule] || 0) + 1; }
  return c;
}
// Compare counts with a baseline ({ files: { name: { rule: { count, why } } } }). Returns the
// file/rule pairs over it (fail) and under it (tighten). strict = every non-zero count is over.
function compare(counts, baseline, strict) {
  const base = (baseline && baseline.files) || {};
  const over = [], under = [];
  const files = new Set(Object.keys(counts).concat(strict ? [] : Object.keys(base)));
  for (const f of files) {
    const rules = new Set(Object.keys(counts[f] || {}).concat(strict ? [] : Object.keys(base[f] || {})));
    for (const r of rules) {
      const have = (counts[f] && counts[f][r]) || 0;
      const allowed = strict ? 0 : ((base[f] && base[f][r] && base[f][r].count) || 0);
      if (have > allowed) over.push({ file: f, rule: r, count: have, baseline: allowed });
      else if (have < allowed) under.push({ file: f, rule: r, count: have, baseline: allowed });
    }
  }
  return { over, under };
}

const WHY_OTHER = 'Not this lane\'s file (other round-2 lanes edit it); baseline so only NEW drift fails. Clear it when the file is next restyled.';
const WHY_FIXING = 'zl-design is fixing these this round; baseline drops to 0 when it lands';
function buildBaseline(counts, previous) {
  const prev = (previous && previous.files) || {}, files = {};
  for (const f of Object.keys(counts).sort()) {
    for (const r of Object.keys(counts[f]).sort()) {
      const keep = prev[f] && prev[f][r] && prev[f][r].why;
      files[f] = files[f] || {};
      files[f][r] = { count: counts[f][r], why: keep || (f === 'newtab.css' || f === 'tokens.css' ? WHY_FIXING : WHY_OTHER) };
    }
  }
  return {
    about: 'css-lint baseline: per file per rule, the finding count that is tolerated today and why. Over it fails; under it asks for the count to come down. Regenerate with node tools/css-lint.js --write-baseline (keeps each why).',
    files,
  };
}

// ---- the repository scan ----------------------------------------------------------------------------

function rootFiles(root, ext) {
  return fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith(ext) && !/-harness\.js$/i.test(f) && fs.statSync(path.join(root, f)).isFile()).sort();
}
// Lint the repository (or just `only`, a list of root file names). Returns { files, violations }.
function lintRepo(root, only) {
  root = root || ROOT;
  const texts = {};
  for (const f of rootFiles(root, '.css').concat(rootFiles(root, '.html'), rootFiles(root, '.js'))) texts[f] = fs.readFileSync(path.join(root, f), 'utf8');
  const scale = texts['tokens.css'] ? scaleFromTokens(texts['tokens.css']) : DEFAULT_SCALE;
  const targets = only && only.length ? only : Object.keys(texts);
  let violations = [];
  for (const f of targets) {
    const text = texts[f] != null ? texts[f] : fs.readFileSync(path.join(root, f), 'utf8');
    violations = violations.concat(lintText(f, text, scale));
  }
  if (texts['tokens.css'] && targets.includes('tokens.css')) {
    const others = Object.assign({}, texts); delete others['tokens.css'];
    violations = violations.concat(unusedSpace('tokens.css', texts['tokens.css'], others));
  }
  return { files: targets, violations };
}

function readBaseline(file) {
  try { return JSON.parse(fs.readFileSync(file || BASELINE, 'utf8')); } catch (e) { return null; }
}

// ---- CLI --------------------------------------------------------------------------------------------

const SHORT = { 'raw-radius': 'radius', 'raw-font-size': 'font', 'legacy-fg': 'fg', 'unused-space': 'space', 'allow-without-reason': 'allow', 'allow-unknown-rule': 'allow?' };

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const only = argv.filter((a) => !a.startsWith('--')).map((a) => path.relative(ROOT, path.resolve(a)).replace(/\\/g, '/'));
  const bad = only.find((f) => f.includes('/') || f.startsWith('..'));
  if (bad) { console.error('css-lint: ' + bad + ' is not a file in the repository root (the scan covers root stylesheets, pages and scripts only)'); return 2; }
  const { files, violations } = lintRepo(ROOT, only);
  const counts = countByFile(violations);

  if (flags.has('--write-baseline')) {
    if (only.length) { console.error('css-lint: --write-baseline needs the whole repository; drop the file arguments'); return 2; }
    fs.writeFileSync(BASELINE, JSON.stringify(buildBaseline(counts, readBaseline()), null, 2) + '\n');
    console.log('css-lint: baseline written to tools/css-lint-baseline.json (' + violations.length + ' findings in ' + Object.keys(counts).length + ' files)');
    return 0;
  }

  const strict = flags.has('--strict');
  const baseline = strict ? null : readBaseline();
  if (!strict && !baseline) console.log('css-lint: no baseline file (tools/css-lint-baseline.json); every finding counts as over it');
  // With file arguments, only those files' baseline entries are compared.
  let { over, under } = compare(counts, baseline, strict);
  if (only.length) { over = over.filter((o) => only.includes(o.file)); under = under.filter((u) => only.includes(u.file)); }
  const overSet = new Set(over.map((o) => o.file + '\0' + o.rule));
  const overLines = violations.filter((v) => overSet.has(v.file + '\0' + v.rule));
  const summary = 'css-lint: ' + files.length + ' files, ' + violations.length + ' violations, ' + over.length + ' over baseline';

  if (flags.has('--json')) {
    console.log(JSON.stringify({ files: files.length, counts, violations, over, under, strict, summary }, null, 2));
    return over.length ? 1 : 0;
  }
  const rules = RULES.filter((r) => violations.some((v) => v.rule === r));
  if (rules.length) {
    const w = Math.max(4, ...Object.keys(counts).map((f) => f.length));
    console.log('file'.padEnd(w) + '  ' + rules.map((r) => SHORT[r].padStart(6)).join(' '));
    for (const f of Object.keys(counts).sort()) console.log(f.padEnd(w) + '  ' + rules.map((r) => String(counts[f][r] || '').padStart(6)).join(' '));
  }
  if (over.length) {
    console.log('');
    for (const o of over) console.log('OVER ' + o.file + ' ' + o.rule + ': ' + o.count + ' (baseline ' + o.baseline + ')');
    for (const v of overLines) console.log(v.file + ':' + v.line + ' ' + v.rule + ' ' + v.message);
  }
  for (const u of under) console.log('note: ' + u.file + ' ' + u.rule + ' is ' + u.count + ', under its baseline of ' + u.baseline + ': tighten the baseline (node tools/css-lint.js --write-baseline)');
  console.log(summary);
  return over.length ? 1 : 0;
}

module.exports = {
  RULES, DEFAULT_SCALE, stripComments, stripVars, lintCss, lintHtml, lintJs, lintText, unusedSpace,
  scaleFromTokens, parseAllows, nearest, countByFile, compare, buildBaseline, lintRepo, readBaseline, BASELINE,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
