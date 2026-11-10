import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { evaluate, readSchedule } from "./policy.mjs";

const filename = process.argv[2];
if (!filename) throw new TypeError("An explicit candidate module path is required");
const bytes = await readFile(filename);
const policy = readSchedule(await import(pathToFileURL(filename).href));
process.stdout.write(JSON.stringify({
	processId: process.pid,
	observedAt: new Date().toISOString(),
	policyDigest: createHash("sha256").update(bytes).digest("hex"),
	receipts: evaluate(policy),
}));
