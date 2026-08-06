export const CONVEYOR_IMPORT_CONTRACT_VERSION = 1;

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
        scriptSha256: "7b744759b9528876deafb8fef05f5ec438875ce04b7be7ad247d3749a1b38613",
        budget: 100,
        concurrency: 2,
        maxTotalAgents: 6,
        maxAgents: 9,
        timeoutSec: 300,
        model: "gpt-5-mini",
        effort: "medium",
    }),
});
