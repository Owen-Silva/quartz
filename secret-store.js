'use strict';
/*
 * secret-store.js -- one API key at rest, encrypted with Electron safeStorage.
 *
 * WHY. The keys the user pastes into Settings (Finnhub in stocks.json, Brave Search in
 * brave-search.json, TMDB in watch.json) used to sit in those files as plain text. Anything that
 * can read the profile folder (another program, a backup, a tool running with the user's rights)
 * could lift them. safeStorage is DPAPI on Windows: the bytes on disk can only be turned back
 * into the key by the same Windows account on the same machine. claudeanswer.js already keeps the
 * Claude key this way (and refuses to store it unencrypted); this module brings the same
 * protection to the other keys, with one difference: when encryption is not available these keys
 * are still kept (in plain text, as before), because a stocks tile or a search page that silently
 * forgets its key is worse than one that says plainly how it is stored.
 *
 * SHAPE ON DISK. Each owner module keeps its own JSON file and its own other settings; this module
 * only decides the key's field(s). For a field named `finnhubKey`:
 *   { "finnhubKeyEnc": "<base64 of safeStorage.encryptString(key)>" }   encrypted (the normal case)
 *   { "finnhubKey": "<key>" }                                            plain text (no encryption)
 * Never both. A file from an older build (plain `finnhubKey`) is MIGRATED the first time it is
 * read: the key is encrypted, the owner rewrites its file with only the Enc field, and the plain
 * field is gone from disk. If encryption is not available at that moment, the plain field stays
 * and the next start tries again.
 *
 * WHAT THE RENDERER SEES. status() is the only view that leaves main: hasKey, a mask (the last
 * four characters behind bullets, or all bullets for a short key), where the key is stored, and,
 * in plain words, why it is unencrypted or why a saved key cannot be read. It never carries the
 * key. get() is main-process only: the owner uses it to make its own requests.
 *
 * FAILURES ARE SAID, NEVER SWALLOWED.
 *   - Encryption unavailable (isEncryptionAvailable() false, safeStorage missing, or it throws):
 *     the key is stored in plain text and status().keyStorageNote reads
 *     "stored unencrypted: <reason>" for Settings to show beside the field.
 *   - A saved blob that will not decrypt (another Windows account, a reset profile, a damaged
 *     file): get() returns '' (no key is used), status().keyError says the saved key could not be
 *     read and asks for it again, and the blob is KEPT on disk (never silently dropped) until the
 *     user pastes a new key or clears it. Logged once via the owner's log (quartz.log).
 *   - A saved blob while encryption is not available yet: same message, and every get() / status()
 *     tries again, so a key read before the platform is ready is not lost for the session.
 *
 * TESTS: create({ safeStorage }) takes a fake (see secret-store-harness.js); a function is also
 * accepted, called on each use. Without one it requires Electron's safeStorage lazily, so this file
 * loads in plain node.
 */

function defaultMask(key) {
  const s = String(key == null ? '' : key);
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return '••••' + s.slice(-4);
}

function defaultClean(raw) {
  return String(raw == null ? '' : raw).trim();
}

function errWords(err) {
  const m = err && (err.message || err.code) ? String(err.message || err.code) : String(err || 'unknown error');
  return m.replace(/\s+/g, ' ').trim().slice(0, 160) || 'unknown error';
}

/**
 * create({ field, label, safeStorage, log, clean, mask }) -> a slot for one key.
 *   field   the JSON field name of the plain-text form (the Enc form is field + 'Enc')
 *   label   how the key is named to the user ("Brave Search key")
 */
