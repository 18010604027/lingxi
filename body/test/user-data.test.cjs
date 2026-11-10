'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { configureUserData, writeBootMarker } = require('../user-data.cjs');

function appAt(initialPath) {
  let userData = initialPath;
  return {
    setPath(name, value) { assert.equal(name, 'userData'); userData = value; },
    getPath(name) { assert.equal(name, 'userData'); return userData; },
  };
}

test('enforces and reads back userData under an explicit temporary root', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-user-data-root-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requested = path.join(root, 'electron');
  const app = appAt('unused');
  const result = configureUserData(app, {
    BODY_USER_DATA: requested,
    BODY_USER_DATA_EXPECTED_ROOT: root,
  }, process.platform);
  assert.equal(result.actualPath, requested);
  assert.equal(result.expectedRoot, root);
});

test('fails closed when an expected root is set without a dedicated userData path', () => {
  assert.throws(() => configureUserData(appAt('default'), {
    BODY_USER_DATA_EXPECTED_ROOT: path.resolve('tmp', 'body-profile'),
  }), /BODY_USER_DATA is required/);
});

test('requires absolute paths when an expected root is set', () => {
  assert.throws(() => configureUserData(appAt('default'), {
    BODY_USER_DATA: 'relative/profile',
    BODY_USER_DATA_EXPECTED_ROOT: path.resolve('tmp', 'body-profile'),
  }), /must be absolute paths/);
  assert.throws(() => configureUserData(appAt('default'), {
    BODY_USER_DATA: path.resolve('tmp', 'body-profile', 'electron'),
    BODY_USER_DATA_EXPECTED_ROOT: 'relative/root',
  }), /must be absolute paths/);
});

test('rejects a userData path outside the expected root', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-user-data-root-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => configureUserData(appAt('unused'), {
    BODY_USER_DATA: path.join(root, '..', `${path.basename(root)}-outside`, 'profile'),
    BODY_USER_DATA_EXPECTED_ROOT: root,
  }), /outside the expected temporary root/);
});

test('rejects a userData path that escapes through a symlink or junction', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-user-data-link-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expectedRoot = path.join(root, 'approved');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(expectedRoot, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const link = path.join(expectedRoot, 'redirect');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      context.skip(`junction creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => configureUserData(appAt('unused'), {
    BODY_USER_DATA: path.join(link, 'profile'),
    BODY_USER_DATA_EXPECTED_ROOT: expectedRoot,
  }), /symbolic link or junction/);
});

test('writes a boot marker with the effective path inside the approved temporary root', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-user-data-marker-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'body-boot.jsonl');
  const profile = path.join(root, 'profile');
  const readback = configureUserData(appAt('unused'), {
    BODY_USER_DATA: profile,
    BODY_USER_DATA_EXPECTED_ROOT: root,
    BODY_BOOT_MARKER: marker,
  });
  writeBootMarker(readback, { pid: 12, userData: readback.actualPath });
  const record = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(record.pid, 12);
  assert.equal(record.userData, profile);
});

test('fails closed when the boot marker is outside the approved root', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-user-data-root-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => configureUserData(appAt('unused'), {
    BODY_USER_DATA: path.join(root, 'electron'),
    BODY_USER_DATA_EXPECTED_ROOT: root,
    BODY_BOOT_MARKER: path.join(root, '..', `${path.basename(root)}-outside`, 'boot.jsonl'),
  }), /Body boot marker is outside/);
});

test('rejects a boot marker redirected through a symlink or junction', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-user-data-marker-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const approved = path.join(root, 'approved');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(approved);
  fs.mkdirSync(outside);
  const link = path.join(approved, 'redirect');
  const marker = path.join(link, 'body-boot.jsonl');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      context.skip(`file symlink creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => configureUserData(appAt('unused'), {
    BODY_USER_DATA: path.join(approved, 'profile'),
    BODY_USER_DATA_EXPECTED_ROOT: approved,
    BODY_BOOT_MARKER: marker,
  }), /symbolic link or junction/);
});

test('fails closed when the boot marker parent is missing', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-user-data-marker-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const readback = configureUserData(appAt('unused'), {
    BODY_USER_DATA: path.join(root, 'profile'),
    BODY_USER_DATA_EXPECTED_ROOT: root,
    BODY_BOOT_MARKER: path.join(root, 'missing', 'body-boot.jsonl'),
  });
  assert.throws(() => writeBootMarker(readback, { pid: 12 }), /ENOENT/);
});

test('fails closed when boot marker evidence has no verified profile', () => {
  assert.throws(() => writeBootMarker(null, { pid: 12 }), /verified temporary userData root/);
});

test('rejects Electron resolving userData to a different path', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-user-data-root-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const actualPath = path.join(root, 'other');
  const app = {
    setPath(name, value) { assert.equal(name, 'userData'); assert.equal(value, path.join(root, 'electron')); },
    getPath(name) { assert.equal(name, 'userData'); return actualPath; },
  };
  assert.throws(() => configureUserData(app, {
    BODY_USER_DATA: path.join(root, 'electron'),
    BODY_USER_DATA_EXPECTED_ROOT: root,
  }), /does not match the expected temporary path/);
});

test('does not change the production path contract without an expected root', () => {
  const app = appAt('default');
  assert.equal(configureUserData(app, {}), null);
  assert.equal(app.getPath('userData'), 'default');
});
