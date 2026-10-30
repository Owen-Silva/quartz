'use strict';
/*
 * closetabs.js -- closing tabs by address, asked for on the command line.
 *
 *   Quartz.exe <app dir> --close-tabs=http://localhost:4830/ --keep=http://localhost:4830/demo/
 *
 * A tool that opens preview tabs (by launching Quartz with a URL, which the
 * 'second-instance' handler in main.js turns into a tab) had no way to close
 * them again, so stale localhost tabs piled up. This is the other half, sent
 * the same way: a second launch whose command line carries the switches below
 * hands them to the copy already running, which closes the tabs and says what
 * it did. Pure functions; nothing here talks to Electron, the DOM or the disk.
 *
 *   --close-tabs=<prefix>  every tab whose address starts with <prefix> closes.
 *                          Repeatable; a tab matching any of them counts.
 *   --keep=<prefix>        ...except a tab whose address starts with this.
 *                          Repeatable.
 *
 * The rules, every one of them enforced here and checked by closetabs-harness.js:
 *   - A prefix is an http:// or https:// address with at least a host. An empty
 *     value, a bare scheme ("http://"), a wildcard ("*") or any other scheme is
 *     refused, with the reason, and then NOTHING on that command line happens:
 *     not the close, and not a link on the same line either (the usual slip,
 *     "--close-tabs http://x/" with a space, would otherwise OPEN the very tab
 *     it meant to close).
 *   - A prefix is compared in its canonical form (new URL().href), so the host
 *     is lower-case and a prefix with no path gains its "/": "http://localhost:4830"
 *     closes http://localhost:4830/x and never http://localhost:48300/.
 *   - Only plain web pages close: a page tab on http(s). Pinned tabs, Claude
 *     and terminal tabs, hosted apps, catalogue app tabs and Quartz's own pages
 *     (new tab, history, files, the phone page: all file: URLs) are left alone.
 *   - No workspace is ever emptied, so the window is never left without a tab
 *     and nothing has to be opened in its place: when every tab of a workspace
 *     would close, the one in front of it stays.
 *   - A command line carrying only these switches never opens a tab or a
 *     window and never raises or focuses the one that exists (commandPlan).
 *
 * Loads two ways, like drm-sites.js:
 *   - require('./closetabs.js') in main and in the harness (module.exports)
 *   - <script src="closetabs.js"> in the chrome (window.CloseTabs)
 */
