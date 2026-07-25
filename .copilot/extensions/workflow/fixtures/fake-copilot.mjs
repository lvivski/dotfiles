#!/usr/bin/env node
/**
 * @module fixtures/fake-copilot
 *
 * A zero-cost stand-in for the real `copilot` binary, used by the workflow test suite
 * (`CWF_COPILOT_BIN` points at this file). It mimics `copilot -p <prompt> --output-format json`:
 * it prints a JSONL event stream to stdout (an `assistant.message` then a `result`) and writes a
 * child session log at `$COPILOT_HOME/session-state/<id>/events.jsonl` containing a
 * `session.shutdown` record with `totalNanoAiu` + per-model token usage — the exact shape
 * `agent.mjs` reads back for AIC/token accounting.
 *
 * Behaviour is driven entirely by env vars so tests can exercise every branch without spending
 * real AI credits:
 *
 * - `CWF_FAKE_MODE`   — `ok` (default) | `fail` | `hang` | `treehang` | `malformed` | `nojson` | `sessionerror`
 * - `CWF_FAKE_NANO_AIU` — session-wide nanoAIU to report (default `500000000` = 0.5 AIC)
 * - `CWF_FAKE_OUTPUT_TOKENS` — output tokens to report (default `42`)
 * - `CWF_FAKE_CONTENT` — assistant content (default `ECHO: <prompt>`)
 * - `CWF_FAKE_STDERR` — stderr text for `fail` mode
 * - `CWF_FAKE_SESSION` — force a child session id (default: random)
 * - `CWF_FAKE_DELAY_MS` — delay a successful response (for concurrency tests)
 * - `CWF_FAKE_PID_FILE` — write this fake process's PID to the given path
 * - `COPILOT_HOME`     — where the child session log is written (default `~/.copilot`)
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Extract the value following `flag` in an argv array, or `undefined`.
 * @param {string[]} argv
 * @param {string} flag
 * @returns {string | undefined}
 */
function argValue(argv, flag) {
	const i = argv.indexOf(flag);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const argv = process.argv.slice(2);
const prompt = argValue(argv, "-p") ?? "";
const model = argValue(argv, "--model") ?? process.env.CWF_FAKE_MODEL ?? "fake-model";
const mode = process.env.CWF_FAKE_MODE ?? "ok";
const nanoAiu = Number(process.env.CWF_FAKE_NANO_AIU ?? 500_000_000);
const outputTokens = Number(process.env.CWF_FAKE_OUTPUT_TOKENS ?? 42);
const content = process.env.CWF_FAKE_CONTENT ?? `ECHO: ${prompt}`;
const resumedSessionId = argValue(argv, "--resume");
const sessionId = resumedSessionId ?? process.env.CWF_FAKE_SESSION ?? `fake-${randomBytes(6).toString("hex")}`;
const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const delayMs = Math.max(0, Number(process.env.CWF_FAKE_DELAY_MS ?? 0));
if (process.env.CWF_FAKE_PID_FILE) writeFileSync(process.env.CWF_FAKE_PID_FILE, String(process.pid), "utf8");

/**
 * Build one cumulative `session.shutdown` record.
 * @param {number} nano
 * @param {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number }} usage
 */
function mkShutdown(nano, usage) {
	return {
		type: "session.shutdown",
		sessionId,
		data: {
			shutdownType: "normal",
			currentModel: model,
			codeChanges: { filesModified: [], linesAdded: 0, linesRemoved: 0 },
			sessionStartTime: Date.now() - 1000,
			totalApiDurationMs: 123,
			totalNanoAiu: nano,
			modelMetrics: {
				[model]: {
					requests: { count: 1, cost: 1 },
					totalNanoAiu: nano,
					usage,
				},
			},
		},
	};
}

/**
 * Write cumulative child usage. Resumed turns append a new shutdown to the same session log.
 */
function writeShutdownLog() {
	const dir = join(copilotHome, "session-state", sessionId);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "events.jsonl");
	const previous = readPreviousUsage(path);
	const usage = {
		inputTokens: previous.inputTokens + 100,
		outputTokens: previous.outputTokens + outputTokens,
		cacheReadTokens: previous.cacheReadTokens + 10,
		cacheWriteTokens: previous.cacheWriteTokens + 5,
		reasoningTokens: previous.reasoningTokens + 7,
	};
	const total = previous.nanoAiu + nanoAiu;
	const line = JSON.stringify(mkShutdown(total, usage)) + "\n";
	if (resumedSessionId && existsSync(path)) appendFileSync(path, line, "utf8");
	else writeFileSync(path, line, "utf8");
	if (process.env.CWF_FAKE_NANO_AIU_2) {
		appendFileSync(path, JSON.stringify(mkShutdown(Number(process.env.CWF_FAKE_NANO_AIU_2), usage)) + "\n", "utf8");
	}
}

