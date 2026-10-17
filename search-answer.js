/* ============================================================
   search-answer.js — the Claude answer at the top of All results.

   Loaded by search.html before search.js. A preload-less file://
   page: this file never sees the Claude key and never fetches. It
   asks main over console lines and is answered on window.__applyAnswer
   (main's side is claudeanswer.js; this is the page's side).

     out  quartz-search:answer {"q","seq","mode":"auto"|"deep"|"ask",
                                "history":[{"role","text"}]}
     out  quartz-search:answer-stop {"seq"}
     in   __applyAnswer({ seq, phase: 'start', model, mode })
                       ({ seq, phase: 'delta', text })
                       ({ seq, phase: 'done', text, citations, usage, costUsd })
                       ({ seq, phase: 'fail', state, title, detail, retry, settings })
                       ({ seq, phase: 'off', reason: 'no-key'|'manual'|'not-question' })

   Only the newest seq is heard; anything older is ignored (and the
   call returns false), so a late answer to an old question can never
   paint over a new one.

   The answer is Claude's, not Brave's, and looks it: its own raised
   card, its own label and model, never mixed into Brave's list.

   SAFETY. Model text is never parsed as HTML. A small markdown subset
   (paragraphs, "- " bullets, **bold**, `code`, [n] citations) is
   turned into nodes with createElement/textContent; anything else
   stays text. Citation links are http(s) only.

   NO SILENT STATES. Every way this ends is on screen: the answer, a
   fail panel with its title and detail (Retry / Open Settings where
   main flagged them), a quiet "Ask Claude" row, or "Add a Claude API
   key in Settings". If main never replies (an older Quartz with no
   Claude side) the panel says so after NO_REPLY_MS; if a stream goes
   quiet it says so after STALL_MS.
   ============================================================ */

