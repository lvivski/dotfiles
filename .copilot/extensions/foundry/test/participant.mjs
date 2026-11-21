import assert from "node:assert/strict";
import { createRuntime } from "../work/runtime.mjs";
import { nativeHost, put } from "./fixture.mjs";

// Each invocation is one delivered scout or writer turn in its actual assigned worktree.
const [root, run, actor, token, op, payload, gate, withhold] = process.argv.slice(2);
const host = nativeHost(root, token);
/** @type {string[]} */ const lost = [];
const runtime = createRuntime(process.cwd(), {
	mode: async () => "interactive", permissionBlocker: async () => null, confirm: async () => assert.fail("unexpected activation"),
	select: async () => assert.fail("unexpected capacity prompt"),
	execute: async (tool, args, id) => {
		if (withhold && tool === "bash" && String(args.description).startsWith(`Check ${withhold} at `)) {
			lost.push(String(args.shellId));
			return { resultType: "success" }; // Shell reply, but no runner and no durable verdict.
		}
		return host.execute(tool, args, id);
	},
	remind: async (id, next) => { assert.equal(id, run); host.inbox.push({ worker: actor, token: next }); return next; }
});
try {
	if (op === "observe") {
		await runtime.operation(op, { run, token, ...JSON.parse(payload) }, actor);
	} else {
		assert.equal(op, "submit");
		const n = (await runtime.operation("status", { run }, actor)).nodes.find(n => n.token === token);
		assert.ok(n?.state === "writing");
		process.env.FOUNDRY_TEST_WRITER = String(process.pid);
		process.env.FOUNDRY_TEST_RENDEZVOUS = gate;
		put(process.cwd(), `${n.directory}/index.mjs`, payload);
		const reply = await runtime.operation(op, { run, token }, actor);
		const own = reply.nodes.find(a => a.grain === n.grain);
		if (own?.state === "writing" && own.token && own.token !== token) host.inbox.push({ worker: actor, token: own.token });
		if (withhold) {
			assert.equal(lost.length, 1);
			runtime.turn(actor, lost[0]); await runtime.flush();
			assert.equal(lost.length, 1, "a shell completion without a receipt must not replay the check");
		}
	}
	process.stdout.write(JSON.stringify({ workers: [...host.workers.values()], inbox: host.inbox }));
} finally { runtime.close(); }
