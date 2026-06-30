// cwf extension — exposes the cwf dynamic-workflow engine as native Copilot CLI tools.
// `run_workflow` shells out to the `cwf` CLI (which spawns `copilot -p` subagents), streams
// progress into the session, and returns the synthesis. Engine: ~/.local/lib/copilot_workflows.

import { joinSession } from "@github/copilot-sdk/extension";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const HOME = homedir();
const POSIX = process.platform !== "win32";

const STDOUT_CAP = 8 * 1024 * 1024; // chars of synthesis retained
const STATS_TAIL = 2500; // chars of stderr returned as stats
const MAX_TIMEOUT_SEC = 7200; // hard ceiling on a single run

let session = null;

const cwfBin = () => (existsSync(join(HOME, ".local/bin/cwf")) ? join(HOME, ".local/bin/cwf") : "cwf");
const workflowsDir = () => process.env.CWF_WORKFLOWS_DIR ?? join(HOME, ".copilot/workflows");
const runsDir = () => process.env.CWF_RUNS_DIR ?? join(workflowsDir(), "runs");
const expandHome = (path) => (path?.startsWith("~/") ? join(HOME, path.slice(2)) : path);

const failure = (message, resultType = "failure") => ({ textResultForLlm: `Error: ${message}`, resultType, error: message });

class ValidationError extends Error {}
const check = (ok, message) => { if (!ok) throw new ValidationError(message); };

const log = (message, ephemeral = false) => {
	try {
		session?.log(message, ephemeral ? { ephemeral: true } : undefined)?.catch?.(() => {});
	} catch {}
};

// Reap detached cwf process groups if this extension is torn down mid-run — otherwise the
// `copilot` subagents orphan and keep spending AIC. (`exit` runs on a clean exit only,
// so the SIGTERM handler converts the CLI's shutdown signal into one.)
const liveGroups = new Set();
process.on("exit", () => {
	for (const pgid of liveGroups) try { process.kill(-pgid, "SIGKILL"); } catch {}
});
process.on("SIGTERM", () => process.exit());

// Write `data` to a fresh temp file, tracking its dir in `temps` for later cleanup.
function writeTemp(temps, prefix, name, data) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	const file = join(dir, name);
	writeFileSync(file, data, "utf8");
	return file;
}

// The extension's process.cwd() doesn't track the session cwd, so ask the SDK for it.
async function resolveCwd(explicit) {
	let dir = expandHome(explicit);
	if (!dir) {
		try { dir = (await session?.rpc?.workspaces?.getWorkspace())?.workspace?.cwd; } catch {}
		dir ??= process.cwd();
	}
	check(existsSync(dir), `cwd does not exist: ${dir}`);
	check(statSync(dir).isDirectory(), `cwd is not a directory: ${dir}`);
	return dir;
}

function resolveHarness(input, temps) {
	if (input.scriptPath) {
		const path = expandHome(input.scriptPath);
		check(existsSync(path) && statSync(path).isFile(), `scriptPath is not a readable file: ${path}`);
		return path;
	}
	if (input.name) {
		check(!/[\\/]|\.\./.test(input.name), `name must be a bare workflow name without path separators (got '${input.name}').`);
		const found = [`${input.name}.cwf.py`, `${input.name}.py`].map((f) => join(workflowsDir(), f)).find(existsSync);
		check(found, `no saved workflow named '${input.name}' in ${workflowsDir()} (looked for ${input.name}.cwf.py / ${input.name}.py).`);
		return found;
	}
	return writeTemp(temps, "cwf-harness-", "harness.cwf.py", input.script);
}

// Spawn cwf in its own process group so a timeout kills the whole copilot subagent tree
// (Node's built-in timeout would only reap the direct child, orphaning the subagents).
function runCwf(argv, { cwd, timeoutSec, onLine }) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cwfBin(), argv, { cwd, env: process.env, detached: POSIX });
		} catch (error) {
			return resolve({ spawnError: error.message });
		}
		const { pid } = child;
		if (POSIX && pid) liveGroups.add(pid);
		child.stdout.setEncoding("utf8");

		let stdout = "";
		let truncated = false;
		let timedOut = false;
		const recent = [];

		const kill = (signal) => {
			try {
				if (POSIX && pid) process.kill(-pid, signal);
				else child.kill(signal);
			} catch {}
		};
		let killTimer;
		const timer = setTimeout(() => {
			timedOut = true;
			kill("SIGTERM");
			killTimer = setTimeout(() => kill("SIGKILL"), 5000);
			killTimer.unref();
		}, Math.max(1, timeoutSec) * 1000);

		child.stdout.on("data", (chunk) => {
			if (truncated) return;
			stdout += chunk;
			if (stdout.length >= STDOUT_CAP) {
				stdout = stdout.slice(0, STDOUT_CAP);
				truncated = true;
			}
		});

		createInterface({ input: child.stderr }).on("line", (raw) => {
			const line = raw.trim();
			if (!line) return;
			const shown = onLine(line) ?? line;
			recent.push(shown);
			if (recent.length > 120) recent.shift();
		});

		const settle = (extra) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			if (POSIX && pid) liveGroups.delete(pid);
			resolve({ stdout, truncated, timedOut, tail: recent.join("\n").slice(-STATS_TAIL), ...extra });
		};
		child.on("error", (error) => settle({ spawnError: error.message }));
		child.on("close", (code, signal) => settle({ code, signal }));
	});
}

