'use strict';
/*
 * secret-store-harness.js -- the API keys at rest (secret-store.js), in plain node with a FAKE
 * safeStorage. Covers the slot itself and its three owners (bravesearch.js, stocks.js,
 * watch-main.js) against real files in a temp folder:
 *   - a fresh save + read round trip (the file holds the Enc field, never the key);
 *   - an older plain-text file migrated once (the plain key is gone from disk afterwards);
 *   - encryption unavailable (false, or it throws): the key still works, kept in plain text, and
 *     the status says "stored unencrypted: <reason>";
 *   - a corrupt blob: the status says so, no key is used, the blob is kept until replaced, and a
 *     log line is written;
 *   - a blob read while encryption is not ready yet is read once it is;
 *   - the renderer-facing status / describe() never contains the raw key, in any state.
 * Ends with `secret-store: N passed, M failed`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const SecretStore = require('./secret-store');

let passed = 0;
let failed = 0;
function check(ok, name, extra) {
  if (ok) { passed += 1; return; }
  failed += 1;
  console.log('FAIL ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
}

/* A fake safeStorage: the "ciphertext" is a marked, byte-reversed copy, so the key's text never
   appears in it; anything without the mark fails to decrypt, the way DPAPI does for another account. */
function fakeSafe(opts) {
  const o = opts || {};
  const s = {
    available: o.available !== false,
    throwAvail: !!o.throwAvail,
    calls: { enc: 0, dec: 0 },
    isEncryptionAvailable() {
      if (s.throwAvail) throw new Error('keyring locked');
      return s.available;
    },
    encryptString(text) {
      s.calls.enc += 1;
      if (!s.available) throw new Error('Encryption is not available.');
      return Buffer.concat([Buffer.from('FAKE1:'), Buffer.from(String(text), 'utf8').reverse()]);
    },
    decryptString(buf) {
      s.calls.dec += 1;
      const b = Buffer.from(buf);
      if (b.slice(0, 6).toString() !== 'FAKE1:') throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return Buffer.from(b.slice(6)).reverse().toString('utf8');
    },
  };
  return s;
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'secret-store-')); }
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
// A documented fake, built so it reads as one: long enough to be masked to its last four.
const KEY = ['fixture', 'not', 'a', 'real', 'key', 'XYZW'].join('-');
const noRaw = (obj, key) => JSON.stringify(obj).indexOf(key || KEY) === -1;

