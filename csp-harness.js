'use strict';
// csp-harness.js - every bundled page's Content-Security-Policy, checked statically. Pure node,
// no Electron.   node csp-harness.js
//
// Why: the chrome document (index.html) reaches a terminal, the file system and the updater
// through preload, so a script injected into it is code execution on the machine. Each bundled
// page therefore carries a <meta http-equiv="Content-Security-Policy">. A meta policy is easy to
// break without noticing: put it below the first <script> and it governs nothing; add one inline
// handler or one `eval` and that feature dies quietly in the field, with only a console line to
// say why. This harness pins all of that down in seconds:
//   - the meta exists exactly once, inside <head>, above every <script> and stylesheet;
//   - it parses: known directive names, no duplicates, every source a legal CSP token;
//   - it is strict where it must be: default-src 'none', script-src without 'unsafe-inline',
//     'unsafe-eval', a wildcard or a network scheme, object/base/form shut;
//   - the page has nothing the policy would refuse: no inline <script>, no on*= attribute, no
//     javascript: URL, no style= or <style> unless style-src allows inline;
//   - the scripts the page loads exist and call no eval / new Function / string timer;
//   - a page whose policy refuses inline style builds no <style> element and sets no style
//     attribute from its scripts.
// The live half (zero securitypolicyviolation events while the features run) is csp-e2e.js.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300))); }
}

/** Every bundled page, and what is special about it. */
const PAGES = [
  // The chrome: the one page allowed inline STYLE (xterm, <webview>'s shadow root, userstyle.js).
  { file: 'index.html', inlineStyle: true },
  { file: 'newtab.html' },
  { file: 'historypage.html' },
  // Shows another site's article HTML: no file: images, no media, no connections.
  { file: 'reader.html', reader: true },
  { file: 'files.html' },
  { file: 'search.html' },
  { file: 'watch.html' },
  { file: 'welcome.html' },
  { file: 'phone.html' },
  { file: 'score-pin.html' },
];

/* ---- a small CSP parser (CSP3 serialized-policy grammar, the parts a meta policy can use) ---- */

const DIRECTIVES = new Set([
  'default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem',
  'style-src-attr', 'img-src', 'media-src', 'font-src', 'connect-src', 'frame-src', 'child-src',
  'worker-src', 'manifest-src', 'object-src', 'base-uri', 'form-action', 'upgrade-insecure-requests',
  'trusted-types', 'require-trusted-types-for',
]);
// Not allowed in a <meta> policy (the browser ignores them there, so writing one is a mistake).
const META_FORBIDDEN = new Set(['frame-ancestors', 'report-uri', 'report-to', 'sandbox']);
const KEYWORDS = new Set(["'none'", "'self'", "'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'",
  "'unsafe-hashes'", "'report-sample'", "'wasm-unsafe-eval'"]);
// scheme-source ("file:", "https:") or host-source ("ws://127.0.0.1:*", "https://a.example").
const SCHEME_SRC = /^[a-z][a-z0-9+.-]*:$/i;
const HOST_SRC = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\*|\*\.)?[a-z0-9.-]+(?::(?:\d+|\*))?(?:\/[^\s;,]*)?$/i;

/** -> { directives: Map(name -> [sources]), errors: [] } */
function parseCsp(text) {
  const directives = new Map();
  const errors = [];
  for (const raw of String(text).split(';')) {
    const toks = raw.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    const name = toks[0].toLowerCase();
    const srcs = toks.slice(1);
    if (META_FORBIDDEN.has(name)) { errors.push(name + ' is ignored in a <meta> policy'); continue; }
    if (!DIRECTIVES.has(name)) { errors.push('unknown directive ' + name); continue; }
    if (directives.has(name)) { errors.push('duplicate ' + name + ' (the browser ignores the second)'); continue; }
    for (const s of srcs) {
      const legal = KEYWORDS.has(s) || SCHEME_SRC.test(s) || HOST_SRC.test(s) || /^'(?:nonce|sha256|sha384|sha512)-[A-Za-z0-9+/_=-]+'$/.test(s);
      if (!legal) errors.push(name + ': not a CSP source: ' + s);
    }
    if (srcs.includes("'none'") && srcs.length > 1) errors.push(name + ": 'none' must stand alone");
    directives.set(name, srcs);
  }
  return { directives, errors };
}

