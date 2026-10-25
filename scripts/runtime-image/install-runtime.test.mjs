import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.join(import.meta.dirname, 'install-runtime.sh');

function runtime(dir, name) {
  fs.mkdirSync(path.join(dir, name, 'files/bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'files/bin/wine'), '#!/bin/sh\n', { mode: 0o755 });
}

function install(source, root) {
  return execFileSync('sh', [script], { env: { ...process.env, RUNTIME_SOURCE: source, XODUS_RUNTIME_ROOT: root }, encoding: 'utf8' });
}

const current = root => JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));

test('installs the image runtime, points Nexus at it and prunes only its own old releases', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-image-'));
  const root = path.join(tmp, 'runtimes');
  runtime(path.join(root, 'releases'), 'xodus-nexus-runtime-upstream');
  fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify({ name: 'xodus-nexus-runtime-upstream' }, null, 2));

  const names = ['xodus-nexus-runtime-a', 'xodus-nexus-runtime-b', 'xodus-nexus-runtime-c'];
  for (const name of names) {
    const source = path.join(tmp, `src-${name}`);
    runtime(source, name);
    install(source, root);
    const state = current(root);
    assert.equal(state.name, name);
    assert.equal(state.winePath, path.join(root, 'releases', name, 'files/bin/wine'));
  }
  // c is current, b was current before it; a was ours and is pruned; upstream is kept.
  assert.deepEqual(fs.readdirSync(path.join(root, 'releases')).sort(),
    ['xodus-nexus-runtime-b', 'xodus-nexus-runtime-c', 'xodus-nexus-runtime-upstream']);
  assert.deepEqual(fs.readdirSync(root).filter(entry => entry.startsWith('.staging')), []);

  // Same image again: nothing copied, current.json untouched, and b (no longer
  // named by current.json) is pruned now.
  const before = fs.readFileSync(path.join(root, 'current.json'), 'utf8');
  assert.equal(install(path.join(tmp, 'src-xodus-nexus-runtime-c'), root), 'install-runtime: removing xodus-nexus-runtime-b\n');
  assert.equal(fs.readFileSync(path.join(root, 'current.json'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.join(root, 'releases')).sort(),
    ['xodus-nexus-runtime-c', 'xodus-nexus-runtime-upstream']);
});

test('refuses an image without exactly one runtime', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-image-'));
  const source = path.join(tmp, 'src');
  fs.mkdirSync(source);
  assert.throws(() => install(source, path.join(tmp, 'runtimes')));
  runtime(source, 'xodus-nexus-runtime-a');
  runtime(source, 'xodus-nexus-runtime-b');
  assert.throws(() => install(source, path.join(tmp, 'runtimes')));
  assert.equal(fs.existsSync(path.join(tmp, 'runtimes', 'current.json')), false);
});
