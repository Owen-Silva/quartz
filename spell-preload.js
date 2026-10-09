'use strict';

/*
 * Autocorrect -- the TYPING half. Registered by spell.js as a session preload
 * (type 'frame'), so it runs in every frame of every tab AND in the chrome's
 * own document, always in Electron's isolated world: the page shares the DOM
 * with us but never sees this code, its config or its ipcRenderer.
 *
 * What it does, like a phone keyboard:
 *   - When a word is FINISHED (Space, or Enter where Enter makes a new line),
 *     a confidently misspelled word is replaced: "teh " -> "the ".
 *   - Backspace straight after puts back what was typed (and drops the space,
 *     which is what the Backspace was for); Ctrl+Z straight after puts back
 *     what was typed and keeps the space. Either way that word is then left
 *     alone in that field for as long as the page lives.
 *   - Everything it is not sure about is left to Chromium's own red underline
 *     and the right-click suggestions main.js adds to the page menu.
 *
 * Who decides "misspelled": the Windows spellchecker -- the same engine that
 * draws the underline -- asked through main ('spell:check', see spell.js for
 * why a page-side check cannot work on Windows). The answer takes a few
 * milliseconds, so a word is usually fixed just AFTER its space lands, in the
 * gap before the next key; a word seen before is answered from a cache and
 * fixed before the space. Either way the fix only lands if the word is still
 * exactly where it was and the caret has not wandered off.
 *
 * The confidence rule (a wrong fix is worse than none):
 *   Windows says the word is misspelled, AND one of
 *     (a) the word is in TYPOS below,
 *     (b) Windows itself marks it for automatic replacement (its own
 *         autocorrect list), or
 *     (c) it is 4+ letters, Windows' top suggestion is ONE edit or
 *         transposition away, is an ordinary lowercase word (not a name), and
 *         no other suggestion is that close.
 *   Casing is kept (Teh -> The). Anything else is only underlined.
 *
 * Never touched: password / one-time-code / username fields, email / url /
 * tel / number inputs, spellcheck=false fields (the chrome's URL, code and key
 * fields -- except a field that opts in with data-autocorrect="search", the
 * address bar), code editors and code/pre text, the Claude terminal (xterm),
 * and any word with digits, ALLCAPS, camelCase, snake_case, kebab-case, @, #,
 * :emoji:, a dot or a slash (URLs, hosts, paths, emails), a personal
 * dictionary word, a word "Ignore"d from the menu, slang (lol, gonna...), and
 * a Capitalised word mid-sentence (most likely a name).
 *
 * How it writes: document.execCommand('insertText') over a selected word. That
 * is the same path typing takes, so React / Gmail / Discord editors see a real
 * beforeinput + input, and the browser's own undo stack keeps working. It
 * never sets .value.
 *
 * Cost: one keydown listener; every key that is not Space / Enter / Backspace
 * / Ctrl+Z returns after a property check. Nothing runs when nobody types, and
 * the config is only fetched the first time an editable field takes focus.
 */

const { ipcRenderer, webFrame } = require('electron');

