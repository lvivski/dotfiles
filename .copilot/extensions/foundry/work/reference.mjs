import path from "node:path";
import { scopeLabel } from "./values.mjs";

/** @param {import("./model.js").CharterContinuation|undefined} pair */
export const continuationNotice=pair=>pair ? `\nContinue under the frozen original charter ${JSON.stringify(pair.file)} (${pair.from}), not the later ${pair.to}. No new paths, tasks or permissions from that revision are granted.` : "";

/** Render an immutable reference outside the worktree; the suffix is data, not shell syntax.
 * @param {{file:string;blob:string}} a */
export function materialize(a) {
	const suffix = path.extname(a.file).replace(/[^A-Za-z0-9.]/g, "");
	return `d=$(mktemp -d) && p="$d/reference${suffix}" && git --no-replace-objects cat-file blob ${a.blob} > "$p" && printf '%s\\n' "$p"`;
}

/** @typedef {{file:string;blob:string;dependency:import("./model.js").DependencyReference}} Dependency */
/** @param {import("./model.js").Run} run @param {NonNullable<import("./model.js").NativeCall["input"]>} input @returns {import("./model.js").Artifact|Dependency|undefined} */
export const inputReference=(run,input)=>input.dependency ? {file:input.dependency.source.file,blob:input.blob,dependency:input.dependency} : run.artifacts?.[input.offer];

/** @param {import("./model.js").Artifact|Dependency} a @param {import("./model.js").Node} n */
export const inputMessage=(a,n)=>`Continue the original task in ${scopeLabel(n.grain.directory)} with its unchanged check ${n.grain.check}. `+
	`The missing reference is ${JSON.stringify(a.file)}, blob ${a.blob}. `+
	("dependency" in a ? `Materialized from your original checked dependency ${a.dependency.source.grain}@${a.dependency.source.revision}, component ${a.dependency.source.component}. No writer published these bytes or granted a new read. ` :
	a.source ? `Read-only response from ${JSON.stringify(a.publisher)}, producing assignment ${a.source.grain} (${a.source.assignment}); `+
		(a.source.component ? `checked revision ${a.source.revision}, component ${a.source.component}. ` : `draft captured on generation ${a.source.generation}, not a checked dependency. `) : "")+
	`Extract it outside your worktree:\n${materialize(a)}\n`+
	"Read your current Foundry status. No additional paths, permissions or prior tree are granted. Submit the original work normally; report only references actually used or compared.";
