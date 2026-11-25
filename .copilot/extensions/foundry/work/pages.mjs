import { fail } from "./values.mjs";

export const indexBudgetError = "The charter instructions and pinned file index exceed this session's scout budget.";
/** @param {import("./model.js").Packet} packet @param {string} file @param {string} oid */
export const deliveredFile = (packet, file, oid) => Object.hasOwn(packet.files,file) && packet.files[file]===oid ||
	packet.excerpt?.path===file && packet.excerpt.oid===oid;
/** @param {string} file @param {string} oid */
export const unseenText = (file, oid) => `Text of ${file} at ${oid} was not delivered in this packet`;
/** Only the opening comparison's own rejected citation, not a missing page on a later read.
 * @param {import("./model.js").Review} review @param {string} oid */
export function rejectedSource(review, oid) {
	const file=review.iteration?.source?.file, packet=review.packet;
	return !!file && !!packet?.partial && review.observation?.evidence.includes(file) === true &&
		!Object.hasOwn(packet.files,file) && packet.excerpt?.path!==file && review.error===unseenText(file,oid);
}
/** @param {unknown} v @returns {v is string} */
export const validMatch = v => typeof v === "string" && !!v.length && !/[\0\uD800-\uDFFF]/u.test(v);

/** Prefer an actual line representing a repeated diagnostic in the selected squad's output.
 * Labels affect scheduling context only; an excerpt is never a new verdict.
 * @param {string} output @param {string} squad */
export function diagnosticLine(output, squad) {
	const lines = output.split("\n"), counts = new Map();
	let best = "", max = 0;
	for (const line of lines) {
		if (!line.startsWith(`${squad}/`)) continue;
		const label = line.indexOf(": "), key = label < 0 ? line : line.slice(label + 2);
		const row = counts.get(key) ?? { line, count: 0 };
		counts.set(key, row); row.count++;
		if (row.count > max) { best = row.line; max = row.count; }
	}
	const line = best || lines.find(l => /\b(?:error|fail(?:ed|ure)?|gap|mismatch)\b/i.test(l)) || lines.find(l => l.trim()) || "";
	return line.trim();
}

/** @param {string} value @param {number} bytes */
export function preview(value, bytes) {
	if (bytes === Infinity || value.length <= bytes && Buffer.byteLength(JSON.stringify(value)) <= bytes) return value;
	const width = Math.floor(bytes / 12); // two ends, up to six JSON bytes per code unit
	return { length: value.length, first: value.slice(0, width).replace(/[\uD800-\uDBFF]$/, ""),
		last: width ? value.slice(-width).replace(/^[\uDC00-\uDFFF]/, "") : "" };
}

/** Exact literal search never requires echoing the entire query or hit. All ranges are
 * UTF-16, half-open, and only the returned slice (not the implied match) was displayed.
 * @param {Record<string,string|undefined>} id @param {string} source @param {string} content
 * @param {number} offset @param {number} available @param {string} [match]
 * @returns {{text:string,read:NonNullable<import("./model.js").Packet["read"]>}} */
export function textPage(id, source, content, offset, available, match) {
	const length = content.length, hit = match ? content.indexOf(match, offset) : undefined;
	if (hit === -1 || offset >= length) {
		const read = { source, start: offset, end: offset, length, miss: /** @type {const} */ (true) };
		return { read, text: JSON.stringify({ ...id, ...read, omitted: hit === -1 ? "No literal match from this offset." : "End of text." }) };
	}
	let start = hit === undefined ? offset : Math.max(offset, hit - Math.floor(available / 96));
	if (/[\uDC00-\uDFFF]/.test(content.charAt(start))) start++;
	const piece = (/** @type {number} */ end) => JSON.stringify({ ...id, start, end, length, hit, excerpt: content.slice(start, end) });
	if (hit !== undefined && ((match?.length ?? 1) > available || Buffer.byteLength(piece(Math.min(length, hit + (match?.length ?? 1)))) > available)) start = hit;
	// The available serialized bytes also upper-bound the number of UTF-16 units.
	let lo = start, hi = Math.min(length, start + available);
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (Buffer.byteLength(piece(mid)) <= available) lo = mid; else hi = mid - 1;
	}
	if (lo < length && /[\uD800-\uDBFF]/.test(content.charAt(lo - 1))) lo--;
	if (lo <= start) fail("packet_budget", "No text of the requested source fits alongside its pinned index.");
	return { text: piece(lo), read: { source, start, end: lo, length, ...(hit === undefined ? {} : { hit }) } };
}

