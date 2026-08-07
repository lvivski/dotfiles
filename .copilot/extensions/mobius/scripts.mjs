/**
 * Pinned Conveyor workflow identities and immutable launch limits.
 *
 * @module mobius/scripts
 */

/**
 * Read-only Conveyor run import contract expected by Mobius.
 *
 * @type {number}
 */
export const CONVEYOR_IMPORT_CONTRACT_VERSION = 1;

/**
 * @typedef {object} MobiusConveyorSpecification
 * @property {string} name Persisted Conveyor identity.
 * @property {string} relativePath Bundled workflow path relative to this module.
 * @property {string} scriptSha256 Canonical-LF SHA-256 pin.
 * @property {number} budget Maximum AI credit budget.
 * @property {number} concurrency Maximum parallel workflow agents.
 * @property {number} maxTotalAgents Maximum agents spawned over the run.
 * @property {number} maxAgents Host-approved hard agent ceiling.
 * @property {number} timeoutSec Workflow deadline in seconds.
 * @property {string} model Required model identifier.
 * @property {string} effort Required reasoning effort.
 */

/**
 * Immutable specifications for the bundled planning and verification workflows.
 *
 * @type {Readonly<Record<"plan"|"verify", Readonly<MobiusConveyorSpecification>>>}
 */
export const MOBIUS_CONVEYORS = Object.freeze({
    plan: Object.freeze({
        name: "mobius-plan",
        relativePath: "./conveyors/plan.mjs",
        scriptSha256: "f81dce7fb0c5f1761361225ec37a2e5dd6915eecc0b7d35ba6a1777c5a052c83",
        budget: 30,
        concurrency: 2,
        maxTotalAgents: 8,
        maxAgents: 15,
        timeoutSec: 300,
        model: "gpt-5-mini",
        effort: "medium",
    }),
    verify: Object.freeze({
        name: "mobius-verify",
        relativePath: "./conveyors/verify.mjs",
        scriptSha256: "57b14283127de3d0a2db71c04220fc71d44b3e941e7714f750a95cef67332163",
        budget: 100,
        concurrency: 2,
        maxTotalAgents: 6,
        maxAgents: 9,
        timeoutSec: 300,
        model: "gpt-5-mini",
        effort: "medium",
    }),
});