(function () {
  'use strict';

  var cfg = { noReplyMs: 20000, stallMs: 90000, stopGraceMs: 1500 };
  var LINE = 'quartz-search:answer ';
  var STOP_LINE = 'quartz-search:answer-stop ';
  var MAX_FOLLOW = 400;

  var root = null;          // section#qa
  var els = {};             // the panel's fixed parts
  var query = '';
  var seq = 0;              // the newest request; only it is heard
  var turns = [];           // the conversation, oldest first
  var view = 'idle';        // 'idle' | 'off' | 'pending' | 'streaming' | 'done' | 'fail' | 'stopped'
  var offReason = '';
  var model = '';
  var watchdog = null;
  var ticker = null;
  var stopTimer = null;
  var paintQueued = false;
  var expanded = false;
  var sent = [];            // the lines this page sent, for the test seam

  /* ---------------------------------------------------------- helpers */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(cls, text, onClick, title) {
    var b = el('button', 'qa-btn ' + cls, text);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function webHref(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
      var u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
    } catch (err) { return ''; }
  }

  function hostOf(href) {
    try { return new URL(href).hostname.replace(/^www\./, ''); } catch (err) { return ''; }
  }

  function say(line, obj) {
    var text = line + JSON.stringify(obj);
    sent.push(text);
    if (sent.length > 40) sent.shift();
    console.log(text);
  }

  /** "claude-sonnet-4-5-20250929" -> "Sonnet 4.5"; anything else as sent. */
  function modelName(id) {
    var s = String(id || '');
    var m = /^claude-(?:(\d+)-(\d+)-)?([a-z]+)(?:-(\d+)(?:-(\d{1,2}))?)?(?:-\d{8}|-latest)?$/i.exec(s);
    if (!m) return s;
    var family = m[3].charAt(0).toUpperCase() + m[3].slice(1).toLowerCase();
    var ver = m[1] ? m[1] + '.' + m[2] : (m[4] ? m[4] + (m[5] ? '.' + m[5] : '') : '');
    return ver ? family + ' ' + ver : family;
  }

  function money(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
    if (n === 0) return '$0';
    if (n < 0.001) return '<$0.001';
    return '$' + (n < 1 ? n.toFixed(3) : n.toFixed(2));
  }

  function tokens(u) {
    if (!u || typeof u !== 'object') return '';
    var i = Number(u.input_tokens != null ? u.input_tokens : u.input);
    var o = Number(u.output_tokens != null ? u.output_tokens : u.output);
    var bits = [];
    if (isFinite(i) && i > 0) bits.push(i.toLocaleString('en-US') + ' in');
    if (isFinite(o) && o > 0) bits.push(o.toLocaleString('en-US') + ' out');
    return bits.join(' · ');
  }

  function latest() { return turns.length ? turns[turns.length - 1] : null; }

  function clearTimers() {
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    if (ticker) { clearInterval(ticker); ticker = null; }
  }

  function arm(ms, onFire) {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(function () { watchdog = null; onFire(); }, ms);
  }

  /* ---------------------------------------------------------- markdown subset -> nodes */

  var INLINE = /(\*\*[^*\n]+?\*\*|`[^`\n]+`|\[\d{1,2}(?:\s*,\s*\d{1,2})*\])/g;

  /** One citation marker: a chip with the source's host once main has named the sources. */
  function citeChip(n, turn) {
    var c = null;
    var list = turn && Array.isArray(turn.citations) ? turn.citations : [];
    for (var i = 0; i < list.length; i++) if (Number(list[i].n) === n) { c = list[i]; break; }
    var href = c ? webHref(c.url) : '';
    if (!href) {
      var pend = el('span', 'qa-cite is-pending', String(n));
      pend.title = turn && turn.state === 'done' ? 'Source ' + n + ' (not named by the answer)' : 'Source ' + n;
      return pend;
    }
    var a = el('a', 'qa-cite');
    a.href = href;
    a.setAttribute('data-n', String(n));
    a.title = (c.title ? String(c.title) + ' — ' : '') + (c.host || hostOf(href));
    a.appendChild(el('span', 'qa-cite-n', String(n)));
    a.appendChild(el('span', 'qa-cite-host', String(c.host || hostOf(href))));
    return a;
  }

  function appendInline(parent, text, turn) {
    var s = String(text);
    var last = 0, m;
    INLINE.lastIndex = 0;
    var tail = function (chunk) {
      // An unclosed ** or ` while the answer is still streaming: the rest is bold / code.
      var b = chunk.indexOf('**');
      var t = chunk.indexOf('`');
      if (b >= 0 && (t < 0 || b < t)) {
        if (b > 0) parent.appendChild(document.createTextNode(chunk.slice(0, b)));
        if (chunk.length > b + 2) parent.appendChild(el('strong', null, chunk.slice(b + 2)));
        return;
      }
      if (t >= 0) {
        if (t > 0) parent.appendChild(document.createTextNode(chunk.slice(0, t)));
        if (chunk.length > t + 1) parent.appendChild(el('code', null, chunk.slice(t + 1)));
        return;
      }
      if (chunk) parent.appendChild(document.createTextNode(chunk));
    };
    while ((m = INLINE.exec(s))) {
      if (m.index > last) parent.appendChild(document.createTextNode(s.slice(last, m.index)));
      var tok = m[0];
      if (tok.charAt(0) === '*') parent.appendChild(el('strong', null, tok.slice(2, -2)));
      else if (tok.charAt(0) === '`') parent.appendChild(el('code', null, tok.slice(1, -1)));
      else {
        var nums = tok.slice(1, -1).split(',');
        for (var k = 0; k < nums.length; k++) parent.appendChild(citeChip(parseInt(nums[k], 10), turn));
      }
      last = INLINE.lastIndex;
    }
    tail(s.slice(last));
  }

  /** The whole text -> blocks: paragraphs, "- " bullet lists, "1. " lists; headings as bold. */
  function renderText(parent, text, turn) {
    parent.textContent = '';
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var para = [], list = null, listKind = '';
    var flushPara = function () {
      if (!para.length) return;
      var p = el('p', 'qa-p');
      appendInline(p, para.join(' '), turn);
      parent.appendChild(p);
      para = [];
    };
    var flushList = function () { list = null; listKind = ''; };
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
      var num = /^\s*(\d{1,2})[.)]\s+(.*)$/.exec(line);
      var head = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if (bullet || num) {
        flushPara();
        var kind = bullet ? 'ul' : 'ol';
        if (!list || listKind !== kind) { list = el(kind, 'qa-list'); listKind = kind; parent.appendChild(list); }
        var li = el('li');
        appendInline(li, bullet ? bullet[1] : num[2], turn);
        list.appendChild(li);
        continue;
      }
      if (head) {
        flushPara(); flushList();
        var h = el('p', 'qa-p qa-h');
        appendInline(h, head[1], turn);
        parent.appendChild(h);
        continue;
      }
      if (list) {
        // A continuation line of the last item.
        var lastLi = list.lastChild;
        if (lastLi) { lastLi.appendChild(document.createTextNode(' ')); appendInline(lastLi, line.trim(), turn); continue; }
      }
      para.push(line.trim());
    }
    flushPara();
  }

  /* ---------------------------------------------------------- building the panel */

  function build() {
    root = document.getElementById('qa');
    if (!root) return false;
    root.textContent = '';
    root.setAttribute('aria-label', 'Answer from Claude');
    var head = el('header', 'qa-head');
    var mark = el('span', 'qa-mark');
    mark.setAttribute('aria-hidden', 'true');
    head.appendChild(mark);
    head.appendChild(el('span', 'qa-label', 'Claude'));
    els.model = el('span', 'qa-model', '');
    head.appendChild(els.model);
    els.status = el('span', 'qa-status', '');
    els.status.setAttribute('aria-live', 'polite');
    head.appendChild(els.status);
    els.note = el('span', 'qa-note', 'AI answer · not from Brave · check the sources');
    head.appendChild(els.note);
    root.appendChild(head);

    els.clip = el('div', 'qa-clip');
    els.thread = el('div', 'qa-thread');
    els.clip.appendChild(els.thread);
    els.fade = el('div', 'qa-fade');
    els.fade.setAttribute('aria-hidden', 'true');
    els.clip.appendChild(els.fade);
    root.appendChild(els.clip);

    els.off = el('div', 'qa-off');
    root.appendChild(els.off);

    var foot = el('div', 'qa-foot');
    els.more = button('qa-more', 'Show more', function () { expanded = !expanded; paint(); });
    els.stop = button('qa-stop', 'Stop', function () { stop('button'); }, 'Stop this answer');
    els.copy = button('qa-copy', 'Copy', copy, 'Copy the answer and its sources');
    els.deeper = button('qa-deeper', 'Deeper answer', deeper, 'Ask again, at more length and with more care');
    els.cost = el('span', 'qa-cost', '');
    foot.appendChild(els.more);
    foot.appendChild(els.stop);
    foot.appendChild(els.copy);
    foot.appendChild(els.deeper);
    foot.appendChild(els.cost);
    root.appendChild(foot);
    els.foot = foot;

    var follow = el('div', 'qa-follow');
    els.input = el('input', 'qa-input');
    els.input.type = 'text';
    els.input.maxLength = MAX_FOLLOW;
    els.input.placeholder = 'Ask a follow-up';
    els.input.setAttribute('aria-label', 'Ask Claude a follow-up question');
    els.input.autocomplete = 'off';
    els.input.spellcheck = true;
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); followUp(); }
      if (e.key === 'Escape') { els.input.blur(); }
    });
    els.ask = button('qa-ask', 'Ask', followUp);
    follow.appendChild(els.input);
    follow.appendChild(els.ask);
    root.appendChild(follow);
    els.follow = follow;
    return true;
  }

  function skeleton() {
    var box = el('div', 'qa-skel');
    box.setAttribute('aria-hidden', 'true');
    var widths = ['96%', '91%', '72%'];
    for (var i = 0; i < widths.length; i++) {
      var s = el('span', 'qa-sk');
      s.style.width = widths[i];
      box.appendChild(s);
    }
    return box;
  }

  function problemBox(turn) {
    var f = turn.fail || {};
    var box = el('div', 'qa-problem');
    box.setAttribute('role', 'alert');
    box.setAttribute('data-problem', String(f.state || 'unknown'));
    var h = el('div', 'qa-problem-head');
    var pip = el('span', 'qa-pip');
    pip.setAttribute('aria-hidden', 'true');
    h.appendChild(pip);
    h.appendChild(el('strong', 'qa-problem-title', f.title || 'Claude could not answer'));
    box.appendChild(h);
    box.appendChild(el('p', 'qa-problem-detail', f.detail || 'Quartz gave no detail for this.'));
    var acts = el('div', 'qa-actions');
    if (f.settings) acts.appendChild(button('qa-primary qa-act-settings', 'Open Settings', openSettings));
    if (f.retry) acts.appendChild(button((f.settings ? '' : 'qa-primary ') + 'qa-act-retry', 'Retry', function () { retry(); }));
    if (acts.childNodes.length) box.appendChild(acts);
    return box;
  }

  function sourcesBox(turn) {
    var list = Array.isArray(turn.citations) ? turn.citations : [];
    var shown = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var href = c && webHref(c.url);
      if (href) shown.push({ n: Number(c.n), url: href, title: String(c.title || ''), host: String(c.host || hostOf(href)) });
    }
    if (!shown.length) return null;
    var box = el('div', 'qa-sources');
    box.appendChild(el('span', 'qa-sources-label', 'Sources'));
    var ol = el('ol', 'qa-source-list');
    for (var k = 0; k < shown.length; k++) {
      var s = shown[k];
      var li = el('li', 'qa-source');
      var a = el('a', 'qa-source-link');
      a.href = s.url;
      a.title = s.url;
      a.appendChild(el('span', 'qa-source-n', isFinite(s.n) ? String(s.n) : '•'));
      var words = el('span', 'qa-source-words');
      words.appendChild(el('span', 'qa-source-title', s.title || s.host));
      words.appendChild(el('span', 'qa-source-host', s.host));
      a.appendChild(words);
      li.appendChild(a);
      ol.appendChild(li);
    }
    box.appendChild(ol);
    return box;
  }

  function paintTurn(turn, index) {
    var art = el('article', 'qa-turn');
    art.setAttribute('data-turn-state', turn.state);
    if (index > 0) {
      var asked = el('p', 'qa-asked');
      asked.appendChild(el('span', 'qa-asked-label', 'You asked'));
      asked.appendChild(document.createTextNode(turn.q));
      art.appendChild(asked);
    }
    var body = el('div', 'qa-body');
    if (turn.text) renderText(body, turn.text, turn);
    if (turn.text) art.appendChild(body);
    if (!turn.text && (turn.state === 'pending' || turn.state === 'streaming')) art.appendChild(skeleton());
    if (turn.state === 'streaming' && turn.text) body.appendChild(el('span', 'qa-caret'));
    if (turn.state === 'done') {
      var src = sourcesBox(turn);
      if (src) art.appendChild(src);
    }
    if (turn.state === 'stopped') {
      var st = el('p', 'qa-stopped', turn.stopNote || 'Stopped.');
      st.appendChild(document.createTextNode(' '));
      st.appendChild(button('qa-link qa-act-retry', 'Retry', function () { retry(); }));
      art.appendChild(st);
    }
    if (turn.state === 'fail') art.appendChild(problemBox(turn));
    return art;
  }

  function paintOff() {
    els.off.textContent = '';
    if (offReason === 'no-key') {
      els.off.appendChild(el('span', 'qa-off-text', 'Add a Claude API key in Settings for answers'));
      els.off.appendChild(button('qa-act-settings', 'Open Settings', openSettings));
    } else {
      var label = offReason === 'manual' ? 'Answers are set to ask first.' : '';
      if (label) els.off.appendChild(el('span', 'qa-off-text', label));
      var b = button('qa-primary qa-act-ask', 'Ask Claude', function () { ask(query, 'ask', []); }, 'Ask Claude about this search');
      els.off.appendChild(b);
      if (!label) els.off.appendChild(el('span', 'qa-off-text', 'about “' + (query.length > 80 ? query.slice(0, 79) + '…' : query) + '”'));
    }
  }

  function paint() {
    paintQueued = false;
    if (!root) return;
    root.setAttribute('data-state', view);
    root.hidden = view === 'idle';
    var t = latest();
    els.model.textContent = model ? modelName(model) : '';
    els.model.title = model || '';
    var statusText = '';
    if (t && t.state === 'stopping') statusText = 'Stopping…';
    else if (view === 'pending') statusText = 'Thinking' + elapsed();
    else if (view === 'streaming') statusText = t && t.text ? 'Writing' : 'Thinking' + elapsed();
    else if (t && t.state === 'stopping') statusText = 'Stopping…';
    else if (view === 'done' && t && t.mode === 'deep') statusText = 'Deeper answer';
    els.status.textContent = statusText;

    if (view === 'off') {
      els.thread.textContent = '';
      paintOff();
    } else {
      els.off.textContent = '';
      els.thread.textContent = '';
      for (var i = 0; i < turns.length; i++) els.thread.appendChild(paintTurn(turns[i], i));
    }
    var busy = view === 'pending' || view === 'streaming';
    var hasText = turns.some(function (x) { return !!x.text; });
    els.stop.hidden = !busy;
    els.stop.disabled = !!(t && t.state === 'stopping');
    els.copy.hidden = busy || !hasText || view === 'off';
    els.deeper.hidden = view !== 'done' || !t || t.mode === 'deep';
    els.follow.hidden = !(view === 'done' || (view === 'stopped' && hasText));
    var cost = t && t.state === 'done' ? [money(t.costUsd), tokens(t.usage)].filter(Boolean).join(' · ') : '';
    els.cost.textContent = cost;
    els.foot.hidden = view === 'off' || view === 'idle';
    root.setAttribute('aria-busy', busy ? 'true' : 'false');
    measure();
  }

  /** "Show more" only when the answer is taller than the clip. */
  function measure() {
    if (!root) return;
    var over = view !== 'off' && els.thread.scrollHeight > els.clip.clientHeight + 4;
    root.classList.toggle('is-expanded', expanded);
    if (expanded) { els.more.hidden = false; els.more.textContent = 'Show less'; root.classList.add('is-long'); return; }
    root.classList.toggle('is-long', over);
    els.more.hidden = !over;
    els.more.textContent = 'Show more';
  }

  function schedule() {
    if (paintQueued) return;
    paintQueued = true;
    (window.requestAnimationFrame || setTimeout)(paint);
  }

  var startedAt = 0;
  function elapsed() {
    if (!startedAt) return '';
    var s = Math.floor((Date.now() - startedAt) / 1000);
    return s >= 2 ? ' · ' + s + ' s' : '…';
  }

  /* ---------------------------------------------------------- asking */

  function historyBefore(index) {
    var out = [];
    for (var i = 0; i < index; i++) {
      var t = turns[i];
      if (!t.text) continue;
      out.push({ role: 'user', text: t.q });
      out.push({ role: 'assistant', text: t.text });
    }
    return out;
  }

  /** Sends one request for the LAST turn (replacing it) or a new turn. */
  function send(turn) {
    seq += 1;
    turn.seq = seq;
    turn.state = 'pending';
    turn.text = '';
    turn.citations = [];
    turn.fail = null;
    turn.usage = null;
    turn.costUsd = null;
    view = 'pending';
    offReason = '';
    startedAt = Date.now();
    clearTimers();
    ticker = setInterval(function () { if (view === 'pending' || (view === 'streaming' && !(latest() || {}).text)) schedule(); }, 1000);
    arm(cfg.noReplyMs, noReply);
    say(LINE, { q: turn.q, seq: turn.seq, mode: turn.mode, history: turn.history });
    schedule();
  }

  function ask(q, mode, history) {
    var text = String(q || '').replace(/\s+/g, ' ').trim();
    if (!text) return false;
    cancelInFlight();
    var turn = { q: text, mode: mode, history: history || [] };
    turns = [turn];
    expanded = false;
    send(turn);
    return true;
  }

  function retry() {
    var t = latest();
    if (!t) { ask(query, 'ask', []); return; }
    cancelInFlight();
    send(t);
  }

  function deeper() {
    var t = latest();
    if (!t || view !== 'done') return;
    t.mode = 'deep';
    expanded = true;
    send(t);
  }

  function followUp() {
    var text = String(els.input.value || '').replace(/\s+/g, ' ').trim();
    if (!text) { els.input.focus(); return; }
    if (view === 'pending' || view === 'streaming') return;
    cancelInFlight();
    var history = historyBefore(turns.length);
    els.input.value = '';
    expanded = true;
    turns.push({ q: text, mode: 'ask', history: history, followUp: true });
    send(latest());
  }

  /** The request in flight, if any, is told to stop (a new ask, a new search, leaving the page). */
  function cancelInFlight() {
    var t = latest();
    if (t && (t.state === 'pending' || t.state === 'streaming' || t.state === 'stopping') && t.seq) {
      say(STOP_LINE, { seq: t.seq });
      t.state = t.text ? 'stopped' : 'gone';
    }
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  }

  function stop(why) {
    var t = latest();
    if (!t || !(t.state === 'pending' || t.state === 'streaming')) return false;
    say(STOP_LINE, { seq: t.seq });
    t.state = 'stopping';
    clearTimers();
    if (stopTimer) clearTimeout(stopTimer);
    // main answers a stop with fail/stopped; if it does not, the page stops on its own.
    stopTimer = setTimeout(function () {
      stopTimer = null;
      if (t.state === 'stopping') finishStopped(t, why === 'leave' ? 'Stopped when you left the page.' : 'Stopped.');
    }, cfg.stopGraceMs);
    schedule();
    return true;
  }

  function finishStopped(t, note) {
    clearTimers();
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    t.state = 'stopped';
    t.stopNote = note || 'Stopped.';
    view = 'stopped';
    schedule();
  }

  function noReply() {
    var t = latest();
    if (!t || !(t.state === 'pending' || t.state === 'streaming')) return;
    say(STOP_LINE, { seq: t.seq });
    var quiet = t.state === 'streaming';
    t.state = 'fail';
    t.fail = quiet
      ? { state: 'stalled', title: 'The answer stopped arriving', detail: 'Nothing more came from Claude for ' + Math.round(cfg.stallMs / 1000) + ' seconds, so Quartz stopped waiting. What arrived is kept above.', retry: true, settings: false }
      : { state: 'no-reply', title: 'Quartz did not answer', detail: 'No reply from Quartz\'s Claude side in ' + Math.round(cfg.noReplyMs / 1000) + ' seconds. This build may not have Claude answers yet; restarting Quartz picks up a newer one.', retry: true, settings: false };
    view = 'fail';
    clearTimers();
    schedule();
  }

  function openSettings() { console.log('quartz-search:settings {}'); }

  function plainOf(turn) {
    var lines = [];
    var text = String(turn.text || '').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1');
    lines.push(text.trim());
    var cites = Array.isArray(turn.citations) ? turn.citations : [];
    var src = [];
    for (var i = 0; i < cites.length; i++) {
      var href = webHref(cites[i] && cites[i].url);
      if (href) src.push('[' + cites[i].n + '] ' + (cites[i].title ? cites[i].title + ' — ' : '') + href);
    }
    if (src.length) lines.push('', 'Sources:', src.join('\n'));
    return lines.join('\n');
  }

  function copy() {
    var parts = [];
    for (var i = 0; i < turns.length; i++) {
      if (!turns[i].text) continue;
      if (i > 0) parts.push('Q: ' + turns[i].q);
      parts.push(plainOf(turns[i]));
    }
    var text = parts.join('\n\n');
    var done = function (ok) {
      els.copy.textContent = ok ? 'Copied' : 'Copy failed: select the text instead';
      els.copy.setAttribute('data-copied', ok ? 'yes' : 'no');
      setTimeout(function () { els.copy.textContent = 'Copy'; els.copy.removeAttribute('data-copied'); }, ok ? 1600 : 4000);
    };
    var fallback = function () {
      var ta = el('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      ta.remove();
      done(ok);
    };
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
        return;
      }
    } catch (err) { /* fall through */ }
    fallback();
  }

  /* ---------------------------------------------------------- main's answers */

  window.__applyAnswer = function (obj) {
    if (!obj || typeof obj !== 'object' || typeof obj.seq !== 'number' || obj.seq !== seq) return false;
    var t = latest();
    if (!t || t.seq !== obj.seq) return false;
    if (t.state === 'stopped' || t.state === 'done' || t.state === 'fail' || t.state === 'gone') return false;
    var phase = obj.phase;
    if (t.state === 'stopping' && !(phase === 'fail' || phase === 'done')) return false;
    if (phase === 'start') {
      if (typeof obj.model === 'string') model = obj.model.slice(0, 80);
      t.state = 'streaming';
      view = 'streaming';
      arm(cfg.stallMs, noReply);
    } else if (phase === 'delta') {
      if (typeof obj.text !== 'string') return false;
      t.text += obj.text;
      t.state = 'streaming';
      view = 'streaming';
      arm(cfg.stallMs, noReply);
    } else if (phase === 'done') {
      clearTimers();
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
      if (typeof obj.text === 'string' && obj.text) t.text = obj.text;
      t.citations = Array.isArray(obj.citations) ? obj.citations.slice(0, 40) : [];
      t.usage = obj.usage && typeof obj.usage === 'object' ? obj.usage : null;
      t.costUsd = typeof obj.costUsd === 'number' ? obj.costUsd : null;
      if (!t.text) {
        t.state = 'fail';
        t.fail = { state: 'bad-answer', title: 'Claude sent an empty answer', detail: 'The answer finished with no text in it.', retry: true, settings: false };
        view = 'fail';
      } else {
        t.state = 'done';
        view = 'done';
      }
    } else if (phase === 'fail') {
      clearTimers();
      if (obj.state === 'stopped') {
        finishStopped(t, typeof obj.title === 'string' && obj.title ? obj.title.replace(/\.?$/, '.') : 'Stopped.');
        return true;
      }
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
      t.state = 'fail';
      t.fail = {
        state: String(obj.state || 'unknown').slice(0, 40),
        title: typeof obj.title === 'string' ? obj.title.slice(0, 200) : '',
        detail: typeof obj.detail === 'string' ? obj.detail.slice(0, 1200) : '',
        retry: obj.retry === true,
        settings: obj.settings === true,
      };
      view = 'fail';
    } else if (phase === 'off') {
      clearTimers();
      var reason = obj.reason === 'no-key' || obj.reason === 'manual' ? obj.reason : 'not-question';
      if (turns.length === 1 && (t.mode === 'auto' || reason === 'no-key')) {
        // The automatic answer is off for this search: the quiet row says how to get one.
        offReason = reason;
        t.state = 'gone';
        turns = [];
        view = 'off';
      } else {
        // Something the user asked for was turned away: never just drop it, say why.
        t.state = 'fail';
        t.fail = reason === 'no-key'
          ? { state: 'no-key', title: 'No Claude API key', detail: 'Add a Claude API key in Settings for answers.', retry: true, settings: true }
          : { state: 'off', title: 'Claude did not take this', detail: reason === 'manual' ? 'Quartz answered that Claude answers are switched off in Settings.' : 'Quartz judged this not to be a question for Claude.', retry: true, settings: reason === 'manual' };
        view = 'fail';
      }
    } else {
      return false;
    }
    schedule();
    return true;
  };

  /** For the e2e: what the panel is showing, in plain values. */
  window.__answerState = function () {
    var t = latest();
    var vis = function (n) { return !!(n && !n.hidden && n.getClientRects().length); };
    return {
      view: view, seq: seq, offReason: offReason, model: model, modelLabel: els.model ? els.model.textContent : '',
      turns: turns.length,
      turnState: t ? t.state : null,
      text: t ? t.text : '',
      bodyText: root ? (root.querySelector('.qa-turn:last-child .qa-body') || {}).textContent || '' : '',
      fail: t && t.fail ? { state: t.fail.state, title: t.fail.title, detail: t.fail.detail } : null,
      cites: root ? root.querySelectorAll('a.qa-cite').length : 0,
      pendingCites: root ? root.querySelectorAll('.qa-cite.is-pending').length : 0,
      sources: root ? root.querySelectorAll('.qa-source').length : 0,
      skeleton: root ? root.querySelectorAll('.qa-skel').length : 0,
      controls: {
        stop: vis(els.stop), copy: vis(els.copy), deeper: vis(els.deeper), more: vis(els.more), follow: vis(els.follow),
        retry: root ? !!root.querySelector('.qa-act-retry') : false,
        settings: root ? !!root.querySelector('.qa-act-settings') : false,
        ask: root ? !!root.querySelector('.qa-act-ask') : false,
      },
      offText: els.off ? els.off.textContent : '',
      status: els.status ? els.status.textContent : '',
      hidden: root ? root.hidden : true,
      sent: sent.slice(),
    };
  };

  /** For the e2e: shorter watchdogs. */
  window.__answerConfig = function (o) {
    if (o && typeof o === 'object') {
      if (o.noReplyMs > 0) cfg.noReplyMs = o.noReplyMs;
      if (o.stallMs > 0) cfg.stallMs = o.stallMs;
      if (o.stopGraceMs > 0) cfg.stopGraceMs = o.stopGraceMs;
    }
    return Object.assign({}, cfg);
  };

  /* ---------------------------------------------------------- the page's handle */

  window.QuartzAnswer = {
    /** A web search loaded (All, first page): the automatic answer. */
    begin: function (q) {
      query = String(q || '').replace(/\s+/g, ' ').trim();
      if (!root && !build()) return false;
      if (!query) { view = 'idle'; schedule(); return false; }
      return ask(query, 'auto', []);
    },
    /** Not on this view (News, Videos, page 2+): nothing shows. */
    hide: function () { if (!root) build(); view = 'idle'; if (root) root.hidden = true; },
    stop: function () { return stop('button'); },
    focusFollowUp: function () { if (els.input && !els.follow.hidden) { els.input.focus(); return true; } return false; },
    isTyping: function () { return document.activeElement === els.input; },
  };

  /* Back / Forward / a new search all leave this document: the answer in flight is stopped.
     A page restored from the back-forward cache says what happened to it. */
  window.addEventListener('pagehide', function () {
    var t = latest();
    if (t && (t.state === 'pending' || t.state === 'streaming' || t.state === 'stopping')) {
      say(STOP_LINE, { seq: t.seq });
      t.leftMidway = true;
    }
  });
  window.addEventListener('pageshow', function (e) {
    var t = latest();
    if (e.persisted && t && t.leftMidway) {
      t.leftMidway = false;
      finishStopped(t, 'Stopped when you left the page.');
    }
  });
  window.addEventListener('resize', function () { if (root && !root.hidden) measure(); });
})();
