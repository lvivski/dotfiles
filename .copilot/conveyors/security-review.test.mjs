// Matcher, severity, scope, and evidence-contract tests for the security-review workflow.
//   node --test .copilot/conveyors/security-review.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const host = await import(resolve(here, "security-review.host.mjs"));
const { deriveSeverity, validateFindings, discover, writeFindings, resolveContext, __matchers: matchers, __scanContent: scanContent, __rankForCap: rankForCap, __selectWithinCaps: selectWithinCaps, __batchByDirectory: batchByDirectory } = host;

// Example corpora live here rather than beside the patterns: keeping literal vulnerable strings out
// of the production module stops the scanner from ranking its own rule table as a top target.
const SAMPLES = {
	"secrets-exposure": {
		examples: ['const apiKey = "sk-live-abcdef123456";', "-----BEGIN RSA PRIVATE KEY-----", "process.env.JWT_SECRET || 'fallback-dev-secret'"],
		counterExamples: ["const apiKey = process.env.API_KEY;", "let token;", "process.env.JWT_SECRET || ''"],
	},
	"unsafe-deserialization": {
		examples: ["pickle.loads(data)", "yaml.load(f)", "new ObjectInputStream(in)", "unserialize($data)"],
		counterExamples: ["yaml.safe_load(f)", "JSON.parse(s)"],
	},
	"raw-sql": {
		examples: ["prisma.$queryRawUnsafe(sql)", "db.execute(sql.raw(query))", "const q = `SELECT * FROM t WHERE id = ` + id;"],
		counterExamples: ["db.query('SELECT * FROM t WHERE id = $1', [id])", "prisma.user.findMany({ where: { id } })"],
	},
	"command-execution": {
		examples: ["exec(`ls ${dir}`)", "subprocess.run(cmd, shell=True)", "spawn(bin, args)"],
		counterExamples: ["const execute = 1;", "// spawn a worker later"],
	},
	"dynamic-code-eval": {
		examples: ["new Function(src)", "render_template_string(user_input)", "Handlebars.compile(tpl)"],
		counterExamples: ["render_template('index.html', name=name)", "const evaluated = true;"],
	},
	"jwt-weak-verify": {
		examples: ["jwt.decode(token)", "algorithms: ['none']", "ignoreExpiration: true"],
		counterExamples: ["jwt.verify(token, key, { algorithms: ['RS256'] })", "jwt.decode(token, key, algorithms=['RS256'])"],
	},
	"insecure-random-token": {
		examples: ["const token = Math.random().toString(36)", "sessionId = Math.random()"],
		counterExamples: ["const jitter = Math.random();", "const token = crypto.randomBytes(32);"],
	},
	xxe: {
		examples: ["etree.XMLParser(resolve_entities=True)", "DocumentBuilderFactory.newInstance()"],
		counterExamples: ["import defusedxml.ElementTree as ET"],
	},
	"auth-bypass": {
		examples: ["if (skipAuth) return next();", "const isAdmin = true", "DISABLE_AUTH=1"],
		counterExamples: ["await requireAuth(req);", "const isAdmin = user.role === 'admin'"],
	},
	"http-entry-point": {
		examples: ["app.get('/users', handler)", "export async function POST(req) {", "@app.route('/users')", "class UserController extends Controller", "func Index(w http.ResponseWriter, r *http.Request) {"],
		counterExamples: ["const app = express();", "e.preventDefault()", "const value = record.get"],
	},
	"server-action-or-rpc": {
		examples: ["'use server'", "const listUsers = publicProcedure.query(fn)", "Mutation: {"],
		counterExamples: ["const listUsers = protectedProcedure.query(fn)", "export default function Page() {"],
	},
	"auth-middleware": {
		examples: ["export function middleware(req) {", "before_action :authenticate_user!", "await requireAuth(req)"],
		counterExamples: ["export function Layout() {", "const middlewares = []"],
	},
	"webhook-receiver": {
		examples: ["app.post('/webhooks/stripe', handler)", "const webhookHandler = async (req) => {}"],
		counterExamples: ["// deliver a callback later"],
	},
	"dangerous-html": {
		examples: ["el.innerHTML = body", "<div dangerouslySetInnerHTML={{ __html: html }} />", "mark_safe(value)"],
		counterExamples: ["const html = escape(body);", "const safe = escapeHtml(body)"],
	},
	"path-traversal": {
		examples: ["readFile(path.join(base, req.query.name))", "os.Open(userPath)"],
		counterExamples: ["readFile('./config.json')", "const readFileLater = true;"],
	},
	"outbound-request": {
		examples: ["await fetch(req.body.url)", "requests.get(target)"],
		counterExamples: ['await fetch("https://api.example.com/v1")', "// prefetch the manifest"],
	},
	"mass-assignment": {
		examples: ["User.create({ ...req.body })", "db.update(req.body)"],
		counterExamples: ["User.create({ name: req.body.name })"],
	},
	"tenant-scoped-lookup": {
		examples: ["prisma.order.findFirst({ where: { id: query.orderId } })", "db.user.findUnique({ where: { id: req.params.id } })"],
		counterExamples: ["prisma.order.findFirst({ where: { id: session.orderId } })", "db.user.findUnique({ where: { id: ctx.userId } })"],
	},
	"agent-tool-surface": {
		examples: ["server.registerTool('runQuery', schema, handler)", "const prompt = `Summarize: ${userInput}`", "llm.invoke(req.body.text)"],
		counterExamples: ["const prompt = 'Summarize the document.'", "const toolNames = list.map(String)"],
	},
	"infra-exposure": {
		examples: ["cidr_blocks = ['0.0.0.0/0']", "privileged: true", "USER root", "on: pull_request_target"],
		counterExamples: ["cidr_blocks = ['10.0.0.0/8']", "USER node"],
	},
	"weak-crypto": {
		examples: ["crypto.createHash('md5')", "hashlib.sha1(payload)"],
		counterExamples: ["const hash = sha256(x);", "crypto.createHash('sha512')"],
	},
	"secret-in-log": {
		examples: ["console.log('token', token)", "logger.info('password', password)"],
		counterExamples: ["console.log('request finished')"],
	},
};

