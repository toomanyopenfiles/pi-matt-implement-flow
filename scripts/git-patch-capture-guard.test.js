'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseGitVersion,
  gitPatchCaptureWarning,
} = require('./git-patch-capture-guard.js');

test('parseGitVersion reads major.minor.patch from `git --version` output', () => {
  assert.deepEqual(parseGitVersion('git version 2.39.5 (Apple Git-154)'), {
    major: 2,
    minor: 39,
    patch: 5,
  });
  assert.deepEqual(parseGitVersion('git version 2.41.0'), {
    major: 2,
    minor: 41,
    patch: 0,
  });
});

test('parseGitVersion tolerates a two-segment version', () => {
  assert.deepEqual(parseGitVersion('git version 2.41'), {
    major: 2,
    minor: 41,
    patch: 0,
  });
});

test('parseGitVersion returns null for unrecognized output', () => {
  assert.equal(parseGitVersion('not a git version string'), null);
  assert.equal(parseGitVersion(''), null);
});

test('git below 2.41 yields a warning mentioning the threshold and degradation', () => {
  const warning = gitPatchCaptureWarning('git version 2.39.5 (Apple Git-154)');
  assert.ok(warning, 'expected a warning below the threshold');
  assert.match(warning, /2\.39\.5/);
  assert.match(warning, /2\.41/);
  assert.match(warning, /patch capture/);
});

test('git at 2.41.0 yields no warning', () => {
  assert.equal(gitPatchCaptureWarning('git version 2.41.0'), null);
});

test('git above the threshold yields no warning', () => {
  assert.equal(gitPatchCaptureWarning('git version 2.47.1'), null);
});

test('unparseable version output yields no warning (never fails on unknown)', () => {
  assert.equal(gitPatchCaptureWarning('git version unknown-weird'), null);
});
