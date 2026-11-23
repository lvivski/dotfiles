import { checkReceipt } from "./evidence.mjs";
import { digest, fail, name, text } from "./values.mjs";

/** @typedef {import("./model.js").ReviewNote} Note */
/** @typedef {import("./model.js").Run} Run */
/** @param {unknown} s */
export const noteText = s => typeof s === "string" && !!s.trim() && !s.includes("\0");
/** @param {Note} n */
export const noteId = n => digest([n.receipt, n.question, n.excerpt ?? null]);
/** @param {import("./model.js").Review} r */
export const attachedNotes = r => r.note ? [r.note, ...r.otherNotes ?? []] : [];

/** @param {import("./model.js").Effect|undefined} e @param {Pick<Note,"receipt"|"excerpt">} note */
export function sourceReceipt(e, note) {
	const r = e?.kind === "goal" && e.id === note.receipt ? checkReceipt(e) : undefined;
	if (r && r.exit !== null && (note.excerpt === undefined || noteText(note.excerpt) && r.output.includes(note.excerpt))) return r;
}

/** @param {Run} run @param {import("./model.js").Review} review */
export function attachNotes(run, review) {
	const at = run.effects.indexOf(review);
	const eligible = run.pendingReviewNotes?.filter(n => n.squad === review.squad && n.after <= at);
	if (!eligible?.length) return;
	const [first, ...rest] = eligible.map(({ squad, after, ...note }) => note);
	review.note = first;
	if (rest.length) review.otherNotes = rest;
	const used = new Set(eligible);
	run.pendingReviewNotes = run.pendingReviewNotes?.filter(n => !used.has(n));
}

/** @param {Run} run @param {Record<string,unknown>} args */
export function queueNote(run, args) {
	const squad = name(args.squad, "squad"), receipt = name(args.receipt, "receipt ID"), question = text(args.question, "question");
	if (!run.policy.squads.some(s => s.id === squad)) fail("invalid_charter", "Unknown scout squad");
	const note = { receipt, question, ...(args.excerpt !== undefined ? { excerpt: text(args.excerpt, "receipt excerpt") } : {}) };
	if (!sourceReceipt(run.effects.find(e => e.id === receipt), note))
		fail("invalid_receipt", "Select a completed goal receipt ID in this run; an optional excerpt must be a verbatim excerpt.");
	/** @param {Note} n */
	const same = n => n.receipt === receipt && n.question === question && n.excerpt === note.excerpt;
	if (run.pendingReviewNotes?.some(n => n.squad === squad && same(n)) ||
		run.effects.some(e => e.kind === "scout" && e.squad === squad && attachedNotes(e).some(same))) return;
	// The append-only effect position excludes existing reviews, including ones not yet issued.
	(run.pendingReviewNotes ??= []).push({ ...note, squad, after: run.effects.length });
}
