import { FOUNDRY_WORKFLOWS } from "../../workflows/registry.mjs";

const CONTROL_PLANE_WORKFLOWS = new Set(["plan", "plan-repair", "verify"]);

/** @type {Readonly<Record<string, (typeof FOUNDRY_WORKFLOWS)[keyof typeof FOUNDRY_WORKFLOWS]>>} */
export const ADDITIONAL_WORKFLOWS = Object.freeze(Object.fromEntries(
	Object.entries(FOUNDRY_WORKFLOWS).filter(
		([, definition]) => !CONTROL_PLANE_WORKFLOWS.has(definition.meta.name),
	),
));
