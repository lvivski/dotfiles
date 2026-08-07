/** @module extension — register the Factory-backed Conveyor runtime and its source launcher. */
import { defineFactory, joinSession } from "@github/copilot-sdk/extension";

import { CONVEYOR_FACTORY_META, executeConveyor } from "./factory.mjs";
import { buildTools } from "./tools.mjs";

const conveyor = defineFactory({
	meta: CONVEYOR_FACTORY_META,
	run: executeConveyor,
});

/** @type {import("@github/copilot-sdk").CopilotSession|null} */
let session = null;

const tools = buildTools({
	async getWorkspaceCwd() {
		try {
			return (await session?.rpc?.workspaces?.getWorkspace())?.workspace?.cwd;
		} catch {
			return undefined;
		}
	},
	async launch(args, limits) {
		if (!session) throw new Error("Conveyor has not joined the current session");
		return session.factory.run(conveyor, {
			args,
			...(Object.keys(limits).length ? { limits } : {}),
		});
	},
});

session = await joinSession({
	factories: [conveyor],
	tools,
});