function create(opts) {
  const o = opts || {};
  const field = String(o.field || 'key');
  const encField = field + 'Enc';
  const label = String(o.label || 'API key');
  const clean = typeof o.clean === 'function' ? o.clean : defaultClean;
  const mask = typeof o.mask === 'function' ? o.mask : defaultMask;
  const log = typeof o.log === 'function' ? o.log : () => {};

  const safe = () => {
    if (typeof o.safeStorage === 'function') { try { return o.safeStorage() || null; } catch { return null; } }
    if (o.safeStorage) return o.safeStorage;
    if (o.safeStorage === null) return null;
    try { return require('electron').safeStorage || null; } catch { return null; }
  };

  let value = '';          // the key, decrypted: main process only
  let blob = '';           // base64 ciphertext: what an encrypted save writes
  let onDisk = 'none';     // 'none' | 'encrypted' | 'plain': what the file holds now
  let plainReason = '';    // why the key is (or would be) stored in plain text
  let error = '';          // a saved key that cannot be read, in the user's words
  let pending = false;     // a blob is saved but encryption was not available to read it
  let migrating = false;   // load() asked the owner to rewrite its file to drop the plain field

  /** { ok: true } or { ok: false, reason } in plain words. */
  function availability() {
    const s = safe();
    if (!s || typeof s.isEncryptionAvailable !== 'function' || typeof s.encryptString !== 'function') {
      return { ok: false, reason: 'the system encryption service (safeStorage) is not available in this build' };
    }
    try {
      if (s.isEncryptionAvailable()) return { ok: true, reason: '' };
      return { ok: false, reason: 'the system encryption service (safeStorage, DPAPI on Windows) reports it is not available' };
    } catch (err) {
      return { ok: false, reason: 'the system encryption service failed: ' + errWords(err) };
    }
  }

  /** The key -> base64 blob, or { reason } when it cannot be encrypted. */
  function encrypt(key) {
    const a = availability();
    if (!a.ok) return { blob: '', reason: a.reason };
    try {
      const out = safe().encryptString(key);
      const b64 = Buffer.isBuffer(out) ? out.toString('base64') : Buffer.from(out || []).toString('base64');
      if (!b64) return { blob: '', reason: 'encryption returned nothing' };
      return { blob: b64, reason: '' };
    } catch (err) {
      return { blob: '', reason: 'encryption failed: ' + errWords(err) };
    }
  }

  /** Try to turn the saved blob back into the key. Sets value / error / pending. */
  function decryptSaved(quiet) {
    const a = availability();
    if (!a.ok) {
      pending = true;
      value = '';
      error = 'The saved ' + label + ' is encrypted, and encryption is not available right now (' + a.reason +
        '), so it cannot be read. Paste the key again.';
      if (!quiet) log('The saved ' + label + ' cannot be read yet: ' + a.reason);
      return false;
    }
    pending = false;
    try {
      const s = safe();
      if (typeof s.decryptString !== 'function') throw new Error('decryptString is missing');
      const k = clean(s.decryptString(Buffer.from(blob, 'base64')));
      if (!k) throw new Error('it decrypted to an empty key');
      value = k;
      error = '';
      return true;
    } catch (err) {
      value = '';
      error = 'The saved ' + label + ' could not be decrypted (' + errWords(err) + '). Encrypted keys only open for ' +
        'the Windows account that saved them. Paste the key again.';
      log('The saved ' + label + ' could not be decrypted: ' + errWords(err) + ' (kept on disk until replaced)');
      return false;
    }
  }

  /**
   * Read the key out of the owner's parsed JSON. Returns { rewrite } -- true when the owner should
   * write its file now (a plain key was just encrypted and the plain field must leave the disk),
   * then call wrote(ok).
   */
  function load(json) {
    value = ''; blob = ''; onDisk = 'none'; plainReason = ''; error = ''; pending = false; migrating = false;
    const j = json && typeof json === 'object' ? json : {};
    const enc = typeof j[encField] === 'string' ? j[encField].trim() : '';
    const plain = typeof j[field] === 'string' ? clean(j[field]) : '';
    if (enc) {
      blob = enc;
      onDisk = 'encrypted';
      if (decryptSaved(false)) {
        // A file holding both forms (an interrupted older write): keep the encrypted one, drop the plain.
        if (typeof j[field] === 'string') { migrating = true; return { rewrite: true }; }
        return { rewrite: false };
      }
      // An unreadable blob with a plain copy beside it: the plain copy is the key; encrypt it afresh.
      if (!plain) return { rewrite: false };
      blob = ''; error = ''; pending = false;
    }
    if (!plain) {
      // A plain field that cleans to nothing (whitespace only) is dropped on the next write.
      return { rewrite: typeof j[field] === 'string' && j[field] !== '' };
    }
    value = plain;
    onDisk = 'plain';
    const e = encrypt(plain);
    if (!e.blob) {
      plainReason = e.reason;
      log('The ' + label + ' stays unencrypted on disk: ' + e.reason);
      return { rewrite: false };
    }
    blob = e.blob;
    migrating = true;
    return { rewrite: true };
  }

  /** The owner wrote its file (ok) or failed to. Keeps status() true to what is on disk. */
  function wrote(ok) {
    if (!ok) {
      if (migrating && onDisk === 'plain') plainReason = 'the profile file could not be rewritten, so the old plain-text copy is still there';
      migrating = false;
      return;
    }
    const was = onDisk;
    onDisk = blob ? 'encrypted' : (value ? 'plain' : 'none');
    if (migrating && was === 'plain' && onDisk === 'encrypted') log('The ' + label + ' was moved from plain text to encrypted storage');
    if (onDisk !== 'plain') plainReason = '';
    migrating = false;
  }

  /** The fields to merge into the owner's JSON (exactly one of field / encField, or none). */
  function fields() {
    if (blob) return { [encField]: blob };      // includes a kept, unreadable blob
    if (value) return { [field]: value };
    return {};
  }

  /** Main-process only: the key to use, or '' (none saved, or the saved one cannot be read). */
  function get() {
    if (pending && blob) decryptSaved(true);
    return value;
  }

  /** A new key from Settings ('' clears it). The owner then writes fields() and calls wrote(ok). */
  function set(raw) {
    const next = clean(raw);
    error = ''; pending = false; migrating = false;
    if (!next) { value = ''; blob = ''; plainReason = ''; return { ok: true }; }
    const e = encrypt(next);
    value = next;
    blob = e.blob;
    plainReason = e.blob ? '' : e.reason;
    if (!e.blob) log('The new ' + label + ' will be stored unencrypted: ' + e.reason);
    return { ok: true };
  }

  /** The renderer-safe view: never the key. */
  function status() {
    const k = get();
    const storage = onDisk === 'plain' ? 'unencrypted' : onDisk;   // 'none' | 'encrypted' | 'unencrypted'
    return {
      hasKey: !!k,
      keyMask: mask(k),
      keyStorage: storage,
      keyStorageNote: storage === 'unencrypted' ? 'stored unencrypted: ' + (plainReason || 'encryption was not available when it was saved') : '',
      keyError: error,
    };
  }

  return { load, wrote, fields, get, set, status, field, encField, availability };
}

module.exports = { create, defaultMask };