test("matcher registry is well formed", () => {
	assert.ok(matchers.length > 0, "no matchers exported");
	assert.ok(matchers.length <= 25, `matcher registry has grown to ${matchers.length}; it is a ranking key, not a ruleset`);
	const slugs = new Set();
	for (const matcher of matchers) {
		assert.match(matcher.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `bad slug: ${matcher.slug}`);
		assert.ok(!slugs.has(matcher.slug), `duplicate slug: ${matcher.slug}`);
		slugs.add(matcher.slug);
		assert.ok(["precise", "broad"].includes(matcher.tier), `bad tier on ${matcher.slug}`);
		assert.ok(Array.isArray(matcher.patterns) && matcher.patterns.length, `no patterns on ${matcher.slug}`);
		assert.ok(matcher.label && matcher.label.length <= 80, `bad label on ${matcher.slug}`);
	}
});

test("matchers carry no tech gate, because nothing evaluates one", () => {
	for (const matcher of matchers) {
		assert.equal(matcher.requires?.tech, undefined, `${matcher.slug} declares requires.tech, which the scanner never reads`);
	}
});

test("every matcher carries a reviewer note", () => {
	for (const matcher of matchers) {
		assert.ok(matcher.notes && matcher.notes.trim().length > 20, `${matcher.slug} needs a substantive note`);
		assert.ok(matcher.notes.length <= 500, `${matcher.slug} note is too long for the batch budget`);
	}
});

test("every matcher has a sample corpus", () => {
	for (const matcher of matchers) assert.ok(SAMPLES[matcher.slug], `${matcher.slug} has no entry in SAMPLES`);
	for (const slug of Object.keys(SAMPLES)) assert.ok(matchers.some((matcher) => matcher.slug === slug), `SAMPLES has a stale entry: ${slug}`);
});

