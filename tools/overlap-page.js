// tools/overlap-page.js -- the in-page half of tools/overlap-audit.js. Evaluated into the chrome page
// and into each guest page (Home, history, phone, reader, welcome) over CDP; defines window.__ov.
// Nothing here changes layout: it tags candidates with data-ov, reads geometry, decodes screenshots
// into an OffscreenCanvas and compares pixels.
(function () {
  'use strict';
  if (window.__ov) return;
  const INTERACTIVE = [
    'button', 'a[href]', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=tab]', '[role=menuitem]', '[role=menuitemcheckbox]', '[role=menuitemradio]',
    '[role=option]', '[role=switch]', '[role=checkbox]', '[role=radio]', '[role=link]', '[role=slider]',
    '[tabindex]:not([tabindex="-1"])', '[contenteditable=""]', '[contenteditable=true]',
  ].join(',');
  const ICON = 'svg, img, canvas, .glyph, [class*="icon"], [class*="ico"], [class*="favicon"], [class*="fav-"]';
  const r4 = (r) => ({ x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 });
  const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const interW = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const interH = (a, b) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);

  /** a fully holds b: a field hosting an icon button, a card hosting its own controls. */
  const hosts = (a, b) => b.x >= a.x - 1 && b.y >= a.y - 1 && b.x + b.w <= a.x + a.w + 1 && b.y + b.h <= a.y + a.h + 1;
  /** The position:fixed layer an element lives in (null = the page itself). */
  function fixedRoot(el) {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) if (getComputedStyle(e).position === 'fixed') return e;
    return null;
  }

  /** A short readable selector for a finding. */
  function desc(el) {
    if (!el || el.nodeType !== 1) return '?';
    const parts = [];
    for (let e = el, i = 0; e && e.nodeType === 1 && i < 3; e = e.parentElement, i++) {
      let s = e.tagName.toLowerCase();
      if (e.id) { s += '#' + e.id; parts.unshift(s); break; }
      const cls = [...e.classList].filter((c) => !/^(glass|active|hover|on|open|shown)$/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      parts.unshift(s);
    }
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28);
    return parts.join(' > ') + (label ? ' "' + label + '"' : '');
  }

  function shown(el) {
    if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) return false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const c = getComputedStyle(e);
      if (c.display === 'none' || Number(c.opacity) < 0.05) return false;
      if (e === el && c.visibility !== 'visible') return false;
      if (e.hidden) return false;
    }
    return true;
  }
  function inView(r) { return r.width >= 1 && r.height >= 1 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; }
  /** The part of el actually drawn: its box cut by every clipping ancestor. */
  function drawn(el) {
    const b = el.getBoundingClientRect();
    let v = { x: b.left, y: b.top, w: b.width, h: b.height };
    for (let e = el.parentElement; e && e !== document.documentElement && v; e = e.parentElement) {
      const c = getComputedStyle(e);
      if (c.overflowX === 'visible' && c.overflowY === 'visible') continue;
      const r = e.getBoundingClientRect();
      const x0 = Math.max(v.x, r.left), y0 = Math.max(v.y, r.top), x1 = Math.min(v.x + v.w, r.right), y1 = Math.min(v.y + v.h, r.bottom);
      v = (x1 - x0 >= 1 && y1 - y0 >= 1) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    }
    return v ? r4({ left: v.x, top: v.y, width: v.w, height: v.h }) : { x: 0, y: 0, w: 0, h: 0 };
  }

  /** Not covered by something else at its centre (a panel over the toolbar, say). */
  function onTop(el, r) {
    const pts = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5]];
    for (const [fx, fy] of pts) {
      const x = Math.min(Math.max(r.left + r.width * fx, 0), innerWidth - 1);
      const y = Math.min(Math.max(r.top + r.height * fy, 0), innerHeight - 1);
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit) || (hit.shadowRoot && hit === el))) return true;
      // pointer-events:none children and labels wrapping inputs
      if (hit && hit.contains(el) && getComputedStyle(el).pointerEvents === 'none') return true;
    }
    return false;
  }
  function clipAncestor(el) {
    for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const c = getComputedStyle(e);
      if (c.overflowX !== 'visible' || c.overflowY !== 'visible') return { el: e, cs: c };
    }
    return null;
  }

  /**
   * Tags every visible, on-top interactive element under the roots (data-ov = index), and
   * collects the "neighbour" boxes every hover is judged against: all visible interactive
   * elements and all visible text runs in the whole document.
   */
  function collect(roots) {
    for (const e of document.querySelectorAll('[data-ov]')) e.removeAttribute('data-ov');
    const rootEls = (roots && roots.length ? roots : ['body']).flatMap((s) => [...document.querySelectorAll(s)]);
    const inRoot = (el) => rootEls.some((r) => r === el || r.contains(el));
    const all = [];
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (el.closest('[aria-hidden="true"]') && !el.matches('button,a[href],input')) continue;
      const r = el.getBoundingClientRect();
      if (!inView(r) || !shown(el) || !onTop(el, r)) continue;
      all.push(el);
    }
    const cands = all.filter(inRoot);
    cands.forEach((el, i) => el.setAttribute('data-ov', String(i)));
    const texts = [];
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = tw.nextNode(); n && texts.length < 4000; n = tw.nextNode()) {
      if (!n.nodeValue.trim()) continue;
      const owner = n.parentElement;
      if (!owner || !shown(owner) || /^(SCRIPT|STYLE|NOSCRIPT|OPTION|TEXTAREA)$/.test(owner.tagName)) continue;
      if (owner.closest('.glyph')) continue; // icon fonts are icons, judged as icons
      range.selectNodeContents(n);
      for (const rr of range.getClientRects()) {
        if (!inView(rr)) continue;
        // A screen-reader-only label (the 1 px clip pattern) is not drawn text.
        const ob = owner.getBoundingClientRect();
        if (ob.width <= 2 || ob.height <= 2) continue;
        // What is DRAWN: the run cut by every clipping ancestor (an ellipsised title's range
        // still reports the whole unclipped line).
        let v = { x: rr.left, y: rr.top, w: rr.width, h: rr.height };
        for (let e = owner; e && e !== document.documentElement && v; e = e.parentElement) {
          const c = getComputedStyle(e);
          if (c.overflowX === 'visible' && c.overflowY === 'visible') continue;
          const b = e.getBoundingClientRect();
          const x0 = Math.max(v.x, b.left), y0 = Math.max(v.y, b.top), x1 = Math.min(v.x + v.w, b.right), y1 = Math.min(v.y + v.h, b.bottom);
          v = (x1 - x0 >= 1 && y1 - y0 >= 1) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
        }
        if (!v) continue;
        texts.push({ owner, r: r4({ left: v.x, top: v.y, width: v.w, height: v.h }), full: r4(rr), text: n.nodeValue.trim().slice(0, 24) });
      }
    }
    ov.state = { roots: rootEls, cands, all, texts };
    // Focus is judged only where focus can land: a role=option row driven by
    // aria-activedescendant never shows a ring.
    return cands.map((el, i) => ({ i, d: desc(el), r: r4(el.getBoundingClientRect()), focusable: el.tabIndex >= 0 && !el.disabled }));
  }

  /** The static checks: clipped text, controls outside their box, overlaps, small targets. */
  function staticChecks() {
    const { cands, all, texts, roots } = ov.state;
    const inRoot = (el) => roots.some((r) => r === el || r.contains(el));
    const out = [];
    const add = (kind, el, detail, r) => out.push({ kind, d: desc(el), detail, r: r || r4(el.getBoundingClientRect()) });

    // 1. clipped text with no ellipsis
    const seen = new Set();
    for (const t of texts) {
      if (!inRoot(t.owner) || seen.has(t.owner)) continue;
      const ca = clipAncestor(t.owner);
      const owner = t.owner;
      const oc = getComputedStyle(owner);
      // the owner itself clipping
      const boxes = [];
      if (oc.overflowX !== 'visible' || oc.overflowY !== 'visible') boxes.push({ el: owner, cs: oc });
      if (ca) boxes.push(ca);
      for (const b of boxes) {
        if (/auto|scroll/.test(b.cs.overflowX + b.cs.overflowY) && b.el.scrollHeight > b.el.clientHeight + 1) continue; // a scroller: reachable
        if (/auto|scroll/.test(b.cs.overflowX) && b.el.scrollWidth > b.el.clientWidth + 1) continue;
        const br = b.el.getBoundingClientRect();
        const cr = { x: br.left + b.el.clientLeft, y: br.top + b.el.clientTop, w: b.el.clientWidth, h: b.el.clientHeight };
        const cutX = t.r.x < cr.x - 1 || t.r.x + t.r.w > cr.x + cr.w + 1;
        const cutY = t.r.y + t.r.h * 0.35 < cr.y - 0.5 || t.r.y + t.r.h * 0.65 > cr.y + cr.h + 0.5;
        if (!cutX && !cutY) continue;
        if (b.el.tagName === 'INPUT' || b.el.tagName === 'TEXTAREA') continue;
        let ell = false;
        for (let e = owner; e; e = e.parentElement) { const c = getComputedStyle(e); if (c.textOverflow === 'ellipsis' || (c.webkitLineClamp && c.webkitLineClamp !== 'none')) { ell = true; break; } if (e === b.el) break; }
        if (ell && cutX && !cutY) continue;
        if (ell && cutY && getComputedStyle(b.el).webkitLineClamp !== 'none') continue;
        // fully clipped away (a hidden collapse) is not "cut text"
        if (inter(t.r, cr) < 1) continue;
        seen.add(owner);
        add(cutY ? 'text-clipped-vertically' : 'text-clipped-no-ellipsis', owner, '"' + t.text + '" cut by ' + desc(b.el), t.r);
        break;
      }
    }

    // 2. a control cut by its clipping box, or hanging off the window sideways
    for (const el of cands) {
      const r = r4(el.getBoundingClientRect());
      if (r.x < -0.5 || r.x + r.w > innerWidth + 0.5) { add('outside-window', el, 'x ' + r.x + '..' + (r.x + r.w) + ' of ' + innerWidth); continue; }
      const ca = clipAncestor(el);
      if (ca && !/auto|scroll/.test(ca.cs.overflowX + ca.cs.overflowY)) {
        const b = ca.el.getBoundingClientRect();
        const cr = { x: b.left + ca.el.clientLeft, y: b.top + ca.el.clientTop, w: ca.el.clientWidth, h: ca.el.clientHeight };
        const vis = inter(r, cr);
        if (vis > 0 && vis < r.w * r.h * 0.9) add('control-clipped', el, Math.round(100 - 100 * vis / (r.w * r.h)) + '% cut by ' + desc(ca.el));
      }
    }

    // 3. overlaps: control on control, text on text, icon on text
    const rects = all.map((el) => ({ el, r: drawn(el) }));
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        const A = rects[a], B = rects[b];
        if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
        if (!inRoot(A.el) && !inRoot(B.el)) continue;
        if (hosts(A.r, B.r) || hosts(B.r, A.r)) continue;          // an icon inside a field
        if (fixedRoot(A.el) !== fixedRoot(B.el)) continue;         // a popover over the page
        if (interW(A.r, B.r) > 1.5 && interH(A.r, B.r) > 1.5) add('controls-overlap', A.el, 'with ' + desc(B.el) + ' (' + Math.round(interW(A.r, B.r)) + 'x' + Math.round(interH(A.r, B.r)) + ')');
      }
    }
    const rt = texts.filter((t) => inRoot(t.owner));
    for (let a = 0; a < rt.length; a++) {
      for (let b = a + 1; b < rt.length; b++) {
        const A = rt[a], B = rt[b];
        if (A.owner === B.owner) continue;
        if (fixedRoot(A.owner) !== fixedRoot(B.owner)) continue;
        if (interW(A.r, B.r) > 1.5 && interH(A.r, B.r) > Math.min(A.r.h, B.r.h) * 0.3) add('text-overlaps-text', A.owner, '"' + A.text + '" over ' + desc(B.owner) + ' "' + B.text + '"', A.r);
      }
    }
    const icons = [...document.querySelectorAll(ICON)].filter((el) => inRoot(el) && shown(el)).map((el) => ({ el, r: r4(el.getBoundingClientRect()) })).filter((x) => x.r.w >= 4 && x.r.w <= 64 && x.r.h >= 4 && x.r.h <= 64 && inView(x.el.getBoundingClientRect()));
    for (const ic of icons) {
      for (const t of rt) {
        if (ic.el.contains(t.owner) || t.owner.contains(ic.el)) continue;
        if (interW(ic.r, t.r) > 1.5 && interH(ic.r, t.r) > t.r.h * 0.3) { add('icon-overlaps-text', ic.el, 'over "' + t.text + '"', ic.r); break; }
      }
    }

    // 4. targets under 24 px, with the WCAG 2.5.8 spacing exception
    const tr = cands.map((el) => ({ el, r: r4(el.getBoundingClientRect()) }));
    for (const A of tr) {
      if (A.r.w >= 23.5 && A.r.h >= 23.5) continue;
      const cs = getComputedStyle(A.el);
      if (A.el.tagName === 'A' && cs.display === 'inline') continue; // a link in a sentence
      if (A.el.type === 'range') continue;
      const cx = A.r.x + A.r.w / 2, cy = A.r.y + A.r.h / 2;
      let crowd = null;
      for (const B of tr) {
        if (B === A || A.el.contains(B.el) || B.el.contains(A.el)) continue;
        const small = B.r.w < 23.5 || B.r.h < 23.5;
        if (small) {
          const bx = B.r.x + B.r.w / 2, by = B.r.y + B.r.h / 2;
          if (Math.hypot(bx - cx, by - cy) < 24) { crowd = B.el; break; }
        } else {
          const dx = Math.max(B.r.x - cx, 0, cx - (B.r.x + B.r.w)), dy = Math.max(B.r.y - cy, 0, cy - (B.r.y + B.r.h));
          if (Math.hypot(dx, dy) < 12) { crowd = B.el; break; }
        }
      }
      if (crowd) add('target-under-24', A.el, Math.round(A.r.w) + 'x' + Math.round(A.r.h) + ', within 24 px of ' + desc(crowd));
    }
    return out;
  }

  /* ---- pixels ---- */
  async function decode(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u8], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(bmp, 0, 0);
    return x.getImageData(0, 0, bmp.width, bmp.height);
  }
  /** Two full-window shots, a moment apart: what moves on its own is masked out of every diff. */
  async function setBase(b64a, b64b) {
    const a = await decode(b64a), b = await decode(b64b);
    const noise = new Uint8Array(a.width * a.height);
    for (let p = 0; p < noise.length; p++) {
      const i = p * 4;
      if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 18) noise[p] = 1;
    }
    // grow the mask by 2 px: anti-aliased edges of a moving thing
    const grown = new Uint8Array(noise.length);
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
      if (!noise[y * a.width + x]) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && xx >= 0 && yy < a.height && xx < a.width) grown[yy * a.width + xx] = 1; }
    }
    ov.base = a; ov.noise = grown;
    let n = 0; for (const v of grown) n += v;
    return { w: a.width, h: a.height, noisy: n };
  }
  /**
   * The state shot of candidate i (clip at cx,cy) against the base: every changed pixel that is
   * outside i's own box and inside a neighbour (another control, or text i does not own).
   */
  async function judge(i, b64, cx, cy, kind) {
    const el = ov.state.cands[i];
    const img = await decode(b64);
    const base = ov.base, W = base.width;
    const own = r4(el.getBoundingClientRect());
    const nbr = [];
    const layer = fixedRoot(el);
    for (const o of ov.state.all) { if (o === el || o.contains(el) || el.contains(o)) continue; const or = drawn(o); if (hosts(or, own)) continue; if (fixedRoot(o) !== layer) continue; nbr.push({ d: desc(o), r: or, text: false }); }
    for (const t of ov.state.texts) { if (el.contains(t.owner) || t.owner === el) continue; if (fixedRoot(t.owner) !== layer) continue; nbr.push({ d: desc(t.owner) + ' text "' + t.text + '"', r: t.r, text: true }); }
    const clipBox = { x: cx, y: cy, w: img.width, h: img.height };
    const near = nbr.filter((n) => inter(n.r, clipBox) > 0);
    const hits = new Map();
    let changed = 0, outside = 0;
    let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
    for (let y = 0; y < img.height; y++) {
      const Y = cy + y; if (Y < 0 || Y >= base.height) continue;
      for (let x = 0; x < img.width; x++) {
        const X = cx + x; if (X < 0 || X >= W) continue;
        const p = Y * W + X; if (ov.noise[p]) continue;
        const i1 = (y * img.width + x) * 4, i0 = p * 4;
        const d = Math.abs(img.data[i1] - base.data[i0]) + Math.abs(img.data[i1 + 1] - base.data[i0 + 1]) + Math.abs(img.data[i1 + 2] - base.data[i0 + 2]);
        if (d <= 24) continue;
        changed++;
        if (X < bx0) bx0 = X; if (Y < by0) by0 = Y; if (X > bx1) bx1 = X; if (Y > by1) by1 = Y;
        const px = X + 0.5, py = Y + 0.5;
        if (px >= own.x - 0.5 && px <= own.x + own.w + 0.5 && py >= own.y - 0.5 && py <= own.y + own.h + 0.5) continue;
        outside++;
        for (const n of near) {
          if (px >= n.r.x && px <= n.r.x + n.r.w && py >= n.r.y && py <= n.r.y + n.r.h) { hits.set(n.d, (hits.get(n.d) || 0) + 1); }
        }
      }
    }
    const into = [...hits.entries()].filter(([, c]) => c >= 4).sort((a, b) => b[1] - a[1]).slice(0, 3);
    return {
      i, kind, d: desc(el), own, changed, outside,
      painted: changed ? { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 } : null,
      into: into.map(([d, c]) => ({ d, px: c })),
    };
  }

  /** The contact sheet: thumbnails in a grid, findings boxed in red, one PNG back as base64. */
  async function sheet(items, cols, thumbW, title) {
    const imgs = [];
    for (const it of items) {
      const bin = atob(it.b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      imgs.push({ it, bmp: await createImageBitmap(new Blob([u8], { type: 'image/png' })) });
    }
    const pad = 12, lab = 22;
    const cellH = Math.max(...imgs.map(({ bmp }) => Math.round(bmp.height * thumbW / bmp.width)), 40);
    const rows = Math.ceil(imgs.length / cols);
    const W = cols * (thumbW + pad) + pad, H = 40 + rows * (cellH + lab + pad) + pad;
    const c = new OffscreenCanvas(W, H); const x = c.getContext('2d');
    x.fillStyle = '#f2f2f2'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#111'; x.font = '600 16px Segoe UI, sans-serif'; x.fillText(title, pad, 26);
    imgs.forEach(({ it, bmp }, k) => {
      const col = k % cols, row = Math.floor(k / cols);
      const ox = pad + col * (thumbW + pad), oy = 40 + row * (cellH + lab + pad);
      const s = thumbW / bmp.width, h = Math.round(bmp.height * s);
      x.fillStyle = it.bad ? '#b00020' : '#333'; x.font = '12px Segoe UI, sans-serif';
      x.fillText(it.label.slice(0, 64), ox, oy + 14);
      x.drawImage(bmp, ox, oy + lab, thumbW, h);
      x.strokeStyle = '#999'; x.lineWidth = 1; x.strokeRect(ox + 0.5, oy + lab + 0.5, thumbW - 1, h - 1);
      x.strokeStyle = '#ff1744'; x.lineWidth = 2;
      for (const b of it.boxes || []) x.strokeRect(ox + b.x * s * (it.scale || 1), oy + lab + b.y * s * (it.scale || 1), Math.max(3, b.w * s * (it.scale || 1)), Math.max(3, b.h * s * (it.scale || 1)));
    });
    const blob = await c.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }

  /** Transitions and animations off for the audit: a forced state must paint its end state at once. */
  function still(on) {
    let st = document.getElementById('__ov_still');
    if (on && !st) {
      st = document.createElement('style'); st.id = '__ov_still';
      st.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }';
      (document.head || document.documentElement).appendChild(st);
    } else if (!on && st) st.remove();
    return 1;
  }
  const ov = { drawn, collect, staticChecks, setBase, judge, sheet, still, desc };
  window.__ov = ov;
})();
