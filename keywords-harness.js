// keywords-harness.js — pure-node test for keywords.js (run: node keywords-harness.js).
// Loads it in a vm sandbox with a fake window (and an optional fake Settings store).
const fs = require('fs');
const vm = require('vm');
const path = process.argv[2] || require('path').join(__dirname, 'keywords.js');
const src = fs.readFileSync(path, 'utf8');

function load(storedKeywords) {
  const win = {};
  if (storedKeywords !== undefined) {
    win.Settings = { get: (k) => (k === 'keywords' ? storedKeywords : undefined) };
  }
  const ctx = vm.createContext({ window: win, URL, encodeURIComponent });
  vm.runInContext(src, ctx);
  return win.Keywords;
}

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}

// Defaults, no Settings at all
let K = load();
eq('gh helm', K.match('gh helm'), { key: 'gh', name: 'GitHub', query: 'helm', url: 'https://github.com/search?q=helm' });
eq('case-insensitive key', K.match('GH helm').url, 'https://github.com/search?q=helm');
eq('multi-word query encoded', K.match('yt lofi hip hop').url, 'https://www.youtube.com/results?search_query=lofi%20hip%20hop');
eq('special chars encoded', K.match('g a&b=c').url, 'https://www.google.com/search?q=a%26b%3Dc');
eq('upper rh', K.match('rh nvda'), { key: 'rh', name: 'Robinhood', query: 'NVDA', url: 'https://robinhood.com/stocks/NVDA' });
eq('surrounding whitespace', K.match('  ddg   foo  ').url, 'https://duckduckgo.com/?q=foo');
eq('keyword alone', K.match('yt'), null);
eq('keyword + spaces only', K.match('yt   '), null);
eq('unknown key', K.match('zz helm'), null);
eq('plain search', K.match('how to tie a tie'), null);
eq('url not shadowed', K.match('https://github.com'), null);
eq('domain not shadowed', K.match('gh.com'), null);
eq('localhost not shadowed', K.match('localhost:3000'), null);
eq('dotted token not shadowed', K.match('w.org foo'), null);
eq('empty', K.match(''), null);
eq('null', K.match(null), null);
eq('defaults all ok', K.list().every((r) => r.ok), true);
eq('defaults count', K.list().length, 11);

// Settings store present but never touched (null) -> defaults
K = load(null);
eq('null store -> defaults', K.match('w rust').url, 'https://en.wikipedia.org/wiki/Special:Search?search=rust');

// User list with bad rows
const user = [
  { key: 'gh', name: 'GitHub', url: 'https://github.com/search?q=%s' },
  { key: 'bad1', name: 'NoS', url: 'https://example.com/search' },          // no %s
  { key: 'bad2', name: 'Ftp', url: 'ftp://example.com/%s' },               // not http(s)
  { key: 'GH', name: 'Dup', url: 'https://dup.example/%s' },               // duplicate
  { key: 'two words', name: 'Sp', url: 'https://x.example/%s' },           // space
  { key: 'how', name: 'Common', url: 'https://x.example/%s' },             // common word
  { key: 'a.b', name: 'Dot', url: 'https://x.example/%s' },                // address-ish
  { key: 'many', name: '', url: 'https://many.example/?a=%s&b=%s' }        // two %s, no name
];
K = load(user);
const verdicts = K.list().map((r) => r.ok);
eq('verdicts', verdicts, [true, false, false, false, false, false, false, true]);
eq('no %s reason', K.list()[1].reason, 'The address needs %s where the search goes.');
eq('ftp reason', K.list()[2].reason, 'The address must start with http:// or https://.');
eq('dup reason mentions above', /already used/.test(K.list()[3].reason), true);
eq('bad template never matches', K.match('bad1 foo'), null);
eq('ftp never matches', K.match('bad2 foo'), null);
eq('dup keeps the first', K.match('gh x').url, 'https://github.com/search?q=x');
eq('common word not a key', K.match('how to'), null);
eq('every %s replaced, name falls back to host', K.match('many q'), { key: 'many', name: 'many.example', query: 'q', url: 'https://many.example/?a=q&b=q' });
eq('defaults gone when user list set', K.match('yt x'), null);

// Settings that throws -> defaults, never throws
const win = { Settings: { get() { throw new Error('boom'); } } };
const ctx = vm.createContext({ window: win, URL, encodeURIComponent });
vm.runInContext(src, ctx);
eq('throwing settings -> defaults', win.Keywords.match('gh a').url, 'https://github.com/search?q=a');

console.log(`keywords-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