/* ------------------------------------------------------------ the slot on its own */
(function slotTests() {
  const logs = [];
  const fake = fakeSafe();
  const slot = SecretStore.create({ field: 'key', label: 'Test key', safeStorage: fake, log: (l) => logs.push(l) });

  // Fresh: nothing saved.
  let r = slot.load({});
  check(!r.rewrite && slot.get() === '' && slot.status().keyStorage === 'none' && !slot.status().hasKey, 'slot: an empty file holds no key', slot.status());

  // Save + read round trip.
  slot.set(KEY);
  const f = slot.fields();
  check(typeof f.keyEnc === 'string' && f.keyEnc && !('key' in f), 'slot: a new key is written as keyEnc only', Object.keys(f));
  check(Buffer.from(f.keyEnc, 'base64').toString('utf8').indexOf(KEY) === -1 && f.keyEnc.indexOf(KEY) === -1, 'slot: the blob does not contain the key');
  slot.wrote(true);
  const st = slot.status();
  check(st.hasKey && st.keyStorage === 'encrypted' && st.keyStorageNote === '' && st.keyError === '' && st.keyMask === '••••' + KEY.slice(-4), 'slot: status after save', st);
  check(noRaw(st), 'slot: status never carries the key (encrypted)');
  const again = SecretStore.create({ field: 'key', label: 'Test key', safeStorage: fake });
  r = again.load(JSON.parse(JSON.stringify(f)));
  check(!r.rewrite && again.get() === KEY && again.status().keyStorage === 'encrypted', 'slot: round trip: a fresh slot reads the same key back', again.status());

  // Clearing.
  slot.set('');
  check(Object.keys(slot.fields()).length === 0 && slot.get() === '', 'slot: clearing leaves no field to write');

  // A function for safeStorage (resolved on each use) and a missing one (null).
  const viaFn = SecretStore.create({ field: 'k', safeStorage: () => fake });
  viaFn.set('abcdefghijkl'); viaFn.wrote(true);
  check(viaFn.status().keyStorage === 'encrypted', 'slot: safeStorage may be a function');
  const none = SecretStore.create({ field: 'k', safeStorage: null });
  none.set('abcdefghijkl'); none.wrote(true);
  check(none.get() === 'abcdefghijkl' && none.fields().k === 'abcdefghijkl' && /^stored unencrypted: /.test(none.status().keyStorageNote) &&
    /not available in this build/.test(none.status().keyStorageNote), 'slot: no safeStorage at all: plain text, and says why', none.status());

  // Both forms in one file: the encrypted one wins and the plain one is dropped.
  const both = SecretStore.create({ field: 'key', safeStorage: fake });
  r = both.load({ key: 'plain-old-value-1234', keyEnc: f.keyEnc });
  check(r.rewrite && both.get() === KEY && !('key' in both.fields()), 'slot: a file with both forms keeps the encrypted key and drops the plain one');

  // A failed migration write is said, not hidden.
  const mig = SecretStore.create({ field: 'key', safeStorage: fake });
  r = mig.load({ key: KEY });
  mig.wrote(false);
  check(r.rewrite && mig.status().keyStorage === 'unencrypted' && /could not be rewritten/.test(mig.status().keyStorageNote) && noRaw(mig.status()),
    'slot: a migration whose write fails still says the key is unencrypted, and why', mig.status());
  mig.wrote(true);
  check(mig.status().keyStorage === 'encrypted' && mig.status().keyStorageNote === '', 'slot: the next good write makes it encrypted');

  // Throwing isEncryptionAvailable.
  const thrower = fakeSafe({ throwAvail: true });
  const t = SecretStore.create({ field: 'key', safeStorage: thrower });
  t.set(KEY); t.wrote(true);
  check(t.get() === KEY && t.fields().key === KEY && /keyring locked/.test(t.status().keyStorageNote) && noRaw(t.status()),
    'slot: isEncryptionAvailable() throwing: works, plain, the reason is said', t.status());

  // A blob saved while encryption is not ready yet is read once it is.
  const late = fakeSafe({ available: false });
  const p = SecretStore.create({ field: 'key', safeStorage: late, log: () => {} });
  p.load({ keyEnc: f.keyEnc });
  check(p.get() === '' && /not available right now/.test(p.status().keyError), 'slot: a blob before encryption is ready: no key yet, and it says why', p.status());
  check(p.fields().keyEnc === f.keyEnc, 'slot: that blob is kept, not dropped');
  late.available = true;
  check(p.get() === KEY && p.status().keyError === '' && p.status().hasKey, 'slot: once encryption is ready the same slot reads the key');

  check(logs.length === 0 || logs.every((l) => l.indexOf(KEY) === -1), 'slot: no log line carries the key', logs);
})();