/** The effective source list for a fetch directive (its own, else default-src). */
function eff(p, name) {
  if (p.directives.has(name)) return p.directives.get(name);
  return p.directives.get('default-src') || null;
}

/* ---- page scanning ---- */

/** Strip <!-- comments --> so commented-out markup and prose never count. */
const noComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

/** JS without comments, roughly (good enough to keep prose out of the eval scan). */
function jsCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}

function check(page) {
  const fp = path.join(ROOT, page.file);
  const tag = page.file + ': ';
  if (!fs.existsSync(fp)) { ok(tag + 'exists', false); return; }
  const html = noComments(fs.readFileSync(fp, 'utf8'));

  // 1. Exactly one meta policy, in <head>, above every script and stylesheet.
  const metaRe = /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content="([^"]*)"\s*\/?>/gi;
  const metas = [...html.matchAll(metaRe)];
  ok(tag + 'has exactly one CSP meta', metas.length === 1, metas.length + ' found');
  if (metas.length !== 1) return;
  const at = metas[0].index;
  const headEnd = html.search(/<\/head>/i);
  ok(tag + 'the CSP meta is inside <head>', headEnd === -1 || at < headEnd);
  const firstScript = html.search(/<script\b/i);
  const firstSheet = html.search(/<link\b[^>]*rel=["']stylesheet["']/i);
  ok(tag + 'the CSP meta is above the first <script>', firstScript === -1 || at < firstScript);
  ok(tag + 'the CSP meta is above the first stylesheet', firstSheet === -1 || at < firstSheet);

  // 2. It parses.
  const p = parseCsp(metas[0][1]);
  ok(tag + 'the policy parses cleanly', p.errors.length === 0, p.errors);

  // 3. Strict where it must be.
  const def = p.directives.get('default-src') || [];
  ok(tag + "default-src 'none'", def.length === 1 && def[0] === "'none'", def);
  const script = eff(p, 'script-src') || [];
  ok(tag + 'script-src names the app files', script.includes('file:') || script.includes("'self'"), script);
  ok(tag + "script-src has no 'unsafe-inline' / 'unsafe-eval' / 'unsafe-hashes'",
    !script.some((s) => s === "'unsafe-inline'" || s === "'unsafe-eval'" || s === "'unsafe-hashes'"), script);
  ok(tag + 'script-src has no wildcard, network scheme, data: or blob:',
    !script.some((s) => s === '*' || /^(https?|wss?|data|blob):/i.test(s) || /^https?:\/\//i.test(s)), script);
  ok(tag + 'no worker-src / child-src beyond none',
    ['worker-src', 'child-src'].every((d) => { const v = eff(p, d); return !v || (v.length === 1 && v[0] === "'none'"); }));
  const obj = eff(p, 'object-src') || [];
  ok(tag + "object-src is 'none'", obj.length === 1 && obj[0] === "'none'", obj);
  ok(tag + "base-uri 'none'", (p.directives.get('base-uri') || []).join(' ') === "'none'");
  ok(tag + "form-action 'none'", (p.directives.get('form-action') || []).join(' ') === "'none'");
  const style = eff(p, 'style-src') || [];
  const inlineStyleAllowed = style.includes("'unsafe-inline'");
  ok(tag + (page.inlineStyle ? "style-src allows inline (documented exception)" : "style-src refuses inline style"),
    inlineStyleAllowed === !!page.inlineStyle, style);

  if (page.reader) {
    const img = eff(p, 'img-src') || [];
    ok(tag + 'reader: images from the web or data: only (no file:, no blob:)',
      !img.includes('file:') && !img.includes('blob:') && !img.includes('*'), img);
    for (const d of ['media-src', 'frame-src', 'connect-src', 'font-src', 'worker-src']) {
      const v = eff(p, d) || [];
      ok(tag + 'reader: ' + d + " is 'none'", v.length === 1 && v[0] === "'none'", v);
    }
  }

  // 4. Nothing in the markup the policy would refuse.
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc=/i.test(m[1]) || m[2].trim() !== '');
  ok(tag + 'no inline <script>', inlineScripts.length === 0, inlineScripts.map((m) => m[0].slice(0, 80)));
  const handlers = html.match(/<[a-z][^>]*\son[a-z]+\s*=/gi) || [];
  ok(tag + 'no on*= handler attributes', handlers.length === 0, handlers.map((h) => h.slice(0, 80)));
  const jsUrls = html.match(/(?:href|src|action)\s*=\s*["']\s*javascript:/gi) || [];
  ok(tag + 'no javascript: URLs', jsUrls.length === 0, jsUrls);
  if (!inlineStyleAllowed) {
    const styleAttrs = html.match(/<[a-z][^>]*\sstyle\s*=/gi) || [];
    ok(tag + 'no style= attributes (style-src refuses them)', styleAttrs.length === 0, styleAttrs.map((s) => s.slice(0, 80)));
    ok(tag + 'no <style> blocks (style-src refuses them)', !/<style\b/i.test(html));
  }

  // 5. The scripts it loads: present, and nothing that needs 'unsafe-eval'.
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((m) => m[1]);
  const missing = srcs.filter((s) => !fs.existsSync(path.join(ROOT, s)));
  ok(tag + 'every script it loads exists (' + srcs.length + ')', missing.length === 0, missing);
  const evalHits = [];
  const styleHits = [];
  for (const s of srcs) {
    if (/^node_modules\//.test(s)) continue; // vendored (xterm): checked live by csp-e2e.js
    const fpj = path.join(ROOT, s);
    if (!fs.existsSync(fpj)) continue;
    const code = jsCode(fs.readFileSync(fpj, 'utf8'));
    const lines = code.split('\n');
    lines.forEach((line, i) => {
      if (/(^|[^.\w$])eval\s*\(|new\s+Function\s*\(|set(?:Timeout|Interval)\s*\(\s*['"`]/.test(line)) evalHits.push(s + ':' + (i + 1));
      if (/createElement\(\s*['"]style['"]\s*\)|setAttribute\(\s*['"]style['"]/.test(line)) styleHits.push(s + ':' + (i + 1));
    });
  }
  ok(tag + 'no eval / new Function / string timer in its scripts', evalHits.length === 0, evalHits);
  if (!inlineStyleAllowed) {
    ok(tag + 'its scripts build no <style> and set no style attribute', styleHits.length === 0, styleHits);
  }
}

/* ---- the parser itself, so a lenient parser cannot pass a broken policy ---- */
(function selfTest() {
  const bad = parseCsp("default-src 'none'; scrpt-src file:; img-src 'none' data:; frame-ancestors 'none'; img-src x");
  ok('parser: catches a misspelt directive', bad.errors.some((e) => /unknown directive scrpt-src/.test(e)));
  ok("parser: catches 'none' with other sources", bad.errors.some((e) => /'none' must stand alone/.test(e)));
  ok('parser: catches a meta-only-ignored directive', bad.errors.some((e) => /frame-ancestors/.test(e)));
  ok('parser: catches a duplicate directive', bad.errors.some((e) => /duplicate img-src/.test(e)));
  const good = parseCsp("default-src 'none'; connect-src ws://127.0.0.1:* file:; frame-src https://www.youtube-nocookie.com");
  ok('parser: accepts host sources with a port wildcard', good.errors.length === 0, good.errors);
  ok('parser: rejects a quoted typo', parseCsp("script-src 'self' 'unsafe-evil'").errors.length === 1);
})();

for (const page of PAGES) check(page);

// 6. No bundled page is missing from the list above (a new page must come with a policy).
const bundled = fs.readdirSync(ROOT).filter((f) => /\.html$/i.test(f));
const listed = new Set(PAGES.map((p) => p.file));
const unlisted = bundled.filter((f) => !listed.has(f));
ok('every bundled .html page is covered by this harness', unlisted.length === 0, unlisted);

console.log(`csp-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
