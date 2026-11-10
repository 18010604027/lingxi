/**
 * Where a window goes, and where it may go: the coordinate helpers the body and the movement algorithms share.
 *
 * These are not movement algorithms. They convert between the work area a window sits in and the shares a command or a
 * keep-out stretch uses, so a figure pack's `motion.cjs` can be written against the same numbers the body uses.
 */

'use strict';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** The window's left edge so its centre lands on `ratio` (0..1) in `area`. */
function targetLeft(area, width, ratio) {
  const centre = area.x + clamp(Number(ratio) || 0, 0, 1) * area.width;
  const maxLeft = area.x + area.width - width;
  if (maxLeft <= area.x) return area.x; // window wider than the work area
  return clamp(centre - width / 2, area.x, maxLeft);
}

/** Window centre as a share of the work-area width (may be outside 0..1). */
function centreShare(area, width, left) {
  if (!area || !(area.width > 0)) return 0;
  return (left + width / 2 - area.x) / area.width;
}

/**
 * Window top so the character's feet sit on the bottom of the work area. A figure's clips may leave `pad` pixels of
 * empty canvas under the feet, so the window hangs that much lower than the work area.
 */
function bottomTop(area, height, pad = 0) {
  return area.y + area.height - height + pad;
}

/** Keep a window rectangle inside an area (larger windows align top/left); `pad` as in `bottomTop`. */
function clampWindow(area, width, height, left, top, pad = 0) {
  const maxLeft = area.x + area.width - width;
  const maxTop = area.y + area.height - height + pad;
  return {
    x: maxLeft <= area.x ? area.x : clamp(left, area.x, maxLeft),
    y: maxTop <= area.y ? area.y : clamp(top, area.y, maxTop),
  };
}

/** Bounds for the fall integrator (window top-left coordinates); `pad` as in `bottomTop`. */
function fallBounds(area, width, height, pad = 0) {
  return {
    minX: area.x,
    maxX: Math.max(area.x, area.x + area.width - width),
    minY: area.y,
    maxY: Math.max(area.y, area.y + area.height - height + pad),
  };
}

module.exports = { clamp, targetLeft, centreShare, bottomTop, clampWindow, fallBounds };
