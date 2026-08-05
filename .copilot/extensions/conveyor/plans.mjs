/** @module plans — durable dry-run plans that bind identity and hard execution ceilings. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { FORMAT_VERSION, atomicWriteFile, atomicWriteJson, hashFile, hashValue, readJsonFile } from "./persistence.mjs";
const HOME = homedir();
export const plansDir = () => process.env.CONVEYOR_PLANS_DIR || join(process.env.CONVEYOR_DIR || join(HOME, ".copilot/conveyors"), "plans");

/** @param {{ source: string, hostPath?: string|null, args: unknown, cfg: any, plannedAgents: number }} input */
export function persistConveyorPlan(input) {
	const planId = `plan-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
	const dir = join(plansDir(), planId);
	const scriptPath = join(dir, "script.mjs");
	atomicWriteFile(scriptPath, input.source);
	let hostPath = null;
	if (input.hostPath) {
		hostPath = join(dir, "host.mjs");
		atomicWriteFile(hostPath, readFileSync(input.hostPath));
	}
	const plan = {
		formatVersion: FORMAT_VERSION,
		planId,
		createdAt: new Date().toISOString(),
		scriptPath,
		hostPath,
		sourceHash: hashValue(input.source),
		args: input.args ?? null,
		argsHash: hashValue(input.args),
		hostHash: hashFile(input.hostPath),
		cwd: input.cfg.cwd,
		budget: input.cfg.budget,
		model: input.cfg.model,
		effort: input.cfg.effort,
		context: input.cfg.context,
		concurrency: input.cfg.concurrency,
		enableMcp: !!input.cfg.enableMcp,
		restricted: !!input.cfg.restricted,
		strictBudget: !!input.cfg.strictBudget,
		memoryPath: input.cfg.memoryPath,
		progressMode: input.cfg.progressMode,
		maxAgents: input.plannedAgents,
	};
	atomicWriteJson(join(dir, "plan.json"), plan);
	return plan;
}

/** @param {string} planId */
export function loadConveyorPlan(planId) {
	if (!/^plan-[A-Za-z0-9-]+$/.test(planId)) return null;
	const plan = readJsonFile(join(plansDir(), planId, "plan.json"));
	if (!plan || plan.formatVersion !== FORMAT_VERSION || plan.planId !== planId) return null;
	if (!existsSync(plan.scriptPath)) return null;
	if (hashValue(readFileSync(plan.scriptPath, "utf8")) !== plan.sourceHash) return null;
	if (plan.hostPath && hashFile(plan.hostPath) !== plan.hostHash) return null;
	if (hashValue(plan.args) !== plan.argsHash) return null;
	return plan;
}
