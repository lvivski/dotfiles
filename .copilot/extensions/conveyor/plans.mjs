/** @module plans — durable dry-run plans that bind identity and hard execution ceilings. */
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { atomicWriteFile, atomicWriteJson, hashValue, readJsonFile } from "./persistence.mjs";
import { snapshotHost, verifyHostSnapshot } from "./snapshot.mjs";
const HOME = homedir();
export const plansDir = () => process.env.CONVEYOR_PLANS_DIR || join(process.env.CONVEYOR_DIR || join(HOME, ".copilot/conveyors"), "plans");

/** @param {{ source: string, hostPath?: string|null, args: unknown, cfg: any, plannedAgents: number }} input */
export function persistConveyorPlan(input) {
	const planId = `plan-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
	const dir = join(plansDir(), planId);
	const scriptPath = join(dir, "script.mjs");
	atomicWriteFile(scriptPath, input.source);
	/** @type {string|null} */
	let hostPath = null;
	if (input.hostPath) {
		hostPath = join(dir, "host");
		snapshotHost(input.hostPath, hostPath);
	}
	const plan = {
		planId,
		createdAt: new Date().toISOString(),
		scriptPath,
		hostPath,
		sourceHash: hashValue(input.source),
		args: input.args ?? null,
		argsHash: hashValue(input.args),
		hostHash: hostPath ? hashValue(verifyHostSnapshot(hostPath).manifest) : null,
		cwd: input.cfg.cwd,
		model: input.cfg.model,
		effort: input.cfg.effort,
		context: input.cfg.context,
		enableMcp: !!input.cfg.enableMcp,
		restricted: !!input.cfg.restricted,
		strictBudget: !!input.cfg.strictBudget,
		memoryPath: input.cfg.memoryPath,
		progressMode: input.cfg.progressMode,
		maxAgents: input.plannedAgents,
		limits: input.cfg.limits || {},
		retainAgentContent: input.cfg.retainAgentContent === true,
	};
	atomicWriteJson(join(dir, "plan.json"), plan);
	return plan;
}

/** @param {string} planId */
export function loadConveyorPlan(planId) {
	if (!/^plan-[A-Za-z0-9-]+$/.test(planId)) return null;
	const plan = readJsonFile(join(plansDir(), planId, "plan.json"));
	if (!plan || plan.planId !== planId) return null;
	if (!existsSync(plan.scriptPath)) return null;
	if (hashValue(readFileSync(plan.scriptPath, "utf8")) !== plan.sourceHash) return null;
	if (plan.hostPath) {
		try {
			if (!statSync(plan.hostPath).isDirectory() || hashValue(verifyHostSnapshot(plan.hostPath).manifest) !== plan.hostHash) return null;
		} catch {
			return null;
		}
	}
	if (hashValue(plan.args) !== plan.argsHash) return null;
	return plan;
}

/** Delete one validated plan after its first real run has started. @param {string} planId */
export function consumeConveyorPlan(planId) {
	if (!/^plan-[A-Za-z0-9-]+$/.test(planId)) return false;
	const dir = join(plansDir(), planId);
	if (!existsSync(dir)) return false;
	rmSync(dir, { recursive: true, force: true });
	return true;
}