/** @param {string} path */
function readPreviousUsage(path) {
	const empty = { nanoAiu: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
	if (!existsSync(path)) return empty;
	let latest = null;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line);
			if (rec.type === "session.shutdown" && rec.data?.totalNanoAiu != null) latest = rec;
		} catch {
			// Ignore malformed history in the fake just like the production reader.
		}
	}
	if (!latest) return empty;
	const metric = Object.values(latest.data.modelMetrics || {})[0];
	const usage = metric?.usage || {};
	return {
		nanoAiu: Number(latest.data.totalNanoAiu || 0),
		inputTokens: Number(usage.inputTokens || 0),
		outputTokens: Number(usage.outputTokens || 0),
		cacheReadTokens: Number(usage.cacheReadTokens || 0),
		cacheWriteTokens: Number(usage.cacheWriteTokens || 0),
		reasoningTokens: Number(usage.reasoningTokens || 0),
	};
}

/** @param {object} obj */
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

function finishOk() {
	writeShutdownLog();
	emit({ type: "assistant.message", data: { content, outputTokens, model } });
	emit({ type: "result", sessionId });
	process.exit(0);
}

switch (mode) {
	case "fail":
		process.stderr.write(process.env.CWF_FAKE_STDERR ?? "fake-copilot: simulated failure\n");
		process.exit(1);
		break;
	case "hang":
		setInterval(() => {}, 1 << 30); // stay alive until the parent's timeout kills us
		break;
	case "treehang": {
		// The leaf inherits stdout/stderr, reproducing the real failure where killing only `copilot`
		// leaves a tool subprocess alive and keeps the parent's JSONL reader open forever.
		const leaf = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
			stdio: ["ignore", "inherit", "inherit"],
		});
		if (process.env.CWF_FAKE_PID_FILE && leaf.pid) writeFileSync(process.env.CWF_FAKE_PID_FILE, String(leaf.pid), "utf8");
		setInterval(() => {}, 1 << 30);
		break;
	}
	case "malformed":
		writeShutdownLog();
		process.stdout.write("not json at all\n");
		emit({ type: "assistant.message", data: { content, outputTokens, model } });
		process.stdout.write("{ truncated json\n");
		emit({ type: "result", sessionId });
		process.exit(0);
		break;
	case "nojson":
		writeShutdownLog();
		process.stdout.write("just some prose, no events\n");
		emit({ type: "result", sessionId });
		process.exit(0);
		break;
	case "sessionerror":
		writeShutdownLog();
		emit({ type: "session.error", data: { errorType: "RateLimit", message: "slow down" } });
		emit({ type: "result", sessionId });
		process.exit(0);
		break;
	case "nousage":
		emit({ type: "assistant.message", data: { content, outputTokens, model } });
		emit({ type: "result", sessionId });
		process.exit(0);
		break;
	case "ok":
	default:
		if (delayMs) setTimeout(finishOk, delayMs);
		else finishOk();
}
