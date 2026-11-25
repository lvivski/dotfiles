import { sameEvaluation } from "./evidence.mjs";
import { digest, fail } from "./values.mjs";

/** @typedef {import("./model.js").Review} Review */
/** @typedef {import("./model.js").Observation} Observation */
/** @param {Review} a @param {Review} b */
const sameInputs = (a,b) => a.squad === b.squad && a.base === b.base && a.version === b.version && sameEvaluation(a,b);

/** @param {Review[]} history @param {Review} review */
export function* priorObservations(history, review) {
	for (const r of history) {
		if (r.id === review.id) break;
		if (r.state === "observed" && sameInputs(r,review)) yield r;
	}
}

export const evidenceDecision = "decide-from-evidence";
const repeatedRead = "Repeated read of unchanged pinned evidence";
/** @param {Review} review @param {Review|undefined} from */
export function validateReadParent(review, from) {
	const key = review.wake?.key;
	if (key && (key === evidenceDecision || /^(?:read|file|page):/.test(key)) &&
		(!from || !sameInputs(from,review) || from.observation?.outcome !== "needs-evidence"))
		fail("packet_budget", "Requested evidence context is not from this charter, revision and evaluator.");
}

/** @param {string} file */
const unchangedRead = file => `No further focused read of ${file}: the pinned evidence is unchanged`;
/** @param {Observation|undefined} o */
export const readSource = o => o?.file ? `file:${o.file}` : o?.receipt ? `receipt:${o.receipt}` : o?.detail ? `detail:${o.detail}` : undefined;

/** Only delivered text advances the contiguous prefix of a pinned blob. After EOF
 * a decision redisplays the last range, not an empty page beyond the end.
 * @param {Review[]} history @param {Review} review @param {string} file @param {string} [oid]
 * @returns {{kind:"unread"|"partial"|"complete", offset:number}} */
function fileProgress(history, review, file, oid) {
	/** @type {import("./model.js").Packet["excerpt"]} */ let last;
	for (const { packet } of [...priorObservations(history, review), review]) {
		if (!packet) continue;
		const pin = oid ?? last?.oid;
		if (Object.hasOwn(packet.files, file) && (!pin || packet.files[file] === pin)) return { kind: "complete", offset: 0 };
		const part = packet.excerpt;
		if (part?.path !== file || pin && part.oid !== pin) continue;
		const end = last?.end ?? 0;
		if (part.start <= end && end < part.end) last = part;
	}
	if (!last) return { kind: "unread", offset: 0 };
	return last.end === last.length ? { kind: "complete", offset: last.start } : { kind: "partial", offset: last.end };
}

/** @param {Review[]} history @param {Review} review @param {string|undefined} source */
function contextProgress(history, review, source) {
	let end = 0, last = 0, length = 0;
	const pages = [...priorObservations(history, review), review].flatMap(r => {
		const p = r.packet?.read;
		return p && p.source === source && !p.miss ? [p] : [];
	}).sort((a,b) => a.start - b.start);
	for (const p of pages) if (p.start <= end && end < p.end) { last = p.start; end = p.end; length = p.length; }
	if (end) return end === length ? {kind:"complete", offset:last} : {kind:"partial", offset:end};
}

/** Admission, reservation and packet rendering use the cursor of the *requesting* review.
 * Keep existing wake keys: they identify reads already spent on these immutable inputs.
 * @param {Review[]} history @param {Review} review @param {Observation} o @param {string} [oid] */
export function readCursor(history, review, o, oid) {
	if (o.file && !o.match && o.offset === undefined) {
		const progress = fileProgress(history, review, o.file, oid);
		const key = progress.kind === "partial" ? `page:${progress.offset}:${o.file}` : `file:${o.file}`;
		return {key, offset:progress.offset, progress};
	}
	const source = readSource(o);
	const progress = !o.file && !o.match && o.offset === undefined ? contextProgress(history, review, source) : undefined;
	const offset = o.offset ?? progress?.offset ?? 0;
	return {key:`read:${digest([source, o.match ?? null, offset])}`, offset, progress};
}

/** @param {Review[]} history @param {Review} review @param {Observation} o @param {boolean} previouslyRequested @param {string} [oid] */
export function validateRead(history, review, o, previouslyRequested, oid) {
	const source = readSource(o), offset = o.offset;
	if (offset !== undefined && offset !== 0 && ![...priorObservations(history,review), review].some(r => {
		const p = r.packet?.read;
		return p && p.source === source && !p.miss && offset < p.length &&
			(offset === p.end || o.match && p.hit !== undefined && offset === p.hit + 1);
	})) fail("unresolved_evidence", "No advancing cursor from the selected source");
	const {key, progress} = readCursor(history, review, o, oid);
	if ((!o.file || o.match || offset !== undefined) && (progress?.kind === "complete" ||
		history.some(r => sameInputs(r,review) && r.wake?.key === key))) fail("unresolved_evidence", repeatedRead);
	if (o.file && (Object.hasOwn(review.packet?.files ?? {}, o.file) ||
		previouslyRequested && !o.match && offset === undefined && progress?.kind !== "partial"))
		fail("unresolved_evidence", unchangedRead(o.file));
}

/** Another spelling of a query is not progress if it yields neither new text nor a later hit.
 * @param {Review[]} history @param {Review} review */
export function exhaustedRead(history, review) {
	const read = review.packet?.read;
	if (!read || read.miss) return !!read;
	if (!review.wake) return false; // An approved opening excerpt is not a repeated scout request.
	let end = read.start, furthestHit = -1;
	const earlier = [...priorObservations(history, review)].flatMap(r => r.packet?.read?.source === read.source ? [r.packet.read] : []);
	for (const p of earlier.sort((a,b) => a.start - b.start)) {
		if (read.hit !== undefined && read.hit === p.hit) return true;
		if (p.start <= end) end = Math.max(end, p.end);
		furthestHit = Math.max(furthestHit, p.hit ?? -1);
	}
	return end >= read.end && (read.hit === undefined || read.hit <= furthestHit);
}

/** Recover only a recorded refusal explained by the original packet's delivered text.
 * @param {Review[]} history @param {Review} r */
export function rejectedRead(history, r) {
	const o = r.observation;
	if (r.state !== "blocked" || o?.outcome !== "needs-evidence") return;
	if (o.file && r.error === unchangedRead(o.file)) return fileProgress(history, r, o.file);
	const source = readSource(o);
	if (!o.file && source && r.packet?.sources?.includes(source) && r.error === repeatedRead)
		return readCursor(history, r, o).progress;
}

/** The same evidence follow-up is eligible in ordinary discovery and in a scoped comparison.
 * @param {Review[]} history @param {Review} r @param {string} base @param {string} version */
export function readWake(history, r, base, version) {
	const o = r.observation;
	if (r.base !== base || r.version !== version || o?.outcome !== "needs-evidence") return;
	const key = r.state === "observed" ? readCursor(history,r,o).key :
		rejectedRead(history,r)?.kind === "complete" ? evidenceDecision : undefined;
	if (key && !history.some(p => sameInputs(p,r) && p.wake?.key === key)) return {review:r.id, key};
}
