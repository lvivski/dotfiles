import { FoundryError, choice, record, text } from "./values.mjs";
import { quote } from "./native.mjs";

/** @param {(args:import("./model.d.ts").Json)=>Promise<unknown>} execute */
export function createIssueSource(execute) {
	const fields = "number title body url state author{login} editor{login} lastEditedAt";
	/** @param {string} repository @param {string} selection @param {string} declarations @param {string[]} variables */
	async function inspect(repository, selection, declarations, variables) {
		const [owner, name] = repository.split("/");
		const query = `query($owner:String!,$name:String!,${declarations}){repository(owner:$owner,name:$name){${selection}}}`;
		const response = record(await execute({
			command: `printf 'FOUNDRY_SOURCE_EVENT:'; gh api graphql --hostname github.com -f query=${quote(query)} -f owner=${quote(owner ?? "")} -f name=${quote(name ?? "")} ${variables.join(" ")} --jq '.data.repository|@base64'`,
			description: "Inspect authorized factory issue source",
		}));
		if (response.resultType !== "success") throw new FoundryError("source_inspection_failed", `Native GitHub source inspection failed: ${JSON.stringify(response)}`);
		const encoded = text(response.textResultForLlm, "native source receipt").match(/FOUNDRY_SOURCE_EVENT:([A-Za-z0-9+/=]+)/u)?.[1];
		if (!encoded) throw new FoundryError("source_receipt_missing", "Native source inspection returned no parseable receipt");
		return record(/** @type {unknown} */ (JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))));
	}
	/** @param {string} repository @param {unknown} value */
	function issue(repository, value) {
		const row = record(value);
		if (row.lastEditedAt !== null && typeof row.lastEditedAt !== "string") {
			throw new FoundryError("source_receipt_missing", "Native issue inspection must return its actual last-edit provenance");
		}
		if (row.url !== `https://github.com/${repository}/issues/${String(row.number)}`) {
			throw new FoundryError("source_identity_mismatch", "The actual provider returned a different repository issue");
		}
		return { number: row.number, title: row.title, body: row.body, user: row.author, editor: row.editor,
			last_edited_at: row.lastEditedAt, state: choice(row.state, ["OPEN", "CLOSED"], "actual issue state").toLowerCase() };
	}
	return {
		/** @param {string} repository @param {number} id */
		async readEvent(repository, id) {
			const result = await inspect(repository, `issue(number:$number){${fields}}`, "$number:Int!", [`-F number=${id}`]);
			return issue(repository, result.issue);
		},
		/** @param {string} repository @param {number} maximum @param {string} [cursor] */
		async readEvents(repository, maximum, cursor) {
			const result = await inspect(repository, `issues(first:$maximum,after:$cursor,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}){nodes{${fields}} pageInfo{hasNextPage endCursor}}`,
				"$maximum:Int!,$cursor:String", [`-F maximum=${maximum}`, ...(cursor === undefined ? [] : [`-f cursor=${quote(cursor)}`])]);
			const issues = record(result.issues);
			if (!Array.isArray(issues.nodes)) throw new FoundryError("source_receipt_missing", "Native provider returned no actual issue page");
			const page = record(issues.pageInfo);
			return { events: issues.nodes.map(value => issue(repository, value)), hasNextPage: page.hasNextPage, cursor: page.endCursor };
		},
	};
}
