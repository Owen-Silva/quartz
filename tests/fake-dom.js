// tests/fake-dom.js -- a small stand-in DOM, so the chrome halves of watch-playview.js and watch-comments.js load
// and run in plain node (no Electron, no network): elements keep their children, attributes, classes and listeners;
// queries answer for simple selectors (#id, .class, tag, [attr], and compounds of them; a descendant selector is
// matched by its last part), which is all these files ask of a node in the paths their unit tests drive.
// page(): a <webview> stand-in whose executeJavaScript calls wait until the test answers them. The calls are kept
// in a list of their own (code + resolve/reject only, never the element), so a test can drop the view and still
// hold every unanswered call, the way a page that never answers holds its promise.
'use strict';
const vm = require('vm');

function match(n, sel) {
  if (!n || n.nodeType !== 1) return false;
  return String(sel).split(',').some((one) => {
    const parts = one.trim().split(/\s+/);
    const last = parts[parts.length - 1];
    const re = /([#.]?[\w-]+|\[[^\]]+\])/g;
    let m, ok = true, any = false;
    while ((m = re.exec(last))) {
      any = true;
      const t = m[1];
      if (t[0] === '#') ok = ok && n.id === t.slice(1);
      else if (t[0] === '.') ok = ok && n.classList.contains(t.slice(1));
      else if (t[0] === '[') { const k = t.slice(1, -1).split('=')[0]; ok = ok && n.hasAttribute(k); }
      else ok = ok && n.tagName === t.toUpperCase();
    }
    return any && ok;
  });
}

class Text {
  constructor(t) { this.nodeType = 3; this.parentNode = null; this.data = String(t); }
  get textContent() { return this.data; }
  set textContent(t) { this.data = String(t); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}

class El {
  constructor(doc, tag, type) {
    this.ownerDocument = doc; this.tagName = String(tag).toUpperCase(); this.nodeName = this.tagName; this.nodeType = type || 1;
    this.childNodes = []; this.parentNode = null; this.attrs = {}; this.style = { setProperty() {}, removeProperty() {} }; this.dataset = {};
    this.listeners = []; this.hidden = false; this.disabled = false; this.tabIndex = 0; this._html = '';
    const self = this;
    this.classList = {
      _c() { return (self.attrs.class || '').split(/\s+/).filter(Boolean); },
      contains(c) { return this._c().indexOf(c) >= 0; },
      add(...cs) { const l = this._c(); cs.forEach((c) => { if (l.indexOf(c) < 0) l.push(c); }); self.attrs.class = l.join(' '); },
      remove(...cs) { self.attrs.class = this._c().filter((c) => cs.indexOf(c) < 0).join(' '); },
      toggle(c, on) { const has = this.contains(c); const want = on === undefined ? !has : !!on; if (want && !has) this.add(c); if (!want && has) this.remove(c); return want; }
    };
  }
  get className() { return this.attrs.class || ''; }
  set className(c) { this.attrs.class = String(c); }
  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = String(v); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.documentElement; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(t) { this.replaceChildren(); if (t !== '' && t !== null && t !== undefined) this.appendChild(new Text(t)); }
  get innerHTML() { return this._html; }
  set innerHTML(h) { this.replaceChildren(); this._html = String(h); }
  _take(n) {
    if (typeof n === 'string') return [new Text(n)];
    if (n.nodeType === 11) { const l = n.childNodes.slice(); n.childNodes = []; return l; }
    if (n.parentNode) n.parentNode.removeChild(n);
    return [n];
  }
  appendChild(n) { this._take(n).forEach((c) => { c.parentNode = this; this.childNodes.push(c); }); return n; }
  append(...ns) { ns.forEach((n) => this.appendChild(n)); }
  prepend(...ns) { ns.reverse().forEach((n) => this.insertBefore(n, this.firstChild)); }
  insertBefore(n, ref) {
    const list = this._take(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    list.forEach((c, k) => { c.parentNode = this; if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i + k, 0, c); });
    return n;
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  replaceChild(n, old) { this.insertBefore(n, old); return this.removeChild(old); }
  replaceChildren(...ns) { this.childNodes.slice().forEach((c) => this.removeChild(c)); this._html = ''; ns.forEach((n) => this.appendChild(n)); }
  replaceWith(n) { if (this.parentNode) this.parentNode.replaceChild(n, this); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  cloneNode() { const c = new El(this.ownerDocument, this.tagName); c.attrs = Object.assign({}, this.attrs); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  toggleAttribute(k, on) { const want = on === undefined ? !(k in this.attrs) : !!on; if (want) this.attrs[k] = ''; else delete this.attrs[k]; return want; }
  addEventListener(t, f) { this.listeners.push({ t, f }); }
  removeEventListener(t, f) { this.listeners = this.listeners.filter((l) => !(l.t === t && l.f === f)); }
  dispatchEvent(ev) { this.listeners.filter((l) => l.t === ev.type).forEach((l) => l.f.call(this, ev)); return true; }
  _all(out) { this.children.forEach((c) => { out.push(c); c._all(out); }); return out; }
  querySelector(sel) { return this._all([]).filter((n) => match(n, sel))[0] || null; }
  querySelectorAll(sel) { return this._all([]).filter((n) => match(n, sel)); }
  matches(sel) { return match(this, sel); }
  closest(sel) { let n = this; while (n && n.nodeType === 1) { if (match(n, sel)) return n; n = n.parentNode; } return null; }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() {}
  click() { this.dispatchEvent({ type: 'click', button: 0, stopPropagation() {}, preventDefault() {} }); }
  scrollIntoView() {}
  get offsetWidth() { return 0; }
  get offsetHeight() { return 0; }
  get scrollHeight() { return 0; }
  get clientHeight() { return 0; }
}

/** A window + document in a vm context; load(file) runs a script in it the way index.html does. */
function makeWindow(extra) {
  const listeners = [];
  const doc = { listeners: [] };
  const html = new El(doc, 'html');
  const head = new El(doc, 'head');
  const body = new El(doc, 'body');
  html.appendChild(head); html.appendChild(body);
  Object.assign(doc, {
    documentElement: html, head, body, activeElement: body, readyState: 'complete',
    createElement: (t) => new El(doc, t),
    createElementNS: (ns, t) => new El(doc, t),
    createTextNode: (t) => new Text(t),
    createDocumentFragment: () => new El(doc, '#fragment', 11),
    getElementById: (id) => html.querySelector('#' + id),
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener: (t, f) => doc.listeners.push({ t, f }),
    removeEventListener: (t, f) => { doc.listeners = doc.listeners.filter((l) => !(l.t === t && l.f === f)); },
    dispatchEvent: (ev) => { doc.listeners.filter((l) => l.t === ev.type).forEach((l) => l.f(ev)); return true; }
  });
  class Ev { constructor(type, o) { this.type = type; Object.assign(this, o || {}); } stopPropagation() {} preventDefault() {} }
  class Obs { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
  const win = Object.assign({
    document: doc, navigator: { onLine: true, userAgent: 'node' }, location: { href: 'file:///index.html' }, console,
    setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder, queueMicrotask,
    requestAnimationFrame: (f) => setTimeout(() => f(Date.now()), 0), cancelAnimationFrame: (t) => clearTimeout(t),
    getComputedStyle: () => ({ getPropertyValue: () => '' }), matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    Event: Ev, CustomEvent: Ev, KeyboardEvent: Ev, MutationObserver: Obs, ResizeObserver: Obs, IntersectionObserver: Obs,
    addEventListener: (t, f) => listeners.push({ t, f }), removeEventListener() {}, dispatchEvent: () => true,
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1
  }, extra || {});
  win.window = win; win.self = win;
  const ctx = vm.createContext(win);
  return { win, doc, ctx, load: (file) => vm.runInContext(require('fs').readFileSync(file, 'utf8'), ctx, { filename: file }) };
}

/** A <webview> stand-in: its page calls wait in `calls` (code, ok, no) until the test answers them. */
function page(doc) {
  const calls = [];
  const v = new El(doc, 'webview');
  v.executeJavaScript = (code) => new Promise((ok, no) => { calls.push({ code: String(code), ok, no }); });
  v.insertCSS = () => Promise.resolve('css');
  v.getWebContentsId = () => 7;
  return { v, calls };
}

/** node's own GC, for the leak checks (WeakRef + collect). */
function gcFn() {
  try { require('v8').setFlagsFromString('--expose-gc'); return vm.runInNewContext('gc'); } catch (e) { return null; }
}
async function collect(gc) {
  for (let i = 0; i < 4; i++) { await new Promise((r) => setImmediate(r)); gc(); }
}

module.exports = { El, makeWindow, page, gcFn, collect };
