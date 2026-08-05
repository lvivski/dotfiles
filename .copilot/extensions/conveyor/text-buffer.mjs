/** @module text-buffer — tiny bounded-text helpers. */

/** Keep the tail of `current + chunk` within `max` characters. @param {string} current @param {unknown} chunk @param {number} max */
export function appendBounded(current, chunk, max) {
	const next = current + String(chunk);
	return next.length > max ? next.slice(next.length - max) : next;
}