/** @typedef {{path:string,oid:string,text:string,omitted?:never} | {path:string,oid?:string,omitted:string,text?:never}} FileRow */

/** @param {Map<string,FileRow>} index */
export const indexBytes = index => [...index.values()].reduce((n, {path, oid, omitted}) =>
	n + Buffer.byteLength(JSON.stringify({path, oid, omitted})) + 1, 0);

/** The unpaged packet shows these file groups in full. Only complete text is citable;
 * keep omissions in the same ordered index used to select a bounded page.
 * @param {Iterable<Iterable<FileRow>>} groups */
export function wholeEvidence(groups) {
	/** @type {Map<string,FileRow>} */ const index = new Map();
	/** @type {Map<string,string>} */ const files = new Map();
	let partial = false;
	for (const group of groups) for (const file of group) {
		index.set(file.path, file);
		if (file.text === undefined) partial = true;
		else files.set(file.path, file.oid);
	}
	return { index, files: Object.fromEntries(files), partial };
}

/** Pack whole blobs when possible. Only the requested blob may be split, and its
 * receipt identifies precisely the displayed range (UTF-16 indices, never half a surrogate).
 * @param {Map<string,FileRow>} rows @param {number} bytes @param {string} charter
 * @param {string|undefined} focus @param {number} start @param {string} [match]
 * @param {string} [anchor] Approved excerpt to center on only if the whole file does not fit. */
export function evidencePage(rows, bytes, charter, focus, start, match, anchor) {
	const target = focus && rows.get(focus);
	const index = [...rows.values()].map(({ path, oid, omitted }) => JSON.stringify({ path, oid, ...(omitted ? { omitted } : {}) }));
	let free = bytes - Buffer.byteLength(index.join("\n"));
	if (free < 0) fail("packet_budget", indexBudgetError);
	const order = [...rows.values()].map((row, i) => ({ row, i })).sort((a, b) =>
		rank(a.row) - rank(b.row) || (a.row.text?.length ?? 0) - (b.row.text?.length ?? 0));
	/** @param {FileRow} r */
	function rank(r) {
		if (r.path === charter && r.text !== undefined && Buffer.byteLength(JSON.stringify(r)) < free / 2) return -1;
		return r.path === focus ? 0 : r.path === charter ? 1 : 2;
	}
	const files = new Map();
	/** @type {import("./model.js").Packet["excerpt"]} */ let excerpt;
	/** @type {import("./model.js").Packet["read"]} */ let read;
	for (const { row, i } of order) {
		if (row.text === undefined || !row.oid) {
			if (row === target) read = { source: `file:${row.path}`, start: 0, end: 0, length: 0, miss: true };
			continue;
		}
		const available = free + Buffer.byteLength(index[i]), whole = JSON.stringify(row);
		const lookup = row.path === focus ? match : undefined;
		if (!lookup && !(row === target && start) && Buffer.byteLength(whole) <= available) {
			files.set(row.path, row.oid); index[i] = whole;
		} else if (row.path === (focus ?? charter)) {
			const page = textPage({ path: row.path, oid: row.oid }, `file:${row.path}`, row.text, start, available, lookup ?? anchor);
			index[i] = page.text;
			if (row === target) read = page.read;
			if (!page.read.miss) excerpt = { path: row.path, oid: row.oid, start: page.read.start, end: page.read.end, length: page.read.length };
		} else continue;
		free = available - Buffer.byteLength(index[i]);
	}
	// Spend residual bytes on orientation only. These snippets are not whole-file
	// or focused-range citations and do not advance a requested file's cursor.
	const omitted = order.filter(({ row }) => row.text && row.path !== focus && row.path !== excerpt?.path && !files.has(row.path));
	for (const [k, { row, i }] of omitted.entries()) {
		const share = Math.floor(free / (omitted.length - k));
		const shown = preview(/** @type {string} */ (row.text), share);
		if (typeof shown === "string" || !shown.first && !shown.last) continue;
		const line = JSON.stringify({ path: row.path, oid: row.oid, preview: shown });
		const added = Buffer.byteLength(line) - Buffer.byteLength(index[i]);
		if (added <= free) { index[i] = line; free -= added; }
	}
	if (free < 0) fail("packet_budget", indexBudgetError);
	return { text: index.join("\n"), files: Object.fromEntries(files), ...(excerpt ? { excerpt } : {}), ...(read ? { read } : {}) };
}
