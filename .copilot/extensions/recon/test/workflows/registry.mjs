import { RECON_WORKFLOWS } from "../../workflows/registry.mjs";

/** @type {Readonly<Record<string, (typeof RECON_WORKFLOWS)[keyof typeof RECON_WORKFLOWS]>>} */
export const ADDITIONAL_WORKFLOWS = RECON_WORKFLOWS;