(function () {
  var CLOSE_SWITCH = '--close-tabs';
  var KEEP_SWITCH = '--keep';
  var EXAMPLE = 'http://localhost:4830/';
  // A refusal or a log line quotes what it was given, never a page of it.
  var QUOTE_MAX = 200;

  function quote(text) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ');
    return s.length > QUOTE_MAX ? s.slice(0, QUOTE_MAX) + '...' : s;
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  /**
   * The value of one switch in one argument: undefined when the argument is
   * not that switch, null when it is the switch with no "=" at all, else the
   * text after the first "=" (which may be empty). Chromium lower-cases switch
   * NAMES on Windows (never their values), so the name compares either way.
   */
  function switchValue(arg, name) {
    var lower = arg.toLowerCase();
    if (lower === name) return null;
    if (lower.indexOf(name + '=') === 0) return arg.slice(name.length + 1);
    return undefined;
  }

  /**
   * One prefix, checked: { ok: true, prefix } with the prefix in canonical
   * form, or { ok: false, reason } in plain words that name the switch.
   */
  function checkPrefix(raw, flag) {
    var name = flag || CLOSE_SWITCH;
    var text = String(raw == null ? '' : raw).trim();
    var shown = name + '=' + quote(text);
    if (!text) {
      return { ok: false, reason: name + ' is empty; give it an address prefix such as ' + name + '=' + EXAMPLE };
    }
    if (text.indexOf('*') !== -1) {
      return { ok: false, reason: shown + ' is refused: wildcards are not supported; give an address prefix such as ' + EXAMPLE };
    }
    // The authority is read from the text itself, not from new URL(): the URL
    // parser turns "http:///x" into http://x/, which would close every tab on
    // a host the caller never named.
    var m = /^(https?):\/\/([^\/?#\\\s]*)/i.exec(text);
    if (!m) {
      return { ok: false, reason: shown + ' is refused: only http:// and https:// addresses can be closed this way' };
    }
    if (!m[2]) {
      return { ok: false, reason: shown + ' is refused: it names no host; a prefix needs at least a scheme and a host, such as ' + EXAMPLE };
    }
    var u = null;
    try { u = new URL(text); } catch (err) { u = null; }
    if (!u) return { ok: false, reason: shown + ' is refused: it is not a valid address' };
    if (!u.hostname || !/[a-z0-9]/i.test(u.hostname)) {
      return { ok: false, reason: shown + ' is refused: it names no host; a prefix needs at least a scheme and a host, such as ' + EXAMPLE };
    }
    return { ok: true, prefix: u.href };
  }

  function unique(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (out.indexOf(list[i]) === -1) out.push(list[i]);
    return out;
  }

  /**
   * The close request on a command line, or null when it carries neither
   * switch (the line is then nobody's business here).
   *   { ok: true,  close: [prefix...], keep: [prefix...] }
   *   { ok: false, reason, reasons: [...] }   -- refused; nothing on the line runs
   * Works on any argv shape: Chromium moves switches in front of the loose
   * arguments, and adds its own, before 'second-instance' sees the line.
   */
  function requestFromArgv(argv) {
    var args = Array.isArray(argv) ? argv : [];
    var close = [];
    var keep = [];
    var refused = [];
    var any = false;
    for (var i = 0; i < args.length; i++) {
      var arg = String(args[i] == null ? '' : args[i]).trim();
      // Chromium's own rule: nothing after a bare "--" is a switch.
      if (arg === '--') break;
      var pairs = [[CLOSE_SWITCH, close], [KEEP_SWITCH, keep]];
      for (var p = 0; p < pairs.length; p++) {
        var name = pairs[p][0];
        var v = switchValue(arg, name);
        if (v === undefined) continue;
        any = true;
        if (v === null) {
          refused.push(name + ' has no address after it; write it with "=", as ' + name + '=' + EXAMPLE);
        } else {
          var c = checkPrefix(v, name);
          if (c.ok) pairs[p][1].push(c.prefix);
          else refused.push(c.reason);
        }
        break;
      }
    }
    if (!any) return null;
    if (!refused.length && !close.length) {
      refused.push(KEEP_SWITCH + ' on its own closes nothing; add ' + CLOSE_SWITCH + '=<prefix>');
    }
    if (refused.length) {
      return {
        ok: false,
        reason: refused[0] + (refused.length > 1 ? ' (and ' + plural(refused.length - 1, 'more problem', 'more problems') + ')' : ''),
        reasons: refused,
      };
    }
    return { ok: true, close: unique(close), keep: unique(keep) };
  }

  /**
   * What a launch with this command line does in the copy that is running.
   *   request  requestFromArgv(argv)
   *   url      urlFromArgv(argv) (argvurl.js), which never reads a switch
   * -> { close: request|null, url: string|null, raise: boolean }
   * raise is whether the window comes to the front: as it always has for a link
   * or a bare second launch, and never for a close on its own.
   */
  function commandPlan(request, url) {
    var link = url || null;
    if (!request) return { close: null, url: link, raise: true };
    if (request.ok !== true) return { close: request, url: null, raise: false };
    return { close: request, url: link, raise: !!link };
  }

  /** An address in the form prefixes are kept in; a string that is not a URL stays as it is. */
  function canonical(url) {
    var s = String(url == null ? '' : url);
    try { return new URL(s).href; } catch (err) { return s; }
  }

  function startsWithAny(url, prefixes) {
    if (!url) return false;
    var href = canonical(url);
    for (var i = 0; i < prefixes.length; i++) if (href.indexOf(prefixes[i]) === 0) return true;
    return false;
  }

  /**
   * Why this tab must not be closed by a command, or '' when it may be.
   * row: { kind, url, pinned, app, kept } -- app is a catalogue app tab, kept
   * the tab the Phone workspace holds on to.
   *   'pinned' | 'not-web'
   */
  function refusalFor(row) {
    if (!row) return 'not-web';
    if (row.pinned) return 'pinned';
    if (row.kind !== 'page' || row.app || row.kept) return 'not-web';
    if (!/^https?:\/\//i.test(String(row.url || ''))) return 'not-web';
    return '';
  }

  /**
   * Which tabs a request closes, and in what order.
   *   rows     every tab in the window, in strip order:
   *            { id, kind, url, pinned, app, kept, workspace }
   *   request  requestFromArgv()'s answer (re-checked here: a plan never acts
   *            on a prefix checkPrefix would refuse)
   *   ctx      { activeId, lastActive: { [workspace]: tabId } }
   * -> { ok: true, close: [id...], matched, kept, pinned, notWeb, spared, prefixes, keep }
   *    { ok: false, reason }
   * `close` puts the tab in front LAST, so closing it hands the front to a tab
   * that stays rather than waking a doomed neighbour on the way out.
   */
  function planClose(rows, request, ctx) {
    if (!request || request.ok !== true) {
      return { ok: false, reason: (request && request.reason) || 'the request was empty' };
    }
    var close = [];
    var keep = [];
    var list = Array.isArray(request.close) ? request.close : [];
    for (var i = 0; i < list.length; i++) {
      var c = checkPrefix(list[i], CLOSE_SWITCH);
      if (!c.ok) return { ok: false, reason: c.reason };
      close.push(c.prefix);
    }
    var keeps = Array.isArray(request.keep) ? request.keep : [];
    for (var k = 0; k < keeps.length; k++) {
      var kc = checkPrefix(keeps[k], KEEP_SWITCH);
      if (!kc.ok) return { ok: false, reason: kc.reason };
      keep.push(kc.prefix);
    }
    if (!close.length) return { ok: false, reason: 'no ' + CLOSE_SWITCH + ' prefix was given' };

    var context = ctx || {};
    var activeId = context.activeId;
    var lastActive = context.lastActive || {};
    var tabsIn = Array.isArray(rows) ? rows.filter(Boolean) : [];
    var out = { ok: true, close: [], matched: 0, kept: 0, pinned: 0, notWeb: 0, spared: 0, prefixes: unique(close), keep: unique(keep) };
    var doomed = {};

    for (var r = 0; r < tabsIn.length; r++) {
      var row = tabsIn[r];
      if (!startsWithAny(row.url, close)) continue;
      out.matched++;
      var why = refusalFor(row);
      if (why === 'pinned') { out.pinned++; continue; }
      if (why) { out.notWeb++; continue; }
      if (startsWithAny(row.url, keep)) { out.kept++; continue; }
      doomed[row.id] = true;
    }

    // No workspace empties (and so neither does the window): when all of one
    // workspace's tabs are doomed, the one in front of it stays -- the tab on
    // screen, else the one that workspace last showed, else its last tab.
    var groups = {};
    var order = [];
    for (var g = 0; g < tabsIn.length; g++) {
      var ws = String(tabsIn[g].workspace == null ? '' : tabsIn[g].workspace);
      if (!groups[ws]) { groups[ws] = []; order.push(ws); }
      groups[ws].push(tabsIn[g]);
    }
    for (var o = 0; o < order.length; o++) {
      var group = groups[order[o]];
      var all = group.every(function (t) { return doomed[t.id] === true; });
      if (!all) continue;
      var spare = group.find(function (t) { return t.id === activeId; })
        || group.find(function (t) { return t.id === lastActive[order[o]]; })
        || group[group.length - 1];
      delete doomed[spare.id];
      out.spared++;
    }

    for (var d = 0; d < tabsIn.length; d++) {
      if (doomed[tabsIn[d].id] === true && tabsIn[d].id !== activeId) out.close.push(tabsIn[d].id);
    }
    if (doomed[activeId] === true) out.close.push(activeId);
    return out;
  }

  /** What stayed open, as a list of short phrases (empty when nothing matched and stayed). */
  function leftOpen(plan) {
    var bits = [];
    if (plan.kept) bits.push(plan.kept + ' kept by ' + KEEP_SWITCH);
    if (plan.pinned) bits.push(plan.pinned + ' pinned');
    if (plan.notWeb) bits.push(plural(plan.notWeb, 'not a plain web page', 'not plain web pages'));
    if (plan.spared) bits.push(plan.spared + ' left as the last tab');
    return bits;
  }

  function prefixWords(plan) {
    return quote((plan.prefixes || []).join(', '));
  }

  /** The toast: a couple of seconds, so short. */
  function toastText(plan, extra) {
    if (!plan || plan.ok !== true) {
      return "Didn't close any tabs: " + ((plan && plan.reason) || 'the request was refused') + (extra ? '. ' + extra : '');
    }
    var n = (plan.close || []).length;
    var bits = leftOpen(plan);
    if (!n && !plan.matched) return 'No open tabs start with ' + prefixWords(plan);
    var head = n ? 'Closed ' + plural(n, 'tab', 'tabs') : 'Closed no tabs';
    return head + (bits.length ? ' (' + bits.join(', ') + ')' : '');
  }

  /** The quartz.log line: a sentence, as log-e2e expects of every line. */
  function logText(plan) {
    if (!plan || plan.ok !== true) {
      return 'Refused to close tabs from the command line: ' + ((plan && plan.reason) || 'the request was refused') + '.';
    }
    var n = (plan.close || []).length;
    var bits = leftOpen(plan);
    if (!n && !plan.matched) {
      return 'Closing tabs from the command line found none starting with ' + prefixWords(plan) + '.';
    }
    return 'Closed ' + plural(n, 'tab', 'tabs') + ' starting with ' + prefixWords(plan) + ', asked for on the command line'
      + (bits.length ? '; left open: ' + bits.join(', ') : '') + '.';
  }

  /** The second launch's own console line, so the caller hears something at once. */
  function handedText(request) {
    if (!request || request.ok !== true) return '[close-tabs] refused: ' + ((request && request.reason) || 'no reason given');
    return '[close-tabs] handed to the Quartz already running: close ' + request.close.join(', ')
      + (request.keep.length ? '; keep ' + request.keep.join(', ') : '')
      + '. The result shows as a toast in that window and a line in quartz.log.';
  }

  var API = {
    CLOSE_SWITCH: CLOSE_SWITCH,
    KEEP_SWITCH: KEEP_SWITCH,
    checkPrefix: checkPrefix,
    requestFromArgv: requestFromArgv,
    commandPlan: commandPlan,
    refusalFor: refusalFor,
    planClose: planClose,
    toastText: toastText,
    logText: logText,
    handedText: handedText,
    _canonical: canonical
  };

  if (typeof module === 'object' && module && module.exports) module.exports = API;
  if (typeof window !== 'undefined' && window) window.CloseTabs = API;
})();
