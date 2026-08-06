import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
    analysisInputDigest,
    buildPlanningArgs,
    buildVerificationInput,
    normalizePlanningInput,
    stableStringify,
    validatePlanningResult,
    validateVerificationResult,
} from "./analysis.mjs";
import {
    CONVEYOR_IMPORT_CONTRACT_VERSION,
    MOBIUS_CONVEYORS,
} from "./scripts.mjs";

export class MobiusConveyorError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = "MobiusConveyorError";
        this.code = code;
        this.details = details;
    }
}

function fail(code, message, details) {
    throw new MobiusConveyorError(code, message, details);
}

function scriptPath(specification) {
    return fileURLToPath(new URL(specification.relativePath, import.meta.url));
}

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function canonicalSource(value) {
    return String(value).replace(/\r\n?/g, "\n");
}

async function currentScript(specification) {
    const pathname = scriptPath(specification);
    let source;
    try {
        const metadata = await lstat(pathname);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
            fail(
                "conveyor_script_invalid",
                `Pinned Conveyor script is not a regular file: ${pathname}`,
            );
        }
        source = await readFile(pathname, "utf8");
    } catch (error) {
        if (error instanceof MobiusConveyorError) throw error;
        fail(
            "conveyor_backend_unavailable",
            `Mobius Conveyor script could not be read: ${pathname}`,
            { filesystemCode: error?.code ?? null },
        );
    }
    const actual = sha256(canonicalSource(source));
    if (actual !== specification.scriptSha256) {
        fail(
            "conveyor_script_drift",
            `Mobius refuses to run an unpinned ${specification.name} script`,
            {
                expectedSha256: specification.scriptSha256,
                actualSha256: actual,
            },
        );
    }
    return { pathname, source };
}

async function conveyorApi() {
    try {
        return await import("../conveyor/runs.mjs");
    } catch (error) {
        fail(
            "conveyor_backend_unavailable",
            "Mobius requires the user-scoped Conveyor extension",
            { cause: error?.message ?? String(error) },
        );
    }
}

function launchSpec(specification, pathname, args) {
    return {
        scriptPath: pathname,
        args,
        budget: specification.budget,
        concurrency: specification.concurrency,
        restricted: true,
        strictBudget: true,
        enableMcp: false,
        timeoutSec: specification.timeoutSec,
        ...(specification.model ? { model: specification.model } : {}),
        ...(specification.effort ? { effort: specification.effort } : {}),
        background: true,
        progress: "dashboard",
    };
}

async function loadRun(runId, specification) {
    const script = await currentScript(specification);
    const api = await conveyorApi();
    let run;
    try {
        run = api.loadConveyorRunForImport(runId);
    } catch (error) {
        const message = error?.message ?? String(error);
        fail(
            /no conveyor run found/i.test(message)
                ? "conveyor_run_not_found"
                : "conveyor_run_invalid",
            message,
            { runId },
        );
    }
    if (run.importContractVersion !== CONVEYOR_IMPORT_CONTRACT_VERSION) {
        fail(
            "conveyor_format_unsupported",
            `Mobius requires Conveyor import contract ${CONVEYOR_IMPORT_CONTRACT_VERSION}`,
            {
                runId,
                actualContractVersion: run.importContractVersion,
            },
        );
    }
    const importedScriptSha256 = sha256(canonicalSource(run.source));
    if (run.conveyor !== specification.name
        || importedScriptSha256 !== specification.scriptSha256) {
        fail(
            "conveyor_run_identity_mismatch",
            `Conveyor run ${runId} did not execute the pinned ${specification.name} script`,
            {
                conveyor: run.conveyor,
                scriptSha256: importedScriptSha256,
            },
        );
    }
    if (run.restricted !== true
        || run.enableMcp !== false
        || run.strictBudget !== true
        || run.hostPath !== null
        || run.preservedWorktrees.length > 0) {
        fail(
            "conveyor_run_not_read_only",
            `Conveyor run ${runId} was not restricted to analysis-only execution`,
            {
                restricted: run.restricted,
                enableMcp: run.enableMcp,
                strictBudget: run.strictBudget,
                hostPath: run.hostPath,
                preservedWorktrees: run.preservedWorktrees,
            },
        );
    }
    const expectedLimits = {
        maxConcurrentAgents: specification.concurrency,
        maxTotalAgents: specification.maxTotalAgents,
        timeoutSeconds: specification.timeoutSec,
        maxAiCredits: specification.budget,
    };
    if (typeof run.previewPlanId !== "string"
        || run.previewPlanId.length === 0
        || run.model !== (specification.model ?? null)
        || run.effort !== (specification.effort ?? null)
        || run.context !== null
        || run.progressMode !== "dashboard"
        || run.maxAgents !== specification.maxAgents
        || stableStringify(run.declaredLimits)
            !== stableStringify(expectedLimits)) {
        fail(
            "conveyor_launch_mismatch",
            `Conveyor run ${runId} does not match the immutable Mobius preview settings`,
            {
                previewPlanId: run.previewPlanId,
                model: run.model,
                effort: run.effort,
                context: run.context,
                progressMode: run.progressMode,
                maxAgents: run.maxAgents,
                declaredLimits: run.declaredLimits,
            },
        );
    }
    return { run, script };
}

