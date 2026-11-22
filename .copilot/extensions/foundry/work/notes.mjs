import { checkReceipt } from "./evidence.mjs";
import { fail, name, text } from "./values.mjs";

/** @typedef {import("./model.js").ReviewNote} Note */
/** @typedef {import("./model.js").Run} Run */
/** @param {unknown} s @param {number} bytes */
export const boundedText = (s, bytes) => typeof s === "string" && !!s.trim() && Buffer.byteLength(s) <= bytes;

/** @param {import("./model.js").Effect|undefined} e @param {Pick<Note,"receipt"|"excerpt">} note */
export function sourceReceipt(e, note) {
	const r = e?.kind === "goal" && e.id === note.receipt ? checkReceipt(e) : undefined;
	if (r && r.exit !== null && (note.excerpt === undefined ? Buffer.byteLength(r.output) <= 8192 :
		boundedText(note.excerpt, 8192) && r.output.includes(note.excerpt))) return r;
}

/** @param {Run} run @param {Record<string,unknown>} args */
export function queueNote(run, args) {
	const squad = name(args.squad, "squad"), receipt = name(args.receipt, "receipt ID"), question = text(args.question, "question");
	if (!run.policy.squads.some(s => s.id === squad)) fail("invalid_charter", "Unknown scout squad");
	if (!boundedText(question, 1024)) fail("invalid_field", "The scout question must fit in 1024 UTF-8 bytes");
	const note = { receipt, question, ...(args.excerpt !== undefined ? { excerpt: text(args.excerpt, "receipt excerpt") } : {}) };
	if (!sourceReceipt(run.effects.find(e => e.id === receipt), note))
		fail("invalid_receipt", "Select a completed goal receipt ID in this run. For long output supply a verbatim excerpt of at most 8192 UTF-8 bytes.");
	/** @param {Note} n */
	const same = n => n.receipt === receipt && n.question === question && n.excerpt === note.excerpt;
	const pending = run.pendingReviewNotes?.find(n => n.squad === squad);
	if (pending && same(pending) || run.effects.some(e => e.kind === "scout" && e.squad === squad && e.note && same(e.note))) return;
	if (pending) fail("note_pending", "This squad already has a different pending review note");
	// The append-only effect position excludes existing reviews, including ones not yet issued.
	(run.pendingReviewNotes ??= []).push({ ...note, squad, after: run.effects.length });
}