test("matcher examples match their own patterns", () => {
	for (const matcher of matchers) {
		for (const example of SAMPLES[matcher.slug].examples) {
			assert.ok(
				matcher.patterns.some((pattern) => pattern.test(example)),
				`${matcher.slug} failed to match its own example: ${example}`,
			);
		}
	}
});

test("matcher counter-examples do not match", () => {
	for (const matcher of matchers) {
		for (const counterExample of SAMPLES[matcher.slug].counterExamples || []) {
			assert.ok(
				!matcher.patterns.some((pattern) => pattern.test(counterExample)),
				`${matcher.slug} wrongly matched counter-example: ${counterExample}`,
			);
		}
	}
});

test("matcher patterns are not catastrophically slow", () => {
	const payload = `${"a".repeat(2000)} ${"./x".repeat(400)}`;
	for (const matcher of matchers) {
		for (const pattern of matcher.patterns) {
			const started = process.hrtime.bigint();
			pattern.test(payload);
			const ms = Number(process.hrtime.bigint() - started) / 1e6;
			assert.ok(ms < 50, `${matcher.slug} pattern took ${ms.toFixed(1)}ms on a hostile line`);
		}
	}
});

test("severity is mechanical and degrades safely", () => {
	const security = (impact, likelihood, extra = {}) => deriveSeverity({ kind: "security", impact, likelihood, ...extra });
	assert.equal(security("high", "high"), "HIGH");
	assert.equal(security("high", "medium"), "HIGH");
	assert.equal(security("medium", "medium"), "MEDIUM");
	assert.equal(security("high", "unknown"), "MEDIUM");
	assert.equal(security("unknown", "high"), "MEDIUM");
	assert.equal(security("low", "high"), "LOW");
	assert.equal(security("ignore", "high"), "IGNORE");
	assert.equal(security("high", "ignore"), "IGNORE");
	assert.equal(deriveSeverity({ kind: "bug", impact: "high", likelihood: "low" }), "HIGH_BUG");
	assert.equal(deriveSeverity({ kind: "bug", impact: "low", likelihood: "low" }), "BUG");
	assert.equal(deriveSeverity({ kind: "bug", impact: "ignore", likelihood: "low" }), "IGNORE");
	assert.equal(deriveSeverity({}), "LOW", "missing facts must degrade, never escalate");
});

// A severe consequence must not decay to LOW because the path is awkward today.
test("high impact never degrades below MEDIUM on likelihood alone", () => {
	for (const likelihood of ["high", "medium", "low", "unknown"]) {
		const severity = deriveSeverity({ kind: "security", impact: "high", likelihood });
		assert.ok(["CRITICAL", "HIGH", "MEDIUM"].includes(severity), `high impact x ${likelihood} likelihood produced ${severity}`);
	}
});

test("CRITICAL requires named facts, not an opinion", () => {
	const base = { kind: "security", impact: "high", likelihood: "high" };
	assert.equal(deriveSeverity(base), "HIGH", "no escalation facts means no escalation");
	assert.equal(deriveSeverity({ ...base, unauthenticated: true }), "HIGH", "unauthenticated alone is not critical");
	assert.equal(deriveSeverity({ ...base, crossTenant: true }), "HIGH", "cross-tenant alone is not critical");
	assert.equal(deriveSeverity({ ...base, unauthenticated: true, crossTenant: true }), "CRITICAL");
	assert.equal(deriveSeverity({ ...base, unauthenticated: true, rceOrCredential: true }), "CRITICAL");
	assert.equal(deriveSeverity({ ...base, likelihood: "low", unauthenticated: true, rceOrCredential: true }), "MEDIUM", "escalation cannot bypass the matrix");
});

test("per-file candidate caps keep precise anchors over broad ones", () => {
	const candidates = [
		{ vulnClass: "http-entry-point", noiseTier: "broad", line: 1 },
		{ vulnClass: "secrets-exposure", noiseTier: "precise", line: 90 },
		{ vulnClass: "http-entry-point", noiseTier: "broad", line: 2 },
	];
	const kept = rankForCap(candidates, 1);
	assert.equal(kept.length, 1);
	assert.equal(kept[0].vulnClass, "secrets-exposure");
});