function assertArgs(run, expectedArgs) {
    const expectedSha256 = analysisInputDigest(expectedArgs);
    if (run.argsSha256 !== expectedSha256
        || stableStringify(run.args) !== stableStringify(expectedArgs)) {
        fail(
            "conveyor_input_mismatch",
            `Conveyor run ${run.runId} arguments do not match the canonical Mobius input`,
            {
                expectedSha256,
                actualSha256: run.argsSha256,
            },
        );
    }
}

function assertComplete(run) {
    if (run.status !== "complete" || run.resultAvailable !== true) {
        fail(
            "conveyor_result_unavailable",
            `Conveyor run ${run.runId} is ${run.status} and has no importable result`,
            {
                status: run.status,
                resultAvailable: run.resultAvailable,
                failure: run.failure ?? null,
            },
        );
    }
}

export async function preparePlanningConveyor(input) {
    const args = buildPlanningArgs(input);
    const specification = MOBIUS_CONVEYORS.plan;
    const script = await currentScript(specification);
    return {
        backend: "conveyor",
        workflow: specification.name,
        inputDigest: args.inputDigest,
        launchSpec: launchSpec(specification, script.pathname, args),
    };
}

export async function importPlanningConveyor(runId) {
    const specification = MOBIUS_CONVEYORS.plan;
    const { run } = await loadRun(runId, specification);
    assertComplete(run);
    const { inputDigest, ...rawInput } = run.args ?? {};
    const normalized = normalizePlanningInput(rawInput);
    const expectedArgs = {
        ...normalized,
        inputDigest: analysisInputDigest(normalized),
    };
    if (inputDigest !== expectedArgs.inputDigest) {
        fail(
            "conveyor_input_mismatch",
            `Conveyor run ${runId} carries an invalid planning digest`,
        );
    }
    assertArgs(run, expectedArgs);
    return {
        runId,
        inputDigest,
        plan: validatePlanningResult(
            run.result,
            normalized,
            normalized.maxTasks,
        ),
    };
}

export async function prepareVerificationConveyor(plan) {
    const args = buildVerificationInput(plan);
    const specification = MOBIUS_CONVEYORS.verify;
    const script = await currentScript(specification);
    return {
        backend: "conveyor",
        workflow: specification.name,
        inputDigest: args.inputDigest,
        launchSpec: launchSpec(specification, script.pathname, args),
    };
}

export async function inspectVerificationConveyor(runId, plan, options = {}) {
    const specification = MOBIUS_CONVEYORS.verify;
    const { run } = await loadRun(runId, specification);
    const expectedArgs = buildVerificationInput(plan);
    assertArgs(run, expectedArgs);
    if (options.requireComplete) {
        assertComplete(run);
    } else if (run.status !== "running"
        && !(run.status === "complete" && run.resultAvailable === true)) {
        fail(
            "conveyor_result_unavailable",
            `Conveyor run ${runId} cannot be bound from ${run.status}`,
            { status: run.status, resultAvailable: run.resultAvailable },
        );
    }
    return {
        run,
        inputDigest: expectedArgs.inputDigest,
        ...(run.resultAvailable
            ? { result: validateVerificationResult(run.result, expectedArgs) }
            : {}),
    };
}

export async function verificationRunCanBeReplaced(runId, plan) {
    const api = await conveyorApi();
    const activity = api.getConveyorRunActivity(runId);
    if (!activity.exists) {
        return true;
    }
    if (activity.active) {
        return false;
    }
    try {
        await inspectVerificationConveyor(runId, plan, {
            requireComplete: true,
        });
        return false;
    } catch (error) {
        const latest = api.getConveyorRunActivity(runId);
        if (latest.active) {
            return false;
        }
        if (error?.code !== "conveyor_backend_unavailable") {
            return true;
        }
        throw error;
    }
}
