import { readFileSync } from "node:fs";
import { archiveCheck } from "../../../extensions/foundry/work/handoff.mjs";

try {
	if (process.argv.length !== 3) throw new Error("Expected offer or recheck and one JSON document on stdin");
	console.log(JSON.stringify(archiveCheck(process.cwd(), process.argv[2], JSON.parse(readFileSync(0, "utf8")))));
} catch (error) {
	console.error(`Keep writer: ${error instanceof Error && "code" in error ? `${error.code}: ` : ""}${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