// A cap silently turns ranking into selection unless something defends breadth.
test("caps reserve room for unanchored files and spread across directories", () => {
	const records = [];
	for (let i = 0; i < 30; i++) records.push({ filePath: `hot/a${i}.js`, candidates: [{ noiseTier: "precise", vulnClass: "raw-sql", line: 1 }] });
	for (let i = 0; i < 10; i++) records.push({ filePath: `quiet/b${i}.js`, candidates: [] });
	for (let i = 0; i < 5; i++) records.push({ filePath: `other/c${i}.js`, candidates: [{ noiseTier: "broad", vulnClass: "http-entry-point", line: 1 }] });
	const selection = selectWithinCaps(records, 20);
	assert.equal(selection.kept.length, 20);
	assert.ok(selection.unanchoredKept >= 1, "no unanchored file survived the cap");
	assert.ok(selection.kept.some((record) => record.filePath.startsWith("other/")), "a whole directory was crowded out by one hot directory");
	assert.equal(selection.omitted, 25);
	assert.equal(selection.directoriesTotal, 3);
});

test("caps are a no-op below the limit", () => {
	const records = [{ filePath: "a/x.js", candidates: [] }];
	const selection = selectWithinCaps(records, 10);
	assert.equal(selection.omitted, 0);
	assert.equal(selection.kept.length, 1);
});

// The reserve is a floor, not a ceiling. A mostly-unanchored scope must still spend the whole
// budget; capping unanchored files at the reserve would let absence of matcher hits become
// deselection, which is the failure the reserve exists to prevent.
test("caps spend the whole budget whatever the mix of anchored files", () => {
	const build = (anchoredCount, unanchoredCount) => [
		...Array.from({ length: anchoredCount }, (_, i) => ({ filePath: `hot/a${i}.js`, candidates: [{ noiseTier: "precise", vulnClass: "raw-sql", line: 1 }] })),
		...Array.from({ length: unanchoredCount }, (_, i) => ({ filePath: `quiet/q${i}.js`, candidates: [] })),
	];
	for (const [anchored, unanchored] of [[0, 100], [5, 95], [50, 50], [90, 10], [100, 0]]) {
		const selection = selectWithinCaps(build(anchored, unanchored), 60);
		assert.equal(selection.kept.length, 60, `mix ${anchored}/${unanchored} reviewed only ${selection.kept.length} of a 60-file budget`);
		assert.equal(selection.omitted, 40, `mix ${anchored}/${unanchored} omitted count is wrong`);
		assert.equal(new Set(selection.kept.map((record) => record.filePath)).size, 60, "a record was selected twice");
	}
});

test("batching keeps directories together and splits oversized ones", () => {
	const records = [
		{ filePath: "api/a.js", candidates: [] },
		{ filePath: "api/b.js", candidates: [] },
		{ filePath: "api/c.js", candidates: [] },
		{ filePath: "lib/one.js", candidates: [] },
		{ filePath: "util/two.js", candidates: [] },
	];
	const batches = batchByDirectory(records, 3);
	assert.ok(
		batches.some((batch) => batch.length === 3 && batch.every((record) => record.filePath.startsWith("api/"))),
		"api/ should form one intact batch",
	);
	assert.equal(batches.flat().length, records.length, "every record must appear exactly once");
	const big = batchByDirectory([...Array(7)].map((_, i) => ({ filePath: `api/f${i}.js`, candidates: [] })), 3);
	assert.deepEqual(big.map((batch) => batch.length), [3, 3, 1]);
});

function fixture() {
	const dir = mkdtempSync(resolve(tmpdir(), "security-review-"));
	mkdirSync(resolve(dir, "src"), { recursive: true });
	writeFileSync(resolve(dir, "src/handler.js"), "line one\nline two\nline three\n");
	writeFileSync(resolve(dir, "src/dao.js"), "dao one\ndao two\n");
	writeFileSync(resolve(dir, "src/untouched.js"), "other one\nother two\n");
	return dir;
}