/* ------------------------------------------------------------ bravesearch.js */
(function braveTests() {
  const Brave = require('./bravesearch');
  const mk = (dir, safe, logs) => Brave.create({
    storePath: () => path.join(dir, 'brave-search.json'), safeStorage: safe,
    keyLog: (l) => logs.push(l), log: () => {}, fetch: () => Promise.reject(new Error('no network in this harness')),
  });

  // Fresh save + read.
  let dir = tmpDir();
  let logs = [];
  const fake = fakeSafe();
  let b = mk(dir, fake, logs);
  let d = b.setKey(KEY);
  const file = path.join(dir, 'brave-search.json');
  let disk = fs.readFileSync(file, 'utf8');
  check(d.hasKey && d.keyStorage === 'encrypted' && !d.keyStorageNote && !d.keyError, 'brave: save: encrypted', d);
  check(disk.indexOf(KEY) === -1 && 'keyEnc' in readJson(file) && !('key' in readJson(file)), 'brave: save: the file holds keyEnc only, never the key');
  check(noRaw(d), 'brave: describe() never carries the key');
  b = mk(dir, fake, logs);
  d = b.describe();
  check(d.hasKey && d.keyMask.slice(-4) === KEY.slice(-4) && d.keyStorage === 'encrypted', 'brave: round trip: a new instance reads it back', d);

  // Migration of an older plain file.
  dir = tmpDir(); logs = [];
  fs.writeFileSync(path.join(dir, 'brave-search.json'), JSON.stringify({ key: KEY }));
  b = mk(dir, fake, logs);
  d = b.describe();
  disk = fs.readFileSync(path.join(dir, 'brave-search.json'), 'utf8');
  check(d.hasKey && d.keyStorage === 'encrypted' && noRaw(d), 'brave: migrate: the key still works and reads as encrypted', d);
  check(disk.indexOf(KEY) === -1 && !('key' in JSON.parse(disk)) && 'keyEnc' in JSON.parse(disk), 'brave: migrate: the plain key is gone from disk');
  check(logs.some((l) => /moved from plain text to encrypted/.test(l)) && logs.every((l) => l.indexOf(KEY) === -1), 'brave: migrate: logged, without the key', logs);

  // Unavailable: works, plain, reason said.
  dir = tmpDir(); logs = [];
  b = mk(dir, fakeSafe({ available: false }), logs);
  d = b.setKey(KEY);
  check(d.hasKey && !d.error && d.keyStorage === 'unencrypted' && /^stored unencrypted: .+/.test(d.keyStorageNote), 'brave: unavailable: kept, and Settings is told why', d);
  check(readJson(path.join(dir, 'brave-search.json')).key === KEY, 'brave: unavailable: stored in plain text as before');
  check(noRaw(d), 'brave: unavailable: describe() still never carries the key');
  // ...and the next start with encryption back migrates it.
  b = mk(dir, fake, logs);
  d = b.describe();
  check(d.keyStorage === 'encrypted' && fs.readFileSync(path.join(dir, 'brave-search.json'), 'utf8').indexOf(KEY) === -1, 'brave: unavailable then available: migrated on the next start', d);

  // Corrupt blob.
  dir = tmpDir(); logs = [];
  fs.writeFileSync(path.join(dir, 'brave-search.json'), JSON.stringify({ keyEnc: Buffer.from('not a real blob').toString('base64') }));
  b = mk(dir, fake, logs);
  d = b.describe();
  check(!d.hasKey && /could not be decrypted/.test(d.keyError) && /Paste the key again/.test(d.keyError), 'brave: corrupt: the status says so and asks again', d);
  check(logs.some((l) => /could not be decrypted/.test(l)), 'brave: corrupt: logged', logs);
  return b.search({ q: 'hello', kind: 'web', seq: 1 }).then((answer) => {
    check(answer.state === 'no-key' && /could not be read/.test(answer.title), 'brave: corrupt: the results page says the saved key could not be read', answer.title);
    b.setEnabled && b.setEnabled(true);
    // Saving anything else (here: nothing changed) keeps the blob; a new key replaces it.
    check('keyEnc' in readJson(path.join(dir, 'brave-search.json')), 'brave: corrupt: the blob is kept on disk, not silently dropped');
    d = b.setKey(KEY);
    check(d.hasKey && !d.keyError && d.keyStorage === 'encrypted', 'brave: corrupt: a new key replaces it', d);
    d = b.setKey('');
    check(!d.hasKey && !fs.existsSync(path.join(dir, 'brave-search.json')), 'brave: removing the key removes the file');
  });
})().then(stocksTests).then(watchTests).catch((err) => { failed += 1; console.log('FAIL harness threw: ' + (err && err.stack || err)); }).then(() => {
  console.log('secret-store: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
});

/* ------------------------------------------------------------ stocks.js */
function stocksTests() {
  const Stocks = require('./stocks');
  const mk = (dir, safe, logs) => Stocks.create({ app: { getPath: () => dir }, safeStorage: safe, keyLog: (l) => logs.push(l), log: () => {} });
  const fake = fakeSafe();
  let dir = tmpDir();
  let logs = [];
  const file = () => path.join(dir, 'stocks.json');

  // Migrate a plain file; other settings untouched.
  fs.writeFileSync(file(), JSON.stringify({ enabled: false, finnhubKey: KEY, symbols: ['AAPL', 'MSFT'], selected: 'MSFT' }));
  let s = mk(dir, fake, logs);
  let d = s.describe();
  let j = readJson(file());
  check(d.hasKey && d.keyStorage === 'encrypted' && noRaw(d), 'stocks: migrate: works, encrypted, describe() keyless', d);
  check(!('finnhubKey' in j) && typeof j.finnhubKeyEnc === 'string' && fs.readFileSync(file(), 'utf8').indexOf(KEY) === -1, 'stocks: migrate: the plain key is gone from stocks.json', j);
  check(j.enabled === false && j.symbols.join() === 'AAPL,MSFT' && j.selected === 'MSFT', 'stocks: migrate: the other settings are kept', j);
  s.stop && s.stop();

  // Round trip through a new instance.
  s = mk(dir, fake, logs);
  d = s.describe();
  check(d.hasKey && d.keyMask.slice(-4) === KEY.slice(-4), 'stocks: round trip', d);
  s.stop && s.stop();

  // Unavailable.
  dir = tmpDir();
  s = mk(dir, fakeSafe({ available: false }), logs);
  d = s.setKey(KEY);
  check(d.hasKey && /^stored unencrypted: /.test(d.keyStorageNote) && readJson(file()).finnhubKey === KEY && noRaw(d), 'stocks: unavailable: plain, and the reason is said', d);
  s.stop && s.stop();

  // Corrupt.
  dir = tmpDir(); logs = [];
  fs.writeFileSync(file(), JSON.stringify({ finnhubKeyEnc: 'AAAA', symbols: ['SPY'] }));
  s = mk(dir, fake, logs);
  d = s.describe();
  check(!d.hasKey && /could not be decrypted/.test(d.keyError) && logs.length > 0, 'stocks: corrupt: no key, the status says so, logged', d);
  s.setEnabled(false);
  check(readJson(file()).finnhubKeyEnc === 'AAAA', 'stocks: corrupt: another setting change keeps the blob');
  s.stop && s.stop();
}

/* ------------------------------------------------------------ watch-main.js (the TMDB key) */
function watchTests() {
  const WM = require('./watch-main');
  const TMDB = ['fixture', 'tmdb', 'not', 'real', '4321'].join('-');
  const mk = (dir, safe) => WM.create({
    dir, safeStorage: safe, bootGraceMs: 0, log: () => {}, send: () => {}, freeGb: () => 16,
    now: () => Date.parse('2026-10-19T20:00:00Z'),
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
    fetch: () => Promise.reject(new Error('offline')), runStep: () => Promise.reject(new Error('offline')),
    test: { gameRunning: () => '', windowShowing: () => true, saverOn: () => false },
  });
  const fake = fakeSafe();
  let dir = tmpDir();
  const file = () => path.join(dir, WM.PREFS_FILE || 'watch.json');

  // A v2 file with a plain key: migrated, everything else untouched.
  fs.writeFileSync(file(), JSON.stringify({ v: 2, enabled: { youtube: true }, leagues: ['nhl'], tmdbKey: TMDB, background: false, tilePreview: true }));
  let w = mk(dir, fake);
  let d = w.describe();
  let j = readJson(file());
  check(d.tmdb.hasKey && d.tmdb.keyStorage === 'encrypted' && noRaw(d, TMDB), 'watch: migrate: works, encrypted, describe() keyless', d.tmdb);
  check(!('tmdbKey' in j) && typeof j.tmdbKeyEnc === 'string' && fs.readFileSync(file(), 'utf8').indexOf(TMDB) === -1 && j.leagues.join() === 'nhl', 'watch: migrate: the plain key is gone from watch.json, leagues kept', j);
  w.stop && w.stop();

  // A legacy (pre-opt-in) file: its one rewrite must not copy the plain key through.
  dir = tmpDir();
  fs.writeFileSync(file(), JSON.stringify({ enabled: { youtube: true }, leagues: ['nfl'], tmdbKey: TMDB, somethingNewer: 1 }));
  w = mk(dir, fake);
  d = w.describe();
  j = readJson(file());
  check(d.tmdb.hasKey && j.v === 2 && !('tmdbKey' in j) && j.tmdbKeyEnc && j.somethingNewer === 1, 'watch: legacy rewrite: encrypted, unknown keys kept', j);
  w.stop && w.stop();

  // Round trip, then unavailable and corrupt.
  w = mk(dir, fake);
  check(w.describe().tmdb.hasKey, 'watch: round trip');
  w.stop && w.stop();
  dir = tmpDir();
  w = mk(dir, fakeSafe({ available: false }));
  d = w.setTmdbKey(TMDB);
  check(d.tmdb.hasKey && /^stored unencrypted: /.test(d.tmdb.keyStorageNote) && readJson(file()).tmdbKey === TMDB && noRaw(d, TMDB), 'watch: unavailable: plain, the reason is said', d.tmdb);
  w.stop && w.stop();
  dir = tmpDir();
  fs.writeFileSync(file(), JSON.stringify({ v: 2, tmdbKeyEnc: 'Zm9v' }));
  w = mk(dir, fake);
  d = w.describe();
  check(!d.tmdb.hasKey && /could not be decrypted/.test(d.tmdb.keyError), 'watch: corrupt: no key, the status says so', d.tmdb);
  w.setLeagues && w.setLeagues(['nhl']);
  check(readJson(file()).tmdbKeyEnc === 'Zm9v', 'watch: corrupt: a settings save keeps the blob');
  w.stop && w.stop();
}
