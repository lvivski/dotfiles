import { readPolicy } from "../../../extensions/foundry/work/brief.mjs";
import { commitAt, contractPaths, git, rootAt, verifyContracts } from "../../../extensions/foundry/work/product.mjs";

/** @param {string[]} args */
function plans(args) {
	if (args.length > 1) throw new Error("Expected one plan name or .foundry path");
	const root = rootAt(process.cwd());
	if (!args.length) {
		return git(root, ["ls-tree", "--full-tree", "-z", "HEAD", "--", ".foundry/"]).toString().split("\0")
			.flatMap(line => /^100(?:644|755) blob [a-f0-9]+\t\.foundry\/([A-Za-z0-9][A-Za-z0-9._-]*)\.json$/.exec(line)?.slice(1) ?? []);
	}
	const [plan] = args;
	if (!plan.startsWith(".foundry/") && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(plan))
		throw new Error("Use an exact plan name or repository-relative .foundry path");
	const source = plan.startsWith(".foundry/") ? plan : `.foundry/${plan}.json`;
	const { policy } = readPolicy(root, source);
	verifyContracts(root, policy, commitAt(root, policy.target));
	const dirty = git(root, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=no", "--", ...contractPaths(policy)]).toString().trimEnd();
	if (dirty) throw new Error(`Uncommitted changes to the requested brief:\n${dirty}`);
	return { source, run: policy.id, target: policy.target };
}

try {
	console.log(JSON.stringify(plans(process.argv.slice(2))));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
