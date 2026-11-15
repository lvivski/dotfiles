import { FOUNDRY_WORKFLOWS } from "../../workflows/registry.mjs";

/** @type {Readonly<Record<string, (typeof FOUNDRY_WORKFLOWS)[keyof typeof FOUNDRY_WORKFLOWS]>>} */
export const ADDITIONAL_WORKFLOWS = FOUNDRY_WORKFLOWS;