(function quartzSpell() {
  // One engine per world; a document.open() or a re-run preload must not stack.
  if (window.__quartzSpell) return;

  // ---------------------------------------------------------------------------
  // Common typos -> the fix. Hand-written for Quartz from everyday English (no
  // list was copied), so it carries no licence of its own beyond this repo's.
  // Only NON-words go in here: a key that is also a real word ("wont", "cant",
  // "ill", "its", "were", "lets") would rewrite correct text, so none are.
  // Every entry still has to be flagged by the spellchecker before it fires.
  // ---------------------------------------------------------------------------
  const TYPOS = {
    teh: 'the', hte: 'the', taht: 'that', thta: 'that', adn: 'and', nad: 'and',
    jsut: 'just', juts: 'just', waht: 'what', wnat: 'want', wich: 'which',
    whcih: 'which', wiht: 'with', iwth: 'with', becuase: 'because',
    becasue: 'because', beacuse: 'because', recieve: 'receive',
    recieved: 'received', reciept: 'receipt', beleive: 'believe',
    beleived: 'believed', freind: 'friend', freinds: 'friends', thier: 'their',
    theyre: "they're", youre: "you're", dont: "don't", doesnt: "doesn't",
    didnt: "didn't", isnt: "isn't", wasnt: "wasn't", arent: "aren't",
    werent: "weren't", havent: "haven't", hasnt: "hasn't", hadnt: "hadn't",
    couldnt: "couldn't", wouldnt: "wouldn't", shouldnt: "shouldn't",
    mustnt: "mustn't", wouldve: "would've", couldve: "could've",
    shouldve: "should've", im: "I'm", ive: "I've", youve: "you've",
    theyve: "they've", weve: "we've", thats: "that's", whats: "what's",
    theres: "there's", heres: "here's", doesnt_: "doesn't",
    alot: 'a lot', definately: 'definitely', definatly: 'definitely',
    defintely: 'definitely', seperate: 'separate', seperately: 'separately',
    occured: 'occurred', occurence: 'occurrence', untill: 'until',
    tommorow: 'tomorrow', tomorow: 'tomorrow', tommorrow: 'tomorrow',
    wierd: 'weird', truely: 'truly', goverment: 'government',
    enviroment: 'environment', existance: 'existence', independant: 'independent',
    neccessary: 'necessary', necesary: 'necessary', noticable: 'noticeable',
    occassion: 'occasion', persistant: 'persistent', posession: 'possession',
    prefered: 'preferred', publically: 'publicly', realy: 'really',
    reccomend: 'recommend', recomend: 'recommend', refered: 'referred',
    relevent: 'relevant', religous: 'religious', remeber: 'remember',
    rember: 'remember', responsability: 'responsibility', succesful: 'successful',
    sucessful: 'successful', suprise: 'surprise', suprised: 'surprised',
    tounge: 'tongue', wether: 'whether', whereever: 'wherever', wrtie: 'write',
    writting: 'writing', yeild: 'yield', acheive: 'achieve', accross: 'across',
    adress: 'address', agressive: 'aggressive', apparantly: 'apparently',
    arguement: 'argument', basicly: 'basically', begining: 'beginning',
    buisness: 'business', catagory: 'category',
    cemetary: 'cemetery', comming: 'coming', commited: 'committed',
    completly: 'completely', concious: 'conscious', curiousity: 'curiosity',
    dissapear: 'disappear', dissapoint: 'disappoint', embarass: 'embarrass',
    finaly: 'finally', foriegn: 'foreign', fourty: 'forty', gaurd: 'guard',
    happend: 'happened', harrass: 'harass', immediatly: 'immediately',
    knowlege: 'knowledge', liason: 'liaison', libary: 'library',
    lisence: 'license', maintainance: 'maintenance', mispell: 'misspell',
    neice: 'niece', parliment: 'parliament', peice: 'piece', perhpas: 'perhaps',
    probaly: 'probably', promiss: 'promise',
    questionaire: 'questionnaire', reccommend: 'recommend', rythm: 'rhythm',
    shedule: 'schedule', sieze: 'seize', similiar: 'similar', sincerly: 'sincerely',
    speach: 'speech', stoped: 'stopped', strenght: 'strength', togehter: 'together', tyop: 'typo', usualy: 'usually', vaccum: 'vacuum',
    wasnt_: "wasn't", wierdly: 'weirdly', wohle: 'whole', woudl: 'would',
    owuld: 'would', coudl: 'could', shoudl: 'should', liek: 'like', lkie: 'like',
    knwo: 'know', konw: 'know', nkow: 'know', thnak: 'thank', thnaks: 'thanks',
    abotu: 'about', aobut: 'about', baout: 'about',
    sotp: 'stop', yuo: 'you', yoru: 'your', nto: 'not', mroe: 'more', soem: 'some', smoe: 'some',
    tiem: 'time', tihng: 'thing', thign: 'thing', thigns: 'things',
    peopel: 'people', poeple: 'people', pepole: 'people', agian: 'again', aginst: 'against', allready: 'already', alwasy: 'always',
    alwyas: 'always', anwser: 'answer', ansewr: 'answer', befroe: 'before',
    beter: 'better', cahnge: 'change', chnage: 'change', diffrent: 'different',
    differnt: 'different', eveyr: 'every', evrey: 'every', frist: 'first',
    fisrt: 'first', freind_: 'friend', gerat: 'great', hlep: 'help', hepl: 'help', ihave: 'I have', ahve: 'have',
    hvae: 'have', mkae: 'make', amke: 'make', mabye: 'maybe', maybee: 'maybe',
    nowhere_: 'nowhere', ohter: 'other', otehr: 'other', palce: 'place',
    pleae: 'please', rigth: 'right', rihgt: 'right',
    siad: 'said', sya: 'say', shoud: 'should', somethign: 'something',
    somthing: 'something', sitll: 'still', tehy: 'they', tehre: 'there',
    tehn: 'then', tehm: 'them', thier_: 'their', thsi: 'this', tihs: 'this',
    tohught: 'thought', thoguht: 'thought', wehn: 'when', wnet: 'went',
    whcih_: 'which', wokr: 'work', wrok: 'work', wrold: 'world', yaer: 'year',
    yera: 'year', waht_: 'what', whoel: 'whole', ahppen: 'happen',
  };
  // The trailing-underscore keys above are spare spellings parked so a copy
  // never shadows an earlier entry; they can never match (a typed word has no
  // underscore), and are dropped here so lookups stay clean.
  for (const k of Object.keys(TYPOS)) if (k.endsWith('_')) delete TYPOS[k];

  // Slang and chat words a dictionary flags but the user means: never "fixed".
  const SLANG = new Set([
    'lol', 'lmao', 'lmfao', 'rofl', 'gonna', 'wanna', 'gotta', 'kinda', 'sorta',
    'dunno', 'lemme', 'gimme', 'idk', 'tbh', 'imo', 'imho', 'btw', 'omg', 'ok',
    'okay', 'yeah', 'yep', 'yup', 'nope', 'nah', 'ya', 'yall', 'ur', 'u', 'thx',
    'pls', 'plz', 'np', 'ty', 'tho', 'cuz', 'cos', 'bc', 'rn', 'irl', 'fyi',
    'asap', 'af', 'smh', 'ngl', 'fr', 'bruh', 'bro', 'sis', 'dude', 'lmk',
    'hmu', 'wyd', 'wbu', 'hbu', 'ikr', 'jk', 'nvm', 'gg', 'ez', 'xd', 'haha',
    'hahaha', 'hehe', 'lolol', 'ugh', 'hmm', 'mhm', 'oof', 'yikes', 'meh',
    'tryna', 'finna', 'aint', 'yknow', 'cmon', 'sup', 'wassup', 'gud',
    'yeet', 'sus', 'bae', 'fam', 'lowkey', 'highkey', 'deadass', 'ope', 'welp',
    'yolo', 'fomo', 'tbf', 'afaik', 'iirc', 'ftw', 'wtf', 'wth', 'ttyl', 'gtg',
  ]);

  let cfg = null;          // { autocorrect, underline, sitesOff, words }
  let cfgAsked = false;
  let words = new Set();   // personal dictionary, lowercased
  const ignored = new Set(); // "Ignore" from the menu, this run
  const leftAlone = new WeakMap(); // field -> Set of words the user undid there
  const answers = new Map(); // word -> Windows' verdict, this frame's cache
  let last = null;         // the most recent fix, for Backspace / Ctrl+Z
  let keySeq = 0;          // bumps on every real key, so a late fix knows if typing moved on
  const stats = { fixes: 0, lateFixes: 0, dropped: 0, reverts: 0, checks: 0 };

  // "Underline misspellings" off: a user-origin rule on the ::spelling-error
  // highlight hides Chromium's squiggle in THIS frame. webFrame.insertCSS is
  // invisible to the page (no <style> in its DOM) and per frame, so iframes
  // follow too. The spellchecker itself stays on for the right-click menu.
  const HIDE_UNDERLINE = '::spelling-error { text-decoration: none !important; }';
  let underlineKey = null;

  function applyConfig(next) {
    if (!next || typeof next !== 'object') return;
    cfg = next;
    words = new Set(Array.isArray(next.words) ? next.words : []);
    try {
      if (next.underline === false && !underlineKey) underlineKey = webFrame.insertCSS(HIDE_UNDERLINE, { cssOrigin: 'user' });
      else if (next.underline !== false && underlineKey) { webFrame.removeInsertedCSS(underlineKey); underlineKey = null; }
    } catch (err) { /* an old build without insertCSS: underlines just stay */ }
  }

  function askConfig() {
    if (cfgAsked) return;
    cfgAsked = true;
    ipcRenderer.invoke('spell:config-get').then(applyConfig, () => { cfgAsked = false; });
  }

  ipcRenderer.on('spell:config', (_e, next) => applyConfig(next));
  ipcRenderer.on('spell:ignore', (_e, word) => { if (typeof word === 'string') ignored.add(word); });

  /** Windows' verdict on one word: { misspelled, action, replacement, suggestions } or null. */
  function ask(word) {
    if (answers.has(word)) return Promise.resolve(answers.get(word));
    stats.checks++;
    return ipcRenderer.invoke('spell:check', word).then((a) => {
      if (a) {
        if (answers.size >= 400) answers.delete(answers.keys().next().value);
        answers.set(word, a);
      }
      return a;
    }, () => null);
  }

  // ---------------------------------------------------------------------------
  // Which fields
  // ---------------------------------------------------------------------------

  const NO_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|username|email|url|tel|cc-)/i;
  const CODE_SELECTOR = 'code, pre, kbd, samp, .CodeMirror, .cm-editor, .cm-content, .monaco-editor, .ace_editor, .xterm, [data-language], .hljs';
  // Editors that keep their own model and apply our edit on their own render.
  // A late fix after Enter would land on a selection they may be about to
  // rewrite, so those never get a fix on Enter (Space is fine).
  const MODEL_EDITOR = '[data-slate-editor], [data-lexical-editor], .DraftEditor-root, [data-contents="true"]';

  /** { el, kind: 'text' | 'ce', search } for an editable we may touch, else null. */
  function fieldOf(e) {
    let t = e.composedPath ? e.composedPath()[0] : e.target;
    if (!t || t.nodeType !== 1) return null;
    const tag = t.tagName;
    let kind = null;
    if (tag === 'TEXTAREA') kind = 'text';
    else if (tag === 'INPUT') {
      const type = (t.getAttribute('type') || 'text').toLowerCase();
      if (type !== 'text' && type !== 'search') return null; // password/email/url/tel/number...
      kind = 'text';
    } else if (t.isContentEditable) {
      kind = 'ce';
      // The editing host, so per-field memory is the whole editor.
      while (t.parentElement && t.parentElement.isContentEditable) t = t.parentElement;
    } else return null;

    const search = t.getAttribute('data-autocorrect') === 'search';
    if (t.getAttribute('data-autocorrect') === 'off' || (t.getAttribute('autocorrect') || '').toLowerCase() === 'off') return null;
    if (!search && t.spellcheck === false) return null;
    if (kind === 'text') {
      if (t.readOnly || t.disabled) return null;
      if (NO_AUTOCOMPLETE.test(t.getAttribute('autocomplete') || '')) return null;
      const mode = (t.getAttribute('inputmode') || '').toLowerCase();
      if (mode === 'email' || mode === 'url' || mode === 'tel' || mode === 'numeric' || mode === 'decimal') return null;
    }
    if (t.closest(CODE_SELECTOR)) return null;
    // Model editors (Slate = Discord, Lexical, Draft) keep their own document model and rewrite
    // the DOM from it, so an insertText we make can be undone or misplaced by the editor, and the
    // lane's stand-in showed Backspace-to-undo deleting the WRONG character there. Until a fix is
    // proven in a real one, auto-fix stays off in them; the red underline and the right-click
    // suggestions (native spellcheck + main's context menu) still work, so nothing is silently lost.
    if (kind === 'ce' && (t.closest(MODEL_EDITOR) || t.querySelector('[data-contents="true"]'))) return null;
    return { el: t, kind, search };
  }

  function siteOff() {
    if (!cfg || !Array.isArray(cfg.sitesOff) || !cfg.sitesOff.length) return false;
    let host = '';
    try {
      // A frame inside a page follows the PAGE's switch: ancestorOrigins'
      // last entry is the top-level origin even across origins.
      const anc = location.ancestorOrigins;
      const top = anc && anc.length ? anc[anc.length - 1] : location.origin;
      host = new URL(top).hostname;
    } catch (err) { host = location.hostname; }
    host = String(host || '').toLowerCase().replace(/^www\./, '');
    return !!host && cfg.sitesOff.includes(host);
  }

  // ---------------------------------------------------------------------------
  // The decision
  // ---------------------------------------------------------------------------

  const LETTERS = 'A-Za-z\\u00C0-\\u024F';
  // lead punctuation, the word, trailing punctuation -- and nothing else. A
  // token with a dot, slash, @, #, colon in front, digit, underscore or hyphen
  // simply does not match, which is how URLs, emails, mentions, tags, :emoji:,
  // paths and code-ish names are never touched.
  const TOKEN = new RegExp('^([(\\["\'\\u201C\\u2018]*)([' + LETTERS + ']+)([.,!?;:)\\]"\'\\u201D\\u2019\\u2026]*)$');

  /** Optimal string alignment distance, capped: we only ever ask "is it 1?". */
  function editDistance(a, b) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 1) return 2;
    const d = [];
    for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[a.length][b.length];
  }

  /** The suggestion route: one clear, close, ordinary word, or null. */
  function bestSuggestion(lower, suggestions) {
    if (lower.length < 4) return null;
    const list = (suggestions || []).filter((s) => typeof s === 'string' && s && !/[\s.-]/.test(s));
    if (!list.length) return null;
    const top = list[0];
    if (!/^[a-zà-ɏ']+$/.test(top)) return null; // a name or an acronym: not ours to pick
    if (editDistance(lower, top) !== 1) return null;
    for (let i = 1; i < list.length; i++) {
      const s = list[i].toLowerCase();
      if (s !== top && editDistance(lower, s) <= 1) return null; // a tie is a guess
    }
    return top;
  }

  function withCase(typed, fix) {
    if (typed[0] === typed[0].toUpperCase() && typed[0] !== typed[0].toLowerCase()) {
      return fix[0].toUpperCase() + fix.slice(1);
    }
    return fix;
  }

  /**
   * The word just finished, if it is one we may fix at all. `before` is the
   * text from the start of the line/block up to the caret. Everything here is
   * local and instant; only words that pass go to Windows.
   */
  function candidate(before, field) {
    const m = /(\S+)$/.exec(before);
    if (!m) return null;
    const token = m[1];
    const t = TOKEN.exec(token);
    if (!t) return null;
    const [, lead, core, tail] = t;
    const pre = before.slice(0, m.index);
    const lower = core.toLowerCase();

    // Casing: lowercase, or Capitalised at the start of a sentence. ALLCAPS,
    // camelCase and Capitalised-mid-sentence (a name) are left alone.
    const isLower = core === lower;
    const isCap = core[0] !== lower[0] && core.slice(1) === lower.slice(1);
    if (!isLower && !isCap) return null;
    if (isCap) {
      const p = pre.replace(/\s+$/, '');
      const sentenceStart = !p || /[.!?…]["')\]”’]*$/.test(p);
      if (!sentenceStart) return null;
    }

    if (words.has(lower) || ignored.has(lower) || SLANG.has(lower)) return null;
    const mem = leftAlone.get(field.el);
    if (mem && mem.has(lower)) return null;
    return { core, lead, tail, lower };
  }

  /** Given Windows' verdict, the fix (cased), or null to leave it be. */
  function fixFrom(c, answer) {
    if (!answer || !answer.misspelled) return null;
    let fix = Object.prototype.hasOwnProperty.call(TYPOS, c.lower) ? TYPOS[c.lower] : null;
    if (!fix && answer.action === 'replace' && /^[\p{L}' ]+$/u.test(answer.replacement || '')) fix = answer.replacement;
    if (!fix) fix = bestSuggestion(c.lower, answer.suggestions);
    if (!fix) return null;
    fix = /^I['\s]/.test(fix) ? fix : withCase(c.core, fix);
    return fix === c.core ? null : fix;
  }

  /**
   * Address-bar rule: search text only. If the field's first word looks like
   * an address, a path, an email or a command (@ # : / > !), nothing in it is
   * touched -- so what the omnibox navigates to never changes.
   */
  function searchFieldOk(value) {
    const first = String(value || '').trim().split(/\s+/)[0] || '';
    if (!first) return false;
    if (/[.:/\\@#]/.test(first) || /^[>!?=~]/.test(first)) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  function insert(text) {
    try { return document.execCommand('insertText', false, text); } catch (err) { return false; }
  }

  function selectionFor(el) {
    const root = el.getRootNode && el.getRootNode();
    if (root && root !== document && typeof root.getSelection === 'function') return root.getSelection();
    return document.getSelection();
  }

  function activeOf(el) {
    const root = el.getRootNode && el.getRootNode();
    return root && root.activeElement;
  }

  const BLOCK = /^(P|DIV|LI|BLOCKQUOTE|H[1-6]|TD|TH|DD|DT|SECTION|ARTICLE)$/;

  /** The caret's text node and offset in a contenteditable, or null. */
  function ceCaret(field) {
    const sel = selectionFor(field.el);
    if (!sel || sel.rangeCount !== 1 || !sel.isCollapsed) return null;
    let node = sel.anchorNode;
    let offset = sel.anchorOffset;
    if (node && node.nodeType === 1) {
      const prev = node.childNodes[offset - 1];
      if (!prev || prev.nodeType !== 3) return null;
      node = prev;
      offset = prev.data.length;
    }
    if (!node || node.nodeType !== 3 || !field.el.contains(node)) return null;
    if (node.parentElement && node.parentElement.closest(CODE_SELECTOR)) return null;
    return { sel, node, offset };
  }

  function ceBefore(field, c) {
    let block = c.node.parentElement;
    while (block && block !== field.el && !BLOCK.test(block.tagName)) block = block.parentElement;
    if (!block) block = field.el;
    const r = document.createRange();
    r.setStart(block, 0);
    r.setEnd(c.node, c.offset);
    const text = r.toString();
    return text.length > 400 ? text.slice(-400) : text;
  }

  /** The finished word at the caret, and where it sits. Called on the boundary key, before it lands. */
  function locate(field) {
    if (field.kind === 'text') {
      const el = field.el;
      const caret = el.selectionStart;
      if (caret == null || caret !== el.selectionEnd) return null;
      if (field.search && !searchFieldOk(el.value)) return null;
      const lineStart = el.value.lastIndexOf('\n', caret - 1) + 1;
      const c = candidate(el.value.slice(Math.max(lineStart, caret - 400), caret), field);
      if (!c) return null;
      return { c, pos: { start: caret - c.tail.length - c.core.length } };
    }
    const at = ceCaret(field);
    if (!at) return null;
    const c = candidate(ceBefore(field, at), field);
    if (!c) return null;
    const start = at.offset - c.tail.length - c.core.length;
    if (start < 0 || at.node.data.slice(start, start + c.core.length) !== c.core) return null; // spans nodes
    return { c, pos: { node: at.node, start } };
  }

  const SPACE = /[  \n\t]/;

  /**
   * Swap the word for its fix. `late` means the boundary key has already
   * landed (the answer came after it): then the word must still be exactly
   * where it was, followed by that boundary, and the caret is carried along.
   * Returns the record for undo, { failed } when an editor swallowed the edit,
   * or null when it is no longer safe to touch.
   */
  function replaceWord(field, c, pos, fix, late, key) {
    const body = c.core + c.tail;
    if (field.kind === 'text') {
      const el = field.el;
      if (!el.isConnected || (late && activeOf(el) !== el)) return null;
      if (field.search && !searchFieldOk(el.value)) return null;
      const end = pos.start + c.core.length;
      if (el.value.slice(pos.start, pos.start + body.length) !== body) return null;
      const s0 = el.selectionStart;
      const s1 = el.selectionEnd;
      if (late && (!SPACE.test(el.value.charAt(pos.start + body.length)) || s0 < pos.start + body.length + 1)) return null;
      el.setSelectionRange(pos.start, end);
      const ok = insert(fix);
      if (!ok || el.value.slice(pos.start, pos.start + fix.length) !== fix) {
        try { el.setSelectionRange(s0, s1); } catch (err) { /* gone */ }
        return null;
      }
      const d = fix.length - c.core.length;
      el.setSelectionRange(s0 + d, s1 + d);
      return { el, kind: 'text', start: pos.start, original: c.core, fix, tail: c.tail };
    }

    const node = pos.node;
    if (!node.isConnected || !field.el.contains(node)) return null;
    if (node.data.slice(pos.start, pos.start + body.length) !== body) return null;
    const end = pos.start + c.core.length;
    const sel = selectionFor(field.el);
    if (!sel || sel.rangeCount !== 1 || !sel.isCollapsed) return null;
    let after = -1;     // characters between the word's end and the caret, same node
    let saved = null;   // or, after Enter, the caret's own spot in the next block
    if (sel.anchorNode === node) {
      after = sel.anchorOffset - end;
      if (after < c.tail.length) return null;
      if (late && (after < c.tail.length + 1 || !SPACE.test(node.data.charAt(pos.start + body.length)))) return null;
    } else if (late && key === 'Enter' && field.el.contains(sel.anchorNode) && pos.start + body.length === node.data.length) {
      saved = { node: sel.anchorNode, offset: sel.anchorOffset };
    } else return null;

    const r = document.createRange();
    r.setStart(node, pos.start);
    r.setEnd(node, end);
    sel.removeAllRanges();
    sel.addRange(r);
    const ok = insert(fix);
    // Verify against what is really in the field now, not what we hoped.
    const now = ceCaret(field);
    if (!ok || !now || !now.node.data.slice(0, now.offset).endsWith(fix)) return { failed: true };
    const rec = { el: field.el, kind: 'ce', node: now.node, start: now.offset - fix.length, original: c.core, fix, tail: c.tail };
    if (saved) {
      if (saved.node.isConnected) { now.sel.collapse(saved.node, saved.offset); }
    } else if (after > 0) {
      if (now.node.data.length >= now.offset + after) now.sel.collapse(now.node, now.offset + after);
      else for (let i = 0; i < after; i++) now.sel.modify('move', 'forward', 'character');
    }
    return rec;
  }

  /** Backspace / Ctrl+Z right after a fix: put back what was typed. */
  function revert(e, field, undo) {
    const L = last;
    last = null;
    if (!L || !field || field.el !== L.el || !L.el.isConnected) return false;
    const body = L.fix + L.tail;
    if (L.kind === 'text') {
      const el = L.el;
      const caret = el.selectionStart;
      if (caret !== el.selectionEnd) return false;
      const seg = el.value.slice(L.start, caret);
      const boundary = seg.slice(body.length);
      if (!seg.startsWith(body) || !/^[  \n]$/.test(boundary)) return false;
      e.preventDefault();
      el.setSelectionRange(L.start, caret);
      insert(L.original + L.tail + (undo ? boundary : ''));
    } else {
      const c = ceCaret(field);
      if (!c || c.node !== L.node) return false;
      const seg = c.node.data.slice(L.start, c.offset);
      const boundary = seg.slice(body.length);
      if (!seg.startsWith(body) || !/^[  ]$/.test(boundary)) return false;
      e.preventDefault();
      const r = document.createRange();
      r.setStart(c.node, L.start);
      r.setEnd(c.node, c.offset);
      c.sel.removeAllRanges();
      c.sel.addRange(r);
      insert(L.original + L.tail + (undo ? ' ' : ''));
    }
    let mem = leftAlone.get(L.el);
    if (!mem) { mem = new Set(); leftAlone.set(L.el, mem); }
    mem.add(L.original.toLowerCase());
    stats.reverts++;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Listeners
  // ---------------------------------------------------------------------------

  // Config is fetched the first time a field we could touch takes focus, so
  // a frame nobody types in (an ad, a video embed) never asks for anything.
  window.addEventListener('focusin', (e) => {
    if (cfg || cfgAsked) return;
    if (fieldOf(e)) askConfig();
  }, true);

  window.addEventListener('pointerdown', () => { last = null; }, true);

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' || k === 'CapsLock') return;
    if (e.isComposing || e.keyCode === 229) return;
    keySeq++;

    if (k === 'Backspace' || ((k === 'z' || k === 'Z') && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey)) {
      if (!last) return;
      if (k === 'Backspace' && (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey)) { last = null; return; }
      revert(e, fieldOf(e), k !== 'Backspace');
      return;
    }

    last = null;
    if (k !== ' ' && k !== 'Enter') return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (!cfg) { if (!cfgAsked && fieldOf(e)) askConfig(); return; }
    if (!cfg.autocorrect || siteOff()) return;
    const field = fieldOf(e);
    if (!field) return;
    // Enter in a one-line field submits it (a search, the address bar):
    // silently changing what gets submitted is worse than a missed fix.
    if (k === 'Enter' && (field.search || field.el.tagName === 'INPUT')) return;
    if (k === 'Enter' && field.kind === 'ce' && field.el.closest(MODEL_EDITOR)) return;
    const loc = locate(field);
    if (!loc) return;

    const known = answers.get(loc.c.lower);
    if (known) {
      // Seen before: fix it now, before the boundary lands.
      const fix = fixFrom(loc.c, known);
      if (!fix) return;
      const rec = replaceWord(field, loc.c, loc.pos, fix, false, k);
      if (!rec) return;
      if (rec.failed) {
        // An editor that takes edits on its own render: our fix is pending.
        // Hold the Space back for one tick so it lands after it, not on a
        // selection that is about to be stale.
        if (k === ' ') { e.preventDefault(); setTimeout(() => insert(' '), 0); }
        return;
      }
      stats.fixes++;
      last = (k === ' ' || rec.kind === 'text') ? rec : null;
      return;
    }

    // New word: let the boundary land now, and fix the word when Windows
    // answers (a few ms -- normally before the next key).
    const seq = keySeq;
    ask(loc.c.lower).then((answer) => {
      const fix = fixFrom(loc.c, answer);
      if (!fix) return;
      const rec = replaceWord(field, loc.c, loc.pos, fix, true, k);
      if (!rec || rec.failed) { stats.dropped++; return; }
      stats.lateFixes++;
      // Undo-by-Backspace only while nothing else has been typed since.
      if (keySeq === seq && (k === ' ' || rec.kind === 'text')) last = rec;
    });
  }, true);

  // Test and debugging handle. This is the ISOLATED world's window: the page
  // cannot see it; only devtools / CDP pointed at this world can.
  window.__quartzSpell = {
    config: () => cfg,
    stats: () => Object.assign({}, stats),
    check: (w) => ask(w),
    decide: (before) => {
      const c = candidate(before, { el: document.body });
      return c ? ask(c.lower).then((a) => fixFrom(c, a)) : Promise.resolve(null);
    },
    askConfig,
  };
})();
