#!/usr/bin/env node
/**
 * @module fixtures/fake-copilot
 *
 * A zero-cost stand-in for the real `copilot` binary, used by the cwf test suite
 * (`CWF_COPILOT_BIN` points at this file). It mimics `copilot -p <prompt> --output-format json`:
 * it prints a JSONL event stream to stdout (an `assistant.message` then a `result`) and writes a
 * child session log at `$COPILOT_HOME/session-state/<id>/events.jsonl` containing a
 * `session.shutdown` record with `totalNanoAiu` + per-model token usage — the exact shape
 * `agent.mjs` reads back for AIC/token accounting.
 *
 * Behaviour is driven entirely by env vars so tests can exercise every branch without spending
 * real AI credits:
 *
 * - `CWF_FAKE_MODE`   — `ok` (default) | `fail` | `hang` | `malformed` | `nojson` | `sessionerror`
 * - `CWF_FAKE_NANO_AIU` — session-wide nanoAIU to report (default `500000000` = 0.5 AIC)
 * - `CWF_FAKE_OUTPUT_TOKENS` — output tokens to report (default `42`)
 * - `CWF_FAKE_CONTENT` — assistant content (default `ECHO: <prompt>`)
 * - `CWF_FAKE_SESSION` — force a child session id (default: random)
 * - `COPILOT_HOME`     — where the child session log is written (default `~/.copilot`)
 */
import { mkdirSync, writeFileSync } from "node:fs";
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
const sessionId = process.env.CWF_FAKE_SESSION ?? `fake-${randomBytes(6).toString("hex")}`;
const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");

/** Build one `session.shutdown` record with a given session-wide nanoAIU. @param {number} nano */
function mkShutdown(nano) {
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
					usage: { inputTokens: 100, outputTokens, cacheReadTokens: 10, cacheWriteTokens: 5, reasoningTokens: 7 },
				},
			},
		},
	};
}

/**
 * Write the child session's events.jsonl with a realistic `session.shutdown` record. When
 * `CWF_FAKE_NANO_AIU_2` is set, append a SECOND shutdown so tests can assert first-shutdown selection.
 */
function writeShutdownLog() {
	const dir = join(copilotHome, "session-state", sessionId);
	mkdirSync(dir, { recursive: true });
	let out = JSON.stringify(mkShutdown(nanoAiu)) + "\n";
	if (process.env.CWF_FAKE_NANO_AIU_2) out += JSON.stringify(mkShutdown(Number(process.env.CWF_FAKE_NANO_AIU_2))) + "\n";
	writeFileSync(join(dir, "events.jsonl"), out, "utf8");
}

/** @param {object} obj */
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

switch (mode) {
	case "fail":
		process.stderr.write("fake-copilot: simulated failure\n");
		process.exit(1);
		break;
	case "hang":
		setInterval(() => {}, 1 << 30); // stay alive until the parent's timeout kills us
		break;
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
	case "ok":
	default:
		writeShutdownLog();
		emit({ type: "assistant.message", data: { content, outputTokens, model } });
		emit({ type: "result", sessionId });
		process.exit(0);
}
