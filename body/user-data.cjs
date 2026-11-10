'use strict';

const path = require('node:path');
const fs = require('node:fs');

function canonicalNoLinks(value) {
  if (!path.isAbsolute(value)) throw new Error('Electron userData paths must be absolute');
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Electron userData path contains a symbolic link or junction: ${current}`);
      current = fs.realpathSync.native(current);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return path.resolve(current);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function configureUserData(app, env = process.env, platform = process.platform) {
  const expectedRootValue = env.BODY_USER_DATA_EXPECTED_ROOT;
  if (!expectedRootValue) {
    if (env.BODY_USER_DATA) app.setPath('userData', path.resolve(env.BODY_USER_DATA));
    return null;
  }

  if (!env.BODY_USER_DATA) throw new Error('BODY_USER_DATA is required when BODY_USER_DATA_EXPECTED_ROOT is set');
  if (!path.isAbsolute(expectedRootValue) || !path.isAbsolute(env.BODY_USER_DATA)) {
    throw new Error('BODY_USER_DATA and BODY_USER_DATA_EXPECTED_ROOT must be absolute paths');
  }

  const expectedRoot = canonicalNoLinks(expectedRootValue);
  if (!fs.statSync(expectedRoot).isDirectory()) throw new Error('BODY_USER_DATA_EXPECTED_ROOT must be an existing directory');
  const requestedPath = canonicalNoLinks(env.BODY_USER_DATA);
  if (!isWithin(expectedRoot, requestedPath)) {
    throw new Error(`Requested Electron userData path is outside the expected temporary root: ${requestedPath}`);
  }

  const markerPath = env.BODY_BOOT_MARKER ? canonicalNoLinks(env.BODY_BOOT_MARKER) : undefined;
  if (env.BODY_BOOT_MARKER && !isWithin(expectedRoot, markerPath)) {
    throw new Error(`Body boot marker is outside the expected temporary root: ${markerPath}`);
  }

  app.setPath('userData', requestedPath);
  const actualPath = canonicalNoLinks(app.getPath('userData'));
  const normalize = (value) => platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
  const samePath = normalize(actualPath) === normalize(requestedPath);
  const actualInsideExpectedRoot = isWithin(expectedRoot, actualPath);

  if (!samePath || !actualInsideExpectedRoot) {
    throw new Error(`Electron userData path does not match the expected temporary path: ${actualPath}`);
  }

  return { expectedRoot, requestedPath, actualPath, markerPath };
}

function writeBootMarker(readback, record) {
  if (!readback?.markerPath) throw new Error('A verified temporary userData root and BODY_BOOT_MARKER are required');
  const markerPath = canonicalNoLinks(readback.markerPath);
  if (!isWithin(readback.expectedRoot, markerPath)) throw new Error('Body boot marker escaped the expected temporary root');
  const parent = canonicalNoLinks(path.dirname(markerPath));
  if (!isWithin(readback.expectedRoot, parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error('Body boot marker parent is not inside the expected temporary root');
  }
  fs.appendFileSync(markerPath, `${JSON.stringify(record)}\n`);
  return markerPath;
}

module.exports = { canonicalNoLinks, configureUserData, writeBootMarker };
