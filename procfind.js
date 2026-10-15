// procfind.js -- "is a process with this exe name running?" without starting a process.
//
// school.js asks that every 5 s (is LessonPlayer up?). It used to spawn `tasklist /FI ...` for the
// answer: a new tasklist.exe plus its conhost.exe every 5 s for the whole life of the browser,
// about 60-95 ms of CPU each on the user's i3 (measured 2026-10-15), plus whatever Defender spends
// on each new process, whether or not LessonPlayer was ever opened. This reads the same list
// tasklist reads (a Toolhelp snapshot) inside the main process: about a millisecond.
//
// Same answer as tasklist's IMAGENAME filter: the exe file name, compared case-insensitively.
// koffi is loaded lazily and only once; when it is missing or refuses (the same fallback story
// as embed.js), running() returns null and the caller keeps using tasklist. Never throws.
'use strict';

let api;          // undefined: not tried yet; null: unavailable; object: bound
let whyNot = '';

function load() {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== 'win32') { whyNot = 'not Windows'; return api; }
  try {
    const koffi = require('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    // Prefixed name: koffi's type registry is per-process (see embed.js).
    const ENTRY = koffi.struct('ProcfindEntry32W', {
      dwSize: 'uint32_t',
      cntUsage: 'uint32_t',
      th32ProcessID: 'uint32_t',
      th32DefaultHeapID: 'uintptr_t',
      th32ModuleID: 'uint32_t',
      cntThreads: 'uint32_t',
      th32ParentProcessID: 'uint32_t',
      pcPriClassBase: 'int32_t',
      dwFlags: 'uint32_t',
      szExeFile: koffi.array('char16_t', 260, 'String'),
    });
    api = {
      size: koffi.sizeof(ENTRY),
      snapshot: kernel32.func('void * __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)'),
      // The entry goes over as raw bytes: marshalling the whole struct (a 520-byte name) per
      // process cost ~12 ms a walk. The layout still comes from ENTRY.
      nameAt: koffi.offsetof(ENTRY, 'szExeFile'),
      first: kernel32.func('bool __stdcall Process32FirstW(void *h, _Inout_ uint8_t *pe)'),
      next: kernel32.func('bool __stdcall Process32NextW(void *h, _Inout_ uint8_t *pe)'),
      close: kernel32.func('bool __stdcall CloseHandle(void *h)'),
      address: (p) => koffi.address(p),
    };
  } catch (err) {
    api = null;
    whyNot = (err && err.message) || 'koffi failed to load';
  }
  return api;
}

const TH32CS_SNAPPROCESS = 0x2;
const INVALID = BigInt.asUintN(64, -1n);

/**
 * true / false: whether a process named exeName (e.g. 'LessonPlayerApp.exe') is running.
 * null: this machine cannot answer without a child process (see reason()).
 */
function running(exeName) {
  const w = load();
  if (!w) return null;
  const want = String(exeName || '').toLowerCase();
  let h = null;
  try {
    h = w.snapshot(TH32CS_SNAPPROCESS, 0);
    const at = h ? BigInt(w.address(h)) : 0n;
    if (!h || at === 0n || at === INVALID) { whyNot = 'CreateToolhelp32Snapshot failed'; h = null; return null; }
    const pe = Buffer.alloc(w.size);
    pe.writeUInt32LE(w.size, 0);
    const end = w.size - 1;
    let ok = w.first(h, pe);
    let seen = 0;
    while (ok) {
      seen++;
      let stop = w.nameAt;
      while (stop < end && (pe[stop] !== 0 || pe[stop + 1] !== 0)) stop += 2;
      if (stop - w.nameAt === want.length * 2 && pe.toString('utf16le', w.nameAt, stop).toLowerCase() === want) return true;
      ok = w.next(h, pe);
    }
    // An empty walk is not "not running": the System Idle Process alone makes one entry.
    if (seen === 0) { whyNot = 'the process snapshot was empty'; return null; }
    return false;
  } catch (err) {
    whyNot = (err && err.message) || 'the snapshot walk threw';
    return null;
  } finally {
    if (h) { try { w.close(h); } catch (e) { /* already closed */ } }
  }
}

function reason() { return whyNot; }

// Test seam (procfind-harness.js): swap the kernel32 binding for a fake with the same shape
// ({ size, nameAt, snapshot, first, next, close, address }), so the walk and the name match run
// against a made-up process list. use(undefined) goes back to the real, lazily loaded one.
const __test = {
  use(fake) { api = fake; whyNot = ''; },
};

module.exports = { running, reason, __test };
