import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { linkedGeneration } from "./binding.mjs";
import { admitted } from "./native.mjs";
import { git } from "./product.mjs";
import { fail, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {string} id */
export const workspaceName = id => `.foundry-job-${id}`;

/** The named recipient can confirm an issued handoff using the token it received,
 * even when its turn beats the sender's queue acknowledgement. Never resend it.
 * @param {Run} run @param {string} actor @param {string} token @param {string} cwd */
export function acceptWorkspace(run, actor, token, cwd) {
	admitted(run);
	const n = Object.values(run.nodes).find(n => n.workspace && n.state === "writing" && n.token === token);
	const w = n && run.effects.find(e => e.id === n.workspace);
	if (!n || w?.kind !== "writer" || !w.pooled || w.pooled.home !== cwd ||
		(w.tool === "session.send" ? w.issuer : w.args.session_id) !== actor)
		fail("stale_assignment", "Need the current pooled writer's writable assignment in its native worktree");
	if (w.state === "done" && n.worker === actor && w.nativeId === actor) return;
	if (n.worker || w.token !== token || !w.callId || w.permissionHold || w.state !== "issued" && w.state !== "uncertain")
		fail("dispatch_held", "The pooled assignment was not issued to this session");
	n.worker = w.nativeId = actor;
	w.boundAt = Date.now(); w.state = "done"; delete w.error;
}

/** @param {string} cwd @param {Run} run @param {import("./model.js").Node} n @param {boolean} [create] */
export function writerRoot(cwd, run, n, create = false) {
	if (!n.workspace) return cwd;
	const w = run.effects.find(e => e.id === n.workspace);
	if (w?.kind !== "writer" || !w.pooled || w.nativeId !== n.worker || !n.worker || w.state !== "done" || w.pooled.generation !== n.generation ||
		cwd !== w.pooled.home || realpathSync(cwd) !== cwd) fail("wrong_workspace", "Not the confirmed pooled writer's native worktree");
	const root = path.join(cwd, workspaceName(w.id));
	if (!lstatSync(root, {throwIfNoEntry:false})) {
		if (!create) fail("missing_workspace", "Call foundry_workspace before working on this assignment");
		const original = run.effects.find(e => e.tool === "create_session" && e.nativeId === n.worker);
		linkedGeneration(cwd, text(original?.args.base_branch, "original native generation"), cwd);
		git(cwd, ["worktree", "add", "--detach", root, w.pooled.generation]);
	}
	if (realpathSync(root) !== root) fail("wrong_workspace", "The pooled workspace path is linked");
	linkedGeneration(root, w.pooled.generation, cwd);
	return root;
}
