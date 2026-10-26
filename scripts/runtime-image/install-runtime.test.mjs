import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.join(import.meta.dirname, 'install-runtime.sh');
const env = (source, root) => ({ ...process.env, RUNTIME_SOURCE: source, XODUS_RUNTIME_ROOT: root });

function runtime(dir, name) {
  fs.mkdirSync(path.join(dir, name, 'files/bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, name, 'files/lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'files/bin/wine'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, name, 'files/lib/libwine.so'), name, { mode: 0o555 });
  fs.symlinkSync('libwine.so', path.join(dir, name, 'files/lib/libwine.so.1'));
  return dir;
}

const install = (source, root) => execFileSync('sh', [script], { env: env(source, root), encoding: 'utf8' });
const current = root => JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
const releases = root => fs.readdirSync(path.join(root, 'releases')).sort();
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-image-'));

test('installs the image runtime and points Nexus at it', () => {
  const tmp = scratch();
  const root = path.join(tmp, 'runtimes');
  install(runtime(path.join(tmp, 'src'), 'xodus-nexus-runtime-a'), root);
  const state = current(root);
  assert.equal(state.name, 'xodus-nexus-runtime-a');
  assert.equal(state.winePath, path.join(root, 'releases/xodus-nexus-runtime-a/files/bin/wine'));
  assert.equal(fs.statSync(path.join(root, 'current.json')).mode & 0o777, 0o600);
  const lib = path.join(root, 'releases/xodus-nexus-runtime-a/files/lib');
  assert.equal(fs.readlinkSync(path.join(lib, 'libwine.so.1')), 'libwine.so');
  assert.equal(fs.readFileSync(path.join(lib, 'libwine.so'), 'utf8'), 'xodus-nexus-runtime-a');
  assert.deepEqual(fs.readdirSync(root).filter(entry => entry.startsWith('.')), []);
});

test('prunes only its own releases, and only on a switch, keeping the one in use until now', () => {
  const tmp = scratch();
  const root = path.join(tmp, 'runtimes');
  runtime(path.join(root, 'releases'), 'xodus-nexus-runtime-upstream');
  fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify({ name: 'xodus-nexus-runtime-upstream' }));
  for (const name of ['a', 'b', 'c']) install(runtime(path.join(tmp, `src-${name}`), `xodus-nexus-runtime-${name}`), root);
  // c is current, b was in use until c; a was ours and is pruned; upstream is kept.
  assert.deepEqual(releases(root), ['xodus-nexus-runtime-b', 'xodus-nexus-runtime-c', 'xodus-nexus-runtime-upstream']);
  // Same image again: nothing copied, nothing pruned, current.json untouched.
  const before = fs.readFileSync(path.join(root, 'current.json'), 'utf8');
  assert.equal(install(path.join(tmp, 'src-c'), root), '');
  assert.equal(fs.readFileSync(path.join(root, 'current.json'), 'utf8'), before);
  assert.deepEqual(releases(root), ['xodus-nexus-runtime-b', 'xodus-nexus-runtime-c', 'xodus-nexus-runtime-upstream']);
});

test('reads the release in use from a minified current.json', () => {
  const tmp = scratch();
  const root = path.join(tmp, 'runtimes');
  install(runtime(path.join(tmp, 'src-a'), 'xodus-nexus-runtime-a'), root);
  install(runtime(path.join(tmp, 'src-b'), 'xodus-nexus-runtime-b'), root);
  fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify(current(root)));
  install(runtime(path.join(tmp, 'src-c'), 'xodus-nexus-runtime-c'), root);
  assert.deepEqual(releases(root), ['xodus-nexus-runtime-b', 'xodus-nexus-runtime-c']);
});

test('a copy that cannot read the whole runtime installs nothing', { skip: process.getuid?.() === 0 }, () => {
  const tmp = scratch();
  const root = path.join(tmp, 'runtimes');
  const source = runtime(path.join(tmp, 'src'), 'xodus-nexus-runtime-a');
  const unreadable = path.join(source, 'xodus-nexus-runtime-a/files/lib/secret');
  fs.writeFileSync(unreadable, 'x', { mode: 0o000 });
  assert.throws(() => install(source, root));
  assert.deepEqual(releases(root), []);
  assert.equal(fs.existsSync(path.join(root, 'current.json')), false);
  assert.deepEqual(fs.readdirSync(root).filter(entry => entry.startsWith('.')), []);
  // Once readable, a re-run installs it whole.
  fs.chmodSync(unreadable, 0o644);
  install(source, root);
  assert.equal(fs.readFileSync(path.join(root, 'releases/xodus-nexus-runtime-a/files/lib/secret'), 'utf8'), 'x');
});

