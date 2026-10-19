// argvurl-harness.js - pure-node test for argvurl.js (run: node argvurl-harness.js).
// The argv shapes are the ones Windows really builds from the registered
// command: "<Quartz.exe>" "<app dir>" "%1".
const path = require('path');
const { pathToFileURL } = require('url');
const { urlFromArgv } = require('./argvurl');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}

const EXE = path.join(__dirname, 'node_modules', 'electron', 'dist', 'Quartz.exe');   // this checkout's launcher
const ROOT = __dirname;
const run = (...rest) => urlFromArgv([EXE, ROOT, ...rest]);

// http / https
eq('http', run('http://example.com/a?b=1'), 'http://example.com/a?b=1');
eq('https', run('https://example.com/'), 'https://example.com/');
eq('HTTPS upper-case scheme', run('HTTPS://Example.com/x'), 'HTTPS://Example.com/x');
eq('switches before the URL are skipped', urlFromArgv([EXE, '--flag', ROOT, 'https://a.test/']), 'https://a.test/');
eq('last candidate wins', run('https://first.test/', 'https://second.test/'), 'https://second.test/');

// file:/// - the bug: these used to become <cwd>\file:\C:\x.html
eq('file:/// html', run('file:///C:/x.html'), 'file:///C:/x.html');
eq('file:/// non-html', run('file:///C:/Users/you/notes.txt'), 'file:///C:/Users/you/notes.txt');
eq('file:/// with spaces is canonicalised', run('file:///C:/my dir/x.html'), 'file:///C:/my%20dir/x.html');
eq('FILE: upper-case', run('FILE:///C:/x.htm'), 'file:///C:/x.htm');
eq('never resolved against the cwd', String(run('file:///C:/x.html')).includes('browser'), false);

// bare .html / .htm path - the file association's "%1"
eq('bare .html path', run('C:\\Users\\you\\next-week\\scratch\\x.html'), 'file:///C:/Users/you/next-week/scratch/x.html');
eq('bare .htm path with a space', run('C:\\my dir\\page.HTM'), 'file:///C:/my%20dir/page.HTM');
eq('relative .html path resolves against cwd', run('page.html'), pathToFileURL(path.resolve('page.html')).href);

// junk
eq('no args', urlFromArgv([EXE, ROOT]), null);
eq('not an array', urlFromArgv(undefined), null);
eq('plain word', run('hello'), null);
eq('bare host', run('example.com'), null);
eq('empty string', run(''), null);
eq('switch only', run('--allow-file-access'), null);
eq('javascript:', run('javascript:alert(1)'), null);
eq('javascript: ending .html is not a path', run('javascript:alert(1)//.html'), null);
eq('ftp .html is not a path', run('ftp://h/x.html'), null);
eq('http with no host', run('http://'), null);
eq('file: with no path', run('file:///'), null);
eq('junk after a URL: URL still found', run('https://ok.test/', 'junk'), 'https://ok.test/');

console.log(`argvurl-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