async function runWorkflow(input = {}) {
	const temps = [];
	try {
		const sources = ["script", "scriptPath", "name"].filter((key) => input[key]);
		check(sources.length === 1, `provide EXACTLY ONE of script | scriptPath | name (got: ${sources.join(", ") || "none"}).`);

		const budget = input.budget ?? (input.preset === "xtreme" ? 1000000 : 10000);
		check(typeof budget === "number" && budget > 0, `budget must be a positive number (got ${budget}).`);
		check(input.concurrency == null || (Number.isInteger(input.concurrency) && input.concurrency >= 1), `concurrency must be an integer >= 1 (got ${input.concurrency}).`);
		const requestedTimeout = input.timeoutSec ?? 1800;
		check(typeof requestedTimeout === "number" && requestedTimeout >= 1, `timeoutSec must be a number >= 1 (got ${requestedTimeout}).`);
		check(!(input.resume && input.script), "resume requires scriptPath or name (the persisted harness), not an inline script.");
		const timeoutSec = Math.min(requestedTimeout, MAX_TIMEOUT_SEC);

		const harness = resolveHarness(input, temps);
		const cwd = await resolveCwd(input.cwd);
		const runId = input.resume ?? `ext-${Date.now()}-${randomUUID().slice(0, 8)}`;
		const argsFile = input.args !== undefined ? writeTemp(temps, "cwf-args-", "args.json", JSON.stringify(input.args)) : null;

		const argv = [
			"run", harness,
			"--budget", String(budget),
			...(argsFile ? ["--args", `@${argsFile}`] : []),
			...(input.model ? ["--model", String(input.model)] : []),
			...(input.effort ? ["--effort", String(input.effort)] : []),
			...(input.context ? ["--context", String(input.context)] : []),
			...(input.preset ? ["--preset", String(input.preset)] : []),
			...(input.concurrency != null ? ["--concurrency", String(input.concurrency)] : []),
			...(input.enableMcp ? ["--enable-mcp"] : []),
			...(input.restricted ? ["--restricted"] : []),
			...(input.strictBudget ? ["--strict-budget"] : []),
			...(input.quiet ? ["--quiet"] : []),
			...(input.dryRun ? ["--dry-run"] : []),
			...(input.resume ? ["--resume", input.resume] : ["--run-id", runId]),
		];

		const label = input.name ?? input.scriptPath ?? "inline harness";
		const note = input.script && !input.restricted ? " — UNRESTRICTED Python" : "";
		log(`cwf: ${label} (${input.dryRun ? "dry-run" : `budget ${budget} AIC`}, run ${runId}, cwd ${cwd})${note}`);

		let streamed = 0;
		let usedAic = 0;
		const withAic = (line) => {
			const m = line.match(/^\s*(OK|ERR)\s+.*?\s([0-9]+(?:\.[0-9]+)?)\s+AIC\b/);
			if (m) usedAic += Number(m[2]);
			return `${line}  [AIC used: ${usedAic.toFixed(1)}]`;
		};
		const result = await runCwf(argv, {
			cwd,
			timeoutSec,
			onLine: (line) => {
				const shown = withAic(line);
				if (streamed++ < 400) log(shown, true);
				return shown;
			},
		});

		const ok = !result.spawnError && !result.timedOut && result.code === 0;
		const persisted = join(runsDir(), runId, "harness.py");
		const answer = (result.stdout ?? "").trim();
		const status =
			result.spawnError ? `cwf run FAILED to start: ${result.spawnError}`
			: result.timedOut ? `cwf run TIMED OUT after ${timeoutSec}s (process tree killed)`
			: ok ? "cwf run complete"
			: `cwf run FAILED (exit ${result.code}${result.signal ? `, signal ${result.signal}` : ""})`;

		const text = [
			status,
			`runId: ${runId}${input.resume ? " (resumed)" : ""}`,
			existsSync(persisted) ? `harness (edit, then re-run with scriptPath): ${persisted}` : `harness: ${harness}`,
			input.dryRun ? "mode: dry-run (no agents spawned, no AIC spent)" : `budget: ${budget} AIC`,
			input.dryRun ? "AIC used: 0.0" : `AIC used: ${usedAic.toFixed(1)}`,
			`cwd: ${cwd}`,
			!input.quiet && result.tail ? `\n--- cwf progress / stats (stderr) ---\n${result.tail}` : "",
			answer ? `\n--- workflow output ---\n${answer}${result.truncated ? "\n…(stdout truncated at 8MB)" : ""}` : ok ? "\n(workflow produced no stdout)" : "",
		].filter(Boolean).join("\n");

		return ok ? text : { textResultForLlm: text, resultType: result.timedOut ? "timeout" : "failure", error: result.spawnError ?? (result.timedOut ? `timed out after ${timeoutSec}s` : `cwf exited ${result.code}`) };
	} catch (error) {
		if (error instanceof ValidationError) return failure(error.message);
		log(`run_workflow internal error: ${error?.stack ?? error}`);
		return failure(`internal cwf extension error: ${error?.message ?? error}`);
	} finally {
		for (const dir of temps) {
			try { rmSync(dir, { recursive: true, force: true }); } catch {}
		}
	}
}

