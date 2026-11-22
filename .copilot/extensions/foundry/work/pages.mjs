import { fail } from "./values.mjs";

/** @typedef {{path:string,oid?:string,text?:string,omitted?:string}} FileRow */
/** Pack whole blobs when possible. Only the requested blob may be split, and its
 * receipt identifies precisely the displayed range (UTF-16 indices, never half a surrogate).
 * @param {Map<string,FileRow>} rows @param {number} bytes @param {string} charter
 * @param {string|undefined} focus @param {number} start */
export function evidencePage(rows, bytes, charter, focus, start) {
	const index = [...rows.values()].map(({ path, oid, omitted }) => JSON.stringify({ path, oid, ...(omitted ? { omitted } : {}) }));
	let free = bytes - Buffer.byteLength(index.join("\n"));
	if (free < 0) fail("packet_budget", "The charter instructions and pinned file index exceed this session's scout budget.");
	const order = [...rows.values()].map((row, i) => ({ row, i })).sort((a, b) =>
		rank(a.row) - rank(b.row) || (a.row.text?.length ?? 0) - (b.row.text?.length ?? 0));
	/** @param {FileRow} r */
	function rank(r) { return r.path === focus ? 0 : r.path === charter ? 1 : 2; }
	const files = new Map();
	/** @type {import("./model.js").Packet["excerpt"]} */ let excerpt;
	for (const { row, i } of order) {
		if (row.text === undefined || !row.oid) continue;
		const available = free + Buffer.byteLength(index[i]), whole = JSON.stringify(row);
		if (Buffer.byteLength(whole) <= available) {
			files.set(row.path, row.oid); index[i] = whole;
		} else if (row.path === (focus ?? charter)) {
			const content = row.text, length = content.length;
			const piece = (/** @type {number} */ end) => JSON.stringify({ path: row.path, oid: row.oid, start, end, length, excerpt: content.slice(start, end) });
			let lo = start, hi = length;
			while (lo < hi) {
				const mid = Math.ceil((lo + hi) / 2);
				if (Buffer.byteLength(piece(mid)) <= available) lo = mid; else hi = mid - 1;
			}
			if (lo < length && /[\uD800-\uDBFF]/.test(content.charAt(lo - 1))) lo--;
			if (lo <= start) fail("packet_budget", `No text of the requested ${row.path} fits alongside its pinned index.`);
			index[i] = piece(lo); excerpt = { path: row.path, oid: row.oid, start, end: lo, length };
		} else continue;
		free = available - Buffer.byteLength(index[i]);
	}
	return { text: index.join("\n"), files: Object.fromEntries(files), ...(excerpt ? { excerpt } : {}) };
}