test('concurrent runs leave one whole install', async () => {
  const tmp = scratch();
  const root = path.join(tmp, 'runtimes');
  const source = runtime(path.join(tmp, 'src'), 'xodus-nexus-runtime-a');
  const run = promisify(execFile);
  await Promise.all(Array.from({ length: 8 }, () => run('sh', [script], { env: env(source, root) })));
  assert.equal(current(root).name, 'xodus-nexus-runtime-a');
  assert.deepEqual(releases(root), ['xodus-nexus-runtime-a']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'releases/xodus-nexus-runtime-a')).sort(), ['.direwolf-runtime-image', 'files']);
  assert.deepEqual(fs.readdirSync(root).filter(entry => entry.startsWith('.')), []);
});

test('sweeps only old staging and replaces an unmarked partial release', () => {
  const tmp = scratch();
  const root = path.join(tmp, 'runtimes');
  const killed = path.join(root, '.staging-image-killed');
  const copying = path.join(root, '.staging-image-copying');
  fs.mkdirSync(path.join(killed, 'xodus-nexus-runtime-a'), { recursive: true });
  fs.mkdirSync(copying);
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(killed, old, old);
  // Debris of an interrupted install: no marker, missing files.
  fs.mkdirSync(path.join(root, 'releases/xodus-nexus-runtime-a/files'), { recursive: true });
  install(runtime(path.join(tmp, 'src'), 'xodus-nexus-runtime-a'), root);
  assert.deepEqual(fs.readdirSync(root).filter(entry => entry.startsWith('.')), ['.staging-image-copying']);
  assert.equal(fs.readFileSync(path.join(root, 'releases/xodus-nexus-runtime-a/files/lib/libwine.so'), 'utf8'), 'xodus-nexus-runtime-a');
  assert.equal(fs.existsSync(path.join(root, 'releases/xodus-nexus-runtime-a/xodus-nexus-runtime-a')), false);
});

test('concurrent runs replace a leftover unmarked release once', async () => {
  const tmp = scratch();
  const root = path.join(tmp, 'runtimes');
  runtime(path.join(root, 'releases'), 'xodus-nexus-runtime-a');
  const source = runtime(path.join(tmp, 'src'), 'xodus-nexus-runtime-a');
  const run = promisify(execFile);
  await Promise.all(Array.from({ length: 8 }, () => run('sh', [script], { env: env(source, root) })));
  assert.deepEqual(fs.readdirSync(path.join(root, 'releases/xodus-nexus-runtime-a')).sort(), ['.direwolf-runtime-image', 'files']);
  assert.equal(current(root).name, 'xodus-nexus-runtime-a');
  assert.deepEqual(fs.readdirSync(root).filter(entry => entry.startsWith('.')), []);
});

test('fails when the release cannot be published', { skip: process.getuid?.() === 0 }, () => {
  const tmp = scratch();
  const root = path.join(tmp, 'runtimes');
  fs.mkdirSync(path.join(root, 'releases'), { recursive: true });
  fs.chmodSync(path.join(root, 'releases'), 0o555);
  try {
    assert.throws(() => install(runtime(path.join(tmp, 'src'), 'xodus-nexus-runtime-a'), root));
    assert.equal(fs.existsSync(path.join(root, 'current.json')), false);
  } finally {
    fs.chmodSync(path.join(root, 'releases'), 0o755);
  }
});

test('refuses an image without exactly one plainly named runtime', () => {
  const tmp = scratch();
  const root = path.join(tmp, 'runtimes');
  const source = path.join(tmp, 'src');
  fs.mkdirSync(source);
  assert.throws(() => install(source, root));
  runtime(source, 'xodus-nexus-runtime-a"b');
  assert.throws(() => install(source, root));
  runtime(source, 'xodus-nexus-runtime-b');
  assert.throws(() => install(source, root));
  assert.equal(fs.existsSync(path.join(root, 'current.json')), false);
});

test('installs an upstream nexus-runtime candidate, but never beside one of ours', () => {
  const tmp = scratch();
  const root = path.join(tmp, 'runtimes');
  install(runtime(path.join(tmp, 'ours'), 'xodus-nexus-runtime-a'), root);
  install(runtime(path.join(tmp, 'upstream'), 'nexus-runtime-11.0-experimental-g8a7cd313'), root);
  assert.equal(current(root).name, 'nexus-runtime-11.0-experimental-g8a7cd313');
  assert.equal(current(root).winePath, path.join(root, 'releases/nexus-runtime-11.0-experimental-g8a7cd313/files/bin/wine'));
  const both = runtime(path.join(tmp, 'both'), 'xodus-nexus-runtime-b');
  runtime(both, 'nexus-runtime-c');
  assert.throws(() => install(both, root));
  assert.equal(current(root).name, 'nexus-runtime-11.0-experimental-g8a7cd313');
});