session = await joinSession({
	tools: [
		{
			name: "run_workflow",
			defer: "never", // always discoverable, no tool search
			// No `skipPermission`: workflows spend AIC, so the user approves each run.
			description:
				"Run a cwf DYNAMIC WORKFLOW: a Python harness that fans work out to many `copilot` " +
				"subagents in parallel (fan-out/synthesize, adversarial verify, tournament, " +
				"generate-and-filter, classify-and-route, loop-until-done). The harness owns the loop, " +
				"branching, and intermediate results; only the final synthesis returns here. Use for " +
				"large/parallel/adversarial/cross-checked work (codebase audits, deep research, ranking/" +
				"triage) — NOT routine edits or quick lookups. Spends AIC, so ALWAYS " +
				"preview with dryRun:true first, then run with a deliberate budget. Provide EXACTLY ONE of: " +
				"`script` (inline harness source using the injected `wf` + `args` API — see " +
				"~/.local/lib/copilot_workflows/README.md), `scriptPath` (a .py harness on disk), or `name` " +
				"(a saved workflow in ~/.copilot/workflows, e.g. 'deep-research'). The result reports the " +
				"persisted harness path + runId so you can Edit the harness and re-run it with the same " +
				"scriptPath, or continue it with resume.",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					script: { type: "string", description: "Inline Python harness source (synchronous; uses the injected `wf` runtime and `args`). One of script|scriptPath|name." },
					scriptPath: { type: "string", description: "Path to an existing .py harness on disk. One of script|scriptPath|name." },
					name: { type: "string", description: "Name of a saved workflow in ~/.copilot/workflows (resolves <name>.cwf.py or <name>.py). One of script|scriptPath|name." },
					args: { description: "Value exposed to the harness as the global `args`. Pass an actual JSON value (string/array/object), NOT a JSON-encoded string." },
					budget: { type: "number", exclusiveMinimum: 0, description: "Soft observed AIC cap. Default 10000, or 1000000 with preset='xtreme'. Set deliberately for the task size." },
					dryRun: { type: "boolean", description: "Plan only — show phases/approx agent count without spawning agents or spending AIC. Preview here first." },
					resume: { type: "string", description: "RunId of a prior run to resume; unchanged agents return instantly. Pass the same scriptPath/name." },
					model: { type: "string", description: "Session default model that agents inherit unless they pin their own in the script (the harness's per-agent choice wins). Any Copilot model — Claude, GPT, Gemini, a BYOK provider, or 'auto' to let Copilot pick. Mirrors Claude Code, whose Workflow tool has no model param — set the model the workflow inherits, not a force-override." },
					effort: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max"], description: "Session default reasoning effort agents inherit unless they pin their own (the harness's per-agent choice wins). Only affects reasoning-capable models; Copilot enforces applicability." },
					context: { type: "string", enum: ["default", "long_context"], description: "Session default context-window tier agents inherit unless they pin their own (Copilot-specific; no Claude equivalent)." },
					preset: { type: "string", enum: ["xtreme"], description: "Named run preset. 'xtreme' sets provider-neutral high-effort defaults (model=auto, effort=xhigh, context=long_context) and a 1,000,000 AIC budget when none is supplied." },
					concurrency: { type: "integer", minimum: 1, description: "Max concurrent subagents (default min(16, cpu-1))." },
					enableMcp: { type: "boolean", description: "Start subagents with built-in MCP servers enabled. Use only when the harness needs GitHub/MCP/web tools." },
					restricted: { type: "boolean", description: "Run the harness orchestration-only + deterministic (sandbox an untrusted harness author)." },
					strictBudget: { type: "boolean", description: "Stop/raise once the budget cap is observed instead of gracefully draining." },
					quiet: { type: "boolean", description: "Suppress cwf stderr diagnostics (omits the progress/stats section from the result)." },
					cwd: { type: "string", description: "Directory to run the workflow from (default: the session's working directory)." },
					timeoutSec: { type: "number", minimum: 1, maximum: MAX_TIMEOUT_SEC, description: "Kill the run (and its subagents) after this many seconds (default 1800)." },
				},
			},
			handler: runWorkflow,
		},
		{
			name: "list_workflow_runs",
			skipPermission: true,
			description: "List recent cwf workflow runs (id, harness, status, spend). Use to find a runId to resume.",
			parameters: { type: "object", additionalProperties: false, properties: {} },
			handler: async () => {
				try {
					const { stdout } = await execFileAsync(cwfBin(), ["runs"], { maxBuffer: 16 * 1024 * 1024 });
					return stdout.trim() || "No workflow runs found.";
				} catch (error) {
					return failure(`failed to list runs: ${error?.stderr || error?.message || error}`);
				}
			},
		},
	],
});
