'use strict';

/**
 * Which movement maths this run uses: the figure pack's own `motion.cjs`, and only that.
 *
 * Moving to a point, the spring, the release-velocity estimate, and the fall with gravity, bounces and friction are the
 * person's algorithms, not this body's. The module is required from the pack folder; the coordinate helpers every
 * algorithm needs (`targetLeft`, `centreShare`, `bottomTop`, `clampWindow`, `fallBounds`) are merged in from
 * `geometry.cjs`, so a module only implements the four movement functions. A pack without one is a configuration
 * error: the body says what is missing and stops, rather than running someone else's motion.
 */

const fs = require('node:fs');
const path = require('node:path');
const geometry = require('./geometry.cjs');

/** Everything a pack module must provide. */
const REQUIRED = ['createMove', 'travelX', 'estimateReleaseVelocity', 'fallStep'];

/**
 * Loads the pack's movement module.
 * @param {{BODY_MOTION?: string}} env where the pack's module is named
 * @returns {{motion: object, source: string}}
 * @throws when the module is missing, cannot be loaded, or lacks a function
 */
function loadMotion(env = process.env) {
  const file = env.BODY_MOTION;
  if (!file) throw new Error('no movement algorithm: the figure pack has no motion.cjs (format: packs/README.md)');
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`movement algorithm not found: ${resolved}`);
  let module;
  try {
    delete require.cache[require.resolve(resolved)];
    module = require(resolved);
  } catch (error) {
    throw new Error(`movement algorithm could not be loaded (${resolved}): ${error.message}`);
  }
  const exported = module?.default ?? module;
  const gone = REQUIRED.filter((name) => typeof exported?.[name] !== 'function');
  if (gone.length) throw new Error(`movement algorithm must export ${gone.join(', ')} (${resolved})`);
  return { motion: { ...geometry, ...exported }, source: resolved };
}

module.exports = { loadMotion, REQUIRED };