const finding = (overrides = {}) => ({
	kind: "security",
	impact: "high",
	likelihood: "high",
	vulnClass: "raw-sql",
	anchor: "user-id-into-raw-sql",
	filePath: "src/handler.js",
	line: 2,
	title: "t",
	...overrides,
});

test("evidence validation enforces scope, lines, and hashes", async () => {
	const dir = fixture();
	try {
		const ctx = { cwd: dir };
		const scan = await discover({ root: "." }, ctx);
		const manifest = scan.manifest;
		const records = [{ filePath: "src/handler.js", fileHash: "0".repeat(64) }];
		const run = (findings, extra = {}) => validateFindings({ root: ".", manifest, records: [], findings, ...extra }, ctx);

		assert.equal((await run([finding()])).valid.length, 1, "a well-formed finding must survive");
		assert.match((await run([finding({ filePath: "src/absent.js" })])).rejected[0].reason, /outside the reviewed scope/);
		assert.match((await run([finding({ line: 999 })])).rejected[0].reason, /line is outside/);
		assert.match((await run([finding({ anchor: "" })])).rejected[0].reason, /semantic anchor/);
		assert.match((await validateFindings({ root: ".", manifest, records, findings: [finding()] }, ctx)).rejected[0].reason, /changed after discovery/);

		const suppressed = await run([finding({ impact: "ignore" })]);
		assert.equal(suppressed.suppressed, 1, "policy-ignored findings are suppressed, not rejected");
		assert.equal(suppressed.valid.length + suppressed.rejected.length, 0);

		const deduped = await run([finding(), finding()]);
		assert.equal(deduped.valid.length, 1, "identical anchors in one file collapse");

		const { valid } = await run([finding()]);
		assert.equal(valid[0].severity, "HIGH", "the host derives severity; the model never states one");
		assert.ok(valid[0].evidence.includes("2: line two"), "evidence must quote the cited line");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// The batch is an attention boundary; the manifest is the reporting boundary.
test("findings may cite any in-scope file, not just the batch", async () => {
	const dir = fixture();
	try {
		const ctx = { cwd: dir };
		const { manifest } = await discover({ root: "." }, ctx);
		const crossFile = finding({ filePath: "src/dao.js", line: 1, supporting: [{ filePath: "src/handler.js", line: 1, role: "source" }] });
		const { valid } = await validateFindings({ root: ".", manifest, records: [], findings: [crossFile] }, ctx);
		assert.equal(valid.length, 1, "a finding in an unbatched file must be reportable");
		assert.equal(valid[0].supporting[0].role, "source");

		const badSupport = finding({ supporting: [{ filePath: "src/nope.js", line: 1, role: "sink" }] });
		const { rejected } = await validateFindings({ root: ".", manifest, records: [], findings: [badSupport] }, ctx);
		assert.match(rejected[0].reason, /supporting location/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Otherwise a pull-request review reports every pre-existing bug in the repository.
test("change-scoped reviews require a finding to touch the change", async () => {
	const dir = fixture();
	try {
		const ctx = { cwd: dir };
		const { manifest } = await discover({ root: "." }, ctx);
		const scoped = { root: ".", manifest, records: [], reviewPaths: ["src/handler.js"], requireReviewTouch: true };

		assert.equal((await validateFindings({ ...scoped, findings: [finding()] }, ctx)).valid.length, 1, "a finding inside the change survives");
		const outside = await validateFindings({ ...scoped, findings: [finding({ filePath: "src/untouched.js", line: 1 })] }, ctx);
		assert.match(outside.rejected[0].reason, /inside the reviewed change/);

		const reached = finding({ filePath: "src/dao.js", line: 1, supporting: [{ filePath: "src/handler.js", line: 1, role: "source" }] });
		assert.equal((await validateFindings({ ...scoped, findings: [reached] }, ctx)).valid.length, 1, "an unchanged sink reached from the change is in scope");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("discovery reviews files no matcher anchored", async () => {
	const dir = fixture();
	try {
		writeFileSync(resolve(dir, "src/secret.js"), 'const apiKey = "sk-live-abcdef123456";\n');
		const scan = await discover({ files: ["src/handler.js", "src/secret.js"] }, { cwd: dir });
		const paths = scan.records.map((record) => record.filePath).sort();
		assert.deepEqual(paths, ["src/handler.js", "src/secret.js"], "an explicitly listed file is reviewed even with no candidates");
		assert.ok(scan.manifest.includes("src/untouched.js"), "the citable manifest spans the tree, not just the selection");
		assert.equal(scan.direct, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Regex must never become the file selector, or unremarkable-looking authorization code is never
// read at all and the caps below have nothing to protect.
test("a repository sweep reviews unanchored files too", async () => {
	const dir = fixture();
	try {
		writeFileSync(resolve(dir, "src/secret.js"), 'const apiKey = "sk-live-abcdef123456";\n');
		const scan = await discover({ root: "." }, { cwd: dir });
		const anchored = scan.records.filter((record) => record.candidates.length).map((record) => record.filePath);
		const unanchored = scan.records.filter((record) => !record.candidates.length).map((record) => record.filePath);
		assert.deepEqual(anchored, ["src/secret.js"], "only the planted secret should anchor");
		assert.ok(unanchored.includes("src/handler.js") && unanchored.includes("src/dao.js"), "plain files must still be reviewed");
		assert.equal(scan.records.length, scan.preCapRecords);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// discover() hands back a canonicalized absolute root and the workflow feeds it straight to the
// other effects, so a symlinked ancestor on ctx.cwd must not read as an escape.
test("an absolute root from discovery round-trips through every effect", async () => {
	const real = mkdtempSync(resolve(tmpdir(), "security-review-real-"));
	const link = resolve(tmpdir(), `security-review-link-${process.pid}-${Date.now()}`);
	symlinkSync(real, link);
	try {
		mkdirSync(resolve(real, "src"), { recursive: true });
		writeFileSync(resolve(real, "src/handler.js"), "line one\nline two\n");
		const ctx = { cwd: link };
		const scan = await discover({ root: "." }, ctx);
		assert.ok(scan.records.length, "discovery found nothing to review");

		const checked = await validateFindings({ root: scan.root, manifest: scan.manifest, records: scan.records, findings: [finding({ filePath: "src/handler.js", line: 1 })] }, ctx);
		assert.equal(checked.valid.length, 1, "validation rejected a root it had just produced");
		const context = await resolveContext({ root: scan.root }, ctx);
		assert.equal(context.text, "");
		const artifact = await writeFindings({ root: scan.root, findings: [] }, ctx);
		assert.ok(artifact.path.includes("findings-"));
	} finally {
		rmSync(link, { force: true });
		rmSync(real, { recursive: true, force: true });
	}
});

test("git refs reject argument injection", async () => {
	const ctx = { cwd: resolve(here, "..", ".."), dryRun: false };
	for (const bad of ["--upload-pack=evil", "-x", "a;b", "$(id)", "a b"]) {
		await assert.rejects(() => discover({ base: bad }, ctx), /not a valid git ref/, `accepted ${bad}`);
	}
	await assert.rejects(() => discover({ base: "no/such/ref/xyz" }, ctx), /does not resolve to a commit/);
	await assert.rejects(() => discover({ base: "HEAD", root: "src" }, ctx), /choose one scope/);
	await assert.rejects(() => discover({ head: "HEAD" }, ctx), /head requires base/);
});

test("artifact names cannot escape the artifact directory", async () => {
	const ctx = { cwd: resolve(here, "..", ".."), dryRun: false };
	for (const bad of ["../escape", "a/b", "", ".."]) {
		await assert.rejects(() => writeFindings({ root: ".", name: bad, findings: [] }, ctx), /invalid artifact name/, `accepted ${bad}`);
	}
	assert.equal(writeFindings.mutates, true, "writeFindings must be declared mutating so dry runs skip it");
});

// Our own report can quote secret-bearing evidence lines verbatim.
test("the artifact directory is never scanned, even in direct mode", () => {
	assert.equal(host.__safeFile(here, ".security-review/findings-x.json", 200000, true), false);
	assert.equal(host.__safeFile(here, "nested/.security-review/findings-x.json", 200000, true), false);
});
