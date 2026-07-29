import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const IGNORE_DIRS = new Set([".git", ".deepsec", ".security-review", "node_modules", "vendor", "dist", "build", ".next", ".turbo", "coverage", "__pycache__", "__tests__", "test", "tests", "fixtures", "samples"]);
const SOURCE_EXTS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rb",
	".go",
	".rs",
	".java",
	".kt",
	".kts",
	".cs",
	".php",
	".swift",
	".scala",
	".clj",
	".ex",
	".exs",
	".erl",
	".hrl",
	".lua",
	".sh",
	".bash",
	".zsh",
	".ps1",
	".sql",
	".tf",
	".yml",
	".yaml",
	".json",
	".toml",
]);
// Security-relevant files that carry no extension.
const ARTIFACT_DIR = ".security-review";
const SOURCE_FILENAMES = new Set(["Dockerfile", "Containerfile", "Jenkinsfile", "Procfile"]);

const NOISE = { precise: 0, normal: 1, noisy: 2 };
const SEVERITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "HIGH_BUG", "BUG", "LOW"]);

const MATCHERS = [
	{
		slug: "secrets-exposure",
		label: "secret-looking assignment",
		tier: "precise",
		patterns: [/\b(api[_-]?key|secret|token|password|passwd|private[_-]?key)\b\s*[:=]\s*['"][^'"\n]{12,}/i, /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
		notes: "A literal that is obviously a placeholder, example, or test fixture is not a finding. Confirm the value is real and reachable, and that the file ships.",
		examples: ["const apiKey = \"sk-live-abcdef123456\";", "-----BEGIN RSA PRIVATE KEY-----"],
		counterExamples: ["const apiKey = process.env.API_KEY;", "let token;"],
	},
	{
		slug: "sql-injection",
		label: "raw SQL or string-built query",
		tier: "normal",
		patterns: [/\b(queryRawUnsafe|executeRawUnsafe|rawQuery|raw\s*\(|exec\s*\(\s*[`'"]\s*select\b)/i, /\bSELECT\b.+(\+|\$\{|%s|format\()/i],
		notes: "Flag concatenated or interpolated SQL only when the interpolated value is attacker-reachable. Parameterized placeholders and ORM object filters such as where({ id }) are safe.",
		examples: ["db.queryRawUnsafe(sql)", "const q = `SELECT * FROM t WHERE id = ${id}`;"],
		counterExamples: ["db.query('SELECT * FROM t WHERE id = $1', [id])"],
	},
	{
		slug: "command-injection",
		label: "shell command execution",
		tier: "normal",
		patterns: [/\b(exec|execFile|spawn|system|popen|ProcessBuilder|Runtime\.getRuntime\(\)\.exec)\s*\(/, /\bsubprocess\.(run|Popen|call|check_output)\s*\(/],
		notes: "Discrete argument arrays without a shell are safe. Flag shell:true, string concatenation into a shell command, or user input reaching the command name.",
		examples: ["exec(`ls ${dir}`)", "subprocess.run(cmd, shell=True)"],
		counterExamples: ["const execute = 1;"],
	},
	{
		slug: "path-traversal",
		label: "path/file operation with dynamic input",
		tier: "normal",
		patterns: [/\b(readFile|writeFile|createReadStream|createWriteStream|sendFile|open|unlink|rename)\s*\(/, /\b(path\.join|Path\(|filepath\.Join|os\.Open)\s*\(/],
		notes: "Requires attacker-controlled path segments. A resolve-then-verify-prefix check, or a path built only from constants and validated identifiers, defeats this.",
		examples: ["readFile(path.join(base, req.query.name))", "os.Open(userPath)"],
		counterExamples: ["const readFileLater = true;"],
	},
	{
		slug: "ssrf",
		label: "server-side fetch/request",
		tier: "normal",
		patterns: [/\b(fetch|axios\.|request\.|http\.get|https\.get|urllib\.request|requests\.(get|post)|Net::HTTP)\b/],
		notes: "Only a finding when the destination host is attacker-influenced. A constant base URL with an interpolated path segment is usually not SSRF; an allowlist of hosts defeats it.",
		examples: ["await fetch(req.body.url)", "requests.get(target)"],
		counterExamples: ["// prefetch the manifest"],
	},
	{
		slug: "open-redirect",
		label: "redirect sink",
		tier: "normal",
		patterns: [/\b(redirect|res\.redirect|NextResponse\.redirect|RedirectResponse|sendRedirect)\s*\(/],
		notes: "Needs an explicit allowlist or same-origin check before the redirect. A relative path that cannot express a scheme or host is safe.",
		examples: ["res.redirect(req.query.next)"],
		counterExamples: ["// redirect handling lives in middleware"],
	},
	{
		slug: "dangerous-html",
		label: "unsafe HTML rendering",
		tier: "normal",
		patterns: [/\b(dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|v-html)\b/, /\b(render_template_string|mark_safe|html_safe|raw\()\b/],
		notes: "Database-stored HTML is still untrusted. Flag unless a sanitizer such as DOMPurify or sanitize-html sits between the data and the render.",
		examples: ["el.innerHTML = body", "<div dangerouslySetInnerHTML={{ __html: html }} />"],
		counterExamples: ["const html = escape(body);"],
	},
	{
		slug: "auth-bypass",
		label: "auth bypass or debug gate",
		tier: "normal",
		patterns: [/(skip[_-]?auth|disable[_-]?auth|bypass[_-]?auth|dev[_-]?auth|mock[_-]?user)/i, /\b(isAdmin|admin|isAuthenticated|authorized|isSuperuser)\s*(={1,3}|!={1,2})\s*(true|1|['"]true['"])/i],
		notes: "Only middleware that wraps the handler directly counts as a control. Edge, proxy, CDN, and WAF rules are not sufficient on their own because routes can escape them.",
		examples: ["if (skipAuth) return next();", "const isAdmin = true"],
		counterExamples: ["await requireAuth(req);"],
	},
	{
		slug: "weak-crypto",
		label: "weak crypto/hash usage",
		tier: "normal",
		patterns: [/\b(md5|sha1|DES|RC4|ECB|Math\.random|random\.random)\b/],
		notes: "Hashing for a cache key, ETag, or non-security fingerprint is fine. Flag only when the weak primitive protects a security decision: passwords, signatures, tokens, or identifiers that must be unguessable.",
		examples: ["crypto.createHash('md5')", "Math.random()"],
		counterExamples: ["const hash = sha256(x);"],
	},
	{
		slug: "github-workflow-security",
		label: "privileged GitHub workflow",
		tier: "normal",
		patterns: [/pull_request_target/, /permissions:\s*(write-all|.*contents:\s*write|.*pull-requests:\s*write)/],
		filePatterns: [/^\.github\/workflows\/.*\.ya?ml$/],
		notes: "pull_request_target runs with a privileged token in the base-repo context. It is a finding when the workflow also checks out or executes untrusted pull-request code.",
		examples: ["on: pull_request_target", "permissions: write-all"],
		counterExamples: ["on: pull_request"],
	},
	{
		slug: "service-entry-point",
		label: "public entry point",
		tier: "noisy",
		patterns: [
			/\b(app|router)\.(get|post|put|patch|delete|all)\s*\(/,
			/@\w+\.(get|post|put|patch|delete)\s*\(/,
			/\bexport\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/,
			/\bfunc\s+\w+\s*\([^)]*http\.(ResponseWriter|Request)/,
			/\b(public\s+)?(async\s+)?Task<.*>\s+\w+\s*\(/,
		],
		notes: "Weak entry-point anchor. Report only if user input reaches a sink, or a sensitive operation runs with no authentication and no authorization check on the resource.",
		examples: ["app.get('/users', handler)", "export async function POST(req) {}"],
		counterExamples: ["const app = express();"],
	},
	{
		slug: "nosql-injection",
		label: "NoSQL query built from request input",
		tier: "normal",
		patterns: [/\$where\s*[:=]/, /\b(find|findOne|updateOne|updateMany|deleteOne|aggregate)\s*\(\s*(req|request)\.(body|query|params)/],
		notes: "Passing a request object straight into a query lets an attacker inject operators such as $ne or $gt. Explicitly picked scalar fields, or a schema-validated object, defeat it.",
		examples: ["db.users.find({ $where: q })", "User.findOne(req.body)"],
		counterExamples: ["User.findOne({ _id: id })"],
	},
	{
		slug: "unsafe-deserialization",
		label: "deserialization of untrusted data",
		tier: "precise",
		patterns: [/\b(pickle|cPickle)\.loads?\s*\(/, /\byaml\.load\s*\(/, /\bMarshal\.load\s*\(/, /\bunserialize\s*\(/, /\bnew\s+ObjectInputStream\s*\(/],
		notes: "These formats can instantiate arbitrary types, so reaching one with attacker bytes is remote code execution. A safe loader or a schema-validated JSON parse is the fix.",
		examples: ["pickle.loads(data)", "yaml.load(f)", "unserialize($data)", "new ObjectInputStream(in)"],
		counterExamples: ["yaml.safe_load(f)", "JSON.parse(s)"],
	},
	{
		slug: "prototype-pollution",
		label: "recursive merge or dynamic key write",
		tier: "normal",
		patterns: [/\b(_\.merge|_\.defaultsDeep|_\.mergeWith|deepMerge|extend)\s*\(\s*\{?\s*\}?\s*,\s*(req|request|JSON\.parse)/, /\[\s*(req|request)\.(body|query|params)\.[\w.]+\s*\]\s*=/],
		notes: "A recursive merge of attacker JSON can set __proto__ or constructor.prototype and change objects the code later trusts. Reject those keys, or use a null-prototype target.",
		examples: ["_.merge({}, req.body)", "obj[req.query.key] = value"],
		counterExamples: ["Object.assign({}, defaults)", "obj[safeKey] = value"],
	},
	{
		slug: "xxe",
		label: "XML parser with external entities",
		tier: "precise",
		patterns: [/resolve_entities\s*=\s*True/, /\bnoent\s*[:=]\s*(true|True)/, /DocumentBuilderFactory\.newInstance\s*\(/, /\bXMLParser\s*\(/],
		notes: "External entity resolution turns XML parsing into file read and SSRF. Only a finding when the parsed document is attacker-supplied and entity resolution is not disabled.",
		examples: ["etree.XMLParser(resolve_entities=True)", "DocumentBuilderFactory.newInstance()"],
		counterExamples: ["import defusedxml.ElementTree as ET"],
	},
	{
		slug: "ssti",
		label: "template compiled from dynamic input",
		tier: "precise",
		patterns: [/\brender_template_string\s*\(/, /\bjinja2\.Template\s*\(/, /\bHandlebars\.compile\s*\(/, /\bnew\s+Function\s*\(/],
		notes: "Compiling a template from user input executes in the template engine's context, which is usually full code execution. Passing user data as template variables is safe.",
		examples: ["render_template_string(user_input)", "Handlebars.compile(tpl)", "new Function(src)"],
		counterExamples: ["render_template('index.html', name=name)"],
	},
	{
		slug: "zip-slip",
		label: "archive extraction",
		tier: "normal",
		patterns: [/\bextractall\s*\(/i, /\bextractAll\w*\s*\(/, /\b(tar|zipfile|AdmZip|unzipper)\b[^;\n]{0,40}\bextract/i],
		notes: "Archive entries can contain ../ paths that escape the destination directory. Only a finding when the archive is attacker-supplied and entry paths are not resolved and prefix-checked.",
		examples: ["zipfile.ZipFile(f).extractall(dest)", "new AdmZip(buf).extractAllTo(dir)"],
		counterExamples: ["const extracted = true;"],
	},
	{
		slug: "mass-assignment",
		label: "request body spread into a write",
		tier: "normal",
		patterns: [/\b(create|update|insert|save|build|upsert)\s*\([^)]*\.\.\.\s*(req|request)\.(body|query)/, /\.(create|update|insert|save|upsert)\s*\(\s*(req|request)\.body\s*[,)]/],
		notes: "Spreading a request body into a model write lets an attacker set fields the form never exposed, such as role, isAdmin, or ownerId. An explicit field pick defeats it.",
		examples: ["User.create({ ...req.body })", "db.update(req.body)", "db.users.update({ id: uid }, { ...req.body })"],
		counterExamples: ["User.create({ name: req.body.name })"],
	},
	{
		slug: "jwt-weak-verify",
		label: "unverified or weakly verified JWT",
		tier: "precise",
		patterns: [/\bjwt\.decode\s*\((?![^)]*algorithms)/, /algorithms?\s*[:=]\s*\[?\s*['"]none['"]/i, /ignoreExpiration\s*:\s*true/i, /verify_signature\s*[:=]\s*False/],
		notes: "Decoding without verifying, or accepting the none algorithm, means the token is attacker-authored. Verification must pin an explicit algorithm allowlist.",
		examples: ["jwt.decode(token)", "algorithms: ['none']", "ignoreExpiration: true"],
		counterExamples: ["jwt.verify(token, key, { algorithms: ['RS256'] })", "jwt.decode(token, key, algorithms=['RS256'])"],
	},
	{
		slug: "cors-wildcard",
		label: "permissive CORS policy",
		tier: "normal",
		patterns: [/Access-Control-Allow-Origin['"]?\s*[,:=]\s*['"]\*/i, /\borigin\s*:\s*(true|['"]\*['"])/, /Access-Control-Allow-Credentials['"]?\s*[,:=]\s*['"]?true/i],
		notes: "A wildcard origin matters most when combined with credentials, or when the origin is reflected from the request. A static allowlist of known origins is safe.",
		examples: ["res.setHeader('Access-Control-Allow-Origin', '*')", "cors({ origin: true })"],
		counterExamples: ["origin: allowedOrigins"],
	},
	{
		slug: "session-cookie-config",
		label: "session cookie flags",
		tier: "normal",
		patterns: [/httpOnly\s*:\s*false/i, /\bsecure\s*:\s*false/i, /sameSite\s*:\s*['"]none['"]/i, /\bhttponly\s*=\s*False/i],
		notes: "Only report when the cookie carries a session or auth token. Missing httpOnly matters if the app also has an XSS sink; sameSite=none without secure is directly exploitable.",
		examples: ["res.cookie('sid', v, { httpOnly: false })", "sameSite: 'none'"],
		counterExamples: ["{ httpOnly: true, secure: true }"],
	},
	{
		slug: "env-secret-fallback",
		label: "secret with a hardcoded fallback",
		tier: "precise",
		patterns: [/process\.env\.\w*(SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL)\w*\s*\|\|\s*['"][^'"]+['"]/i, /os\.environ\.get\s*\(\s*['"][^'"]*(SECRET|KEY|TOKEN|PASSWORD)[^'"]*['"]\s*,\s*['"][^'"]+['"]/i],
		notes: "A default secret ships in the binary and is identical for every deployment, so it is effectively public. Failing closed when the variable is unset is the fix.",
		examples: ["process.env.JWT_SECRET || 'dev-secret'", "os.environ.get('API_KEY', 'changeme')"],
		counterExamples: ["process.env.JWT_SECRET || ''"],
	},
	{
		slug: "secret-in-log",
		label: "credential written to a log",
		tier: "normal",
		patterns: [/\b(console\.(log|info|warn|error|debug)|logger?\.(info|debug|warn|error)|print|println|fmt\.Print\w*)\s*\([^)\n]{0,120}\b(password|passwd|secret|token|api[_-]?key|credential|authorization)\b/i],
		notes: "Logs are usually retained longer and read more widely than the data they contain. Report when a real credential value, not just its name, reaches the sink.",
		examples: ["console.log('token', token)", "logger.info(f'password={pw}')"],
		counterExamples: ["console.log('request finished')"],
	},
	{
		slug: "timing-unsafe-compare",
		label: "secret compared with a non-constant-time operator",
		tier: "normal",
		patterns: [/\b(token|secret|signature|hmac|digest|apikey|api_key)\w*\s*(===?|!==?)\s*[\w'"]/i, /\.equals\s*\(\s*\w*(signature|hmac|token|secret)/i],
		notes: "Byte comparison short-circuits, so response time leaks how many leading bytes matched. Only meaningful when an attacker can retry cheaply against a secret they are guessing.",
		examples: ["if (signature === expected)", "token == provided"],
		counterExamples: ["crypto.timingSafeEqual(a, b)"],
	},
	{
		slug: "regex-dos",
		label: "regex compiled from a variable",
		tier: "normal",
		patterns: [/new\s+RegExp\s*\(\s*[^'"\s)]/, /re\.compile\s*\(\s*(?!r?['"])[^\s)]/],
		notes: "A regex built from user input allows both catastrophic backtracking and filter bypass. Report when the pattern source or the tested input is attacker-controlled and unbounded.",
		examples: ["new RegExp(userPattern)", "re.compile(pattern)", "re.compile(rawFromUser)"],
		counterExamples: ["new RegExp('^abc$')", "re.compile(r'^abc$')", 're.compile("^abc$")'],
	},
	{
		slug: "insecure-random-token",
		label: "security value from a non-cryptographic RNG",
		tier: "precise",
		patterns: [/\b(token|session|nonce|salt|otp|reset|verification|apikey)\w*\s*[:=]\s*(Math\.random|random\.random|rand\.Int)/i, /(Math\.random|random\.random)\s*\(\s*\)[^;\n]{0,40}\b(token|nonce|salt|otp|session)\b/i],
		notes: "These generators are seeded predictably, so a value that must be unguessable becomes guessable. Use crypto.randomBytes, secrets, or crypto/rand instead.",
		examples: ["const token = Math.random().toString(36)", "sessionId = Math.random()"],
		counterExamples: ["const jitter = Math.random();"],
	},
	{
		slug: "debug-endpoint",
		label: "debug or internal route",
		tier: "normal",
		patterns: [/\b(app|router|r)\.(get|post|put|all)\s*\(\s*['"`][^'"`]*\b(debug|__|internal|test)\b/i, /['"`]\/(debug|__debug|internal)\/[^'"`]*['"`]/],
		notes: "Report when the route is reachable in production and exposes configuration, environment, tokens, or state-changing operations without authentication.",
		examples: ["app.get('/debug/env', h)", "router.post('/internal/reset', h)"],
		counterExamples: ["app.get('/users', h)"],
	},
	{
		slug: "webhook-no-signature",
		label: "webhook receiver",
		tier: "normal",
		patterns: [/['"`][^'"`]*\/webhooks?\/[^'"`]*['"`]/i, /\bwebhook\w*\s*(handler|Handler|=|:)/],
		notes: "A webhook endpoint is public by definition, so it must verify a provider HMAC signature and reject replays. Report when no signature check precedes the side effect.",
		examples: ["app.post('/webhooks/stripe', handler)", "const webhookHandler = async (req) => {}"],
		counterExamples: ["// deliver a callback later"],
	},
	{
		slug: "nextjs-server-action",
		label: "Next.js server action",
		tier: "normal",
		patterns: [/\bexport\s+async\s+function\s+\w+\s*\(/, /\bexport\s+const\s+\w+\s*=\s*async\s*\(/],
		filePatterns: [/\.(ts|tsx|js|jsx|mjs)$/],
		requires: { tech: ["nextjs"], sentinel: [/['"]use server['"]/] },
		sentinelExamples: ["'use server'"],
		notes: "Server Actions are public POST endpoints with no implicit auth. Flag any that do not explicitly check both authentication and ownership of the record they touch.",
		examples: ["export async function deleteUser(id) {", "export const save = async (data) => {"],
		counterExamples: ["export function Page() {"],
	},
	{
		slug: "nextjs-route-handler",
		label: "Next.js route handler",
		tier: "noisy",
		patterns: [/\bexport\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/, /\bexport\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/],
		filePatterns: [/route\.(ts|tsx|js|jsx|mjs)$/, /\/api\//],
		requires: { tech: ["nextjs"] },
		notes: "Route handlers bypass page-level protection. Verify the handler itself authenticates; middleware matchers can be escaped by paths the config does not cover.",
		examples: ["export async function POST(req) {", "export const GET = handler"],
		counterExamples: ["export default function Page() {"],
	},
	{
		slug: "nextjs-middleware",
		label: "Next.js middleware auth logic",
		tier: "precise",
		patterns: [/\bexport\s+(async\s+)?function\s+middleware\s*\(/, /\bexport\s+const\s+config\s*=\s*\{[^}]*matcher/],
		filePatterns: [/(^|\/)middleware\.(ts|js|mjs)$/],
		requires: { tech: ["nextjs"] },
		notes: "Middleware runs before the handler but its matcher config decides what it covers. Check for routes the matcher misses, and for auth decisions made from spoofable headers.",
		examples: ["export function middleware(req) {", "export const config = { matcher: ['/app/:path*'] }"],
		counterExamples: ["export function Layout() {"],
	},
	{
		slug: "trpc-public-procedure",
		label: "tRPC public procedure",
		tier: "normal",
		patterns: [/\bpublicProcedure\b/, /\bt\.procedure\b/],
		filePatterns: [/\.(ts|tsx|js|jsx|mjs)$/],
		requires: { tech: ["trpc"] },
		notes: "publicProcedure inside an otherwise authenticated router is usually an oversight. Report when the resolver reads or writes tenant data without its own check.",
		examples: ["const listUsers = publicProcedure.query(...)", "t.procedure.mutation(fn)"],
		counterExamples: ["const listUsers = protectedProcedure.query(fn)"],
	},
	{
		slug: "graphql-resolver",
		label: "GraphQL resolver",
		tier: "noisy",
		patterns: [/\bresolvers?\s*[:=]\s*\{/, /\b(Query|Mutation)\s*:\s*\{/],
		filePatterns: [/\.(ts|tsx|js|jsx|mjs)$/],
		requires: { tech: ["graphql"] },
		notes: "Field-level authorization is the common gap: the query is authenticated but individual fields or nested resolvers are not. Check per-field access and query depth or cost limits.",
		examples: ["const resolvers = {", "Mutation: {"],
		counterExamples: ["const schema = buildSchema(typeDefs)"],
	},
	{
		slug: "prisma-raw",
		label: "Prisma raw query",
		tier: "precise",
		patterns: [/\$(queryRaw|executeRaw)Unsafe\s*\(/],
		filePatterns: [/\.(ts|tsx|js|jsx|mjs)$/],
		requires: { tech: ["prisma"] },
		notes: "The Unsafe variants take a plain string and do not parameterize. The sql`` tagged template binds its ${} interpolations and is safe, so only the Unsafe calls are anchored here.",
		examples: ["prisma.$queryRawUnsafe(sql)", "prisma.$executeRawUnsafe(q)"],
		counterExamples: ["prisma.user.findMany({ where: { id } })", "prisma.$queryRaw`SELECT * FROM t WHERE id = ${id}`"],
	},
	{
		slug: "drizzle-raw",
		label: "Drizzle raw SQL",
		tier: "precise",
		patterns: [/\bsql\.raw\s*\(/, /\bdb\.execute\s*\(\s*sql\.raw/],
		filePatterns: [/\.(ts|tsx|js|jsx|mjs)$/],
		requires: { tech: ["drizzle"] },
		notes: "sql.raw bypasses Drizzle's parameter binding. The sql`` tagged template binds its interpolations and is safe.",
		examples: ["db.execute(sql.raw(query))", "sql.raw(userInput)"],
		counterExamples: ["db.select().from(users).where(eq(users.id, id))"],
	},
	{
		slug: "python-entry-point",
		label: "Python web entry point",
		tier: "noisy",
		patterns: [/@(app|router|bp|blueprint)\.(route|get|post|put|patch|delete)\s*\(/i, /\bdef\s+\w+\s*\(\s*(self\s*,\s*)?request\b/, /\bclass\s+\w+\s*\(\s*(APIView|ViewSet|ModelViewSet|View)\b/],
		filePatterns: [/\.py$/],
		requires: { tech: ["python", "django", "flask", "fastapi"] },
		notes: "Weak entry-point anchor. Confirm there is no @login_required, LoginRequiredMixin, or DRF permission_classes, and that user input actually reaches a sink, before flagging.",
		examples: ["@app.route('/users')", "def get(self, request):", "class UserView(APIView):"],
		counterExamples: ["def helper(value):"],
	},
	{
		slug: "go-entry-point",
		label: "Go HTTP entry point",
		tier: "noisy",
		patterns: [/\b(r|router|mux|e|app)\.(GET|POST|PUT|PATCH|DELETE|Handle|HandleFunc)\s*\(/, /\bfunc\s+\w*\s*\([^)]*http\.ResponseWriter/],
		filePatterns: [/\.go$/],
		requires: { tech: ["go", "gin", "echo", "chi", "fiber"] },
		notes: "Weak entry-point anchor. Confirm no auth middleware is applied to the enclosing group or router chain before the route is registered.",
		examples: ["r.GET('/users', handler)", "func Index(w http.ResponseWriter, r *http.Request) {"],
		counterExamples: ["func helper(value string) error {"],
	},
	{
		slug: "ruby-entry-point",
		label: "Ruby web entry point",
		tier: "noisy",
		patterns: [/\bclass\s+\w+Controller\s*<\s*/, /\b(get|post|put|patch|delete)\s+['"]\//],
		filePatterns: [/\.rb$/],
		requires: { tech: ["ruby", "rails", "sinatra"] },
		notes: "Weak entry-point anchor. Check for a before_action authentication filter and for skip_before_action calls that remove it for specific actions.",
		examples: ["class UsersController < ApplicationController", "get '/users' do"],
		counterExamples: ["class UserPresenter"],
	},
	{
		slug: "php-entry-point",
		label: "PHP web entry point",
		tier: "noisy",
		patterns: [/\bRoute::(get|post|put|patch|delete|any)\s*\(/, /\bclass\s+\w+Controller\b/],
		filePatterns: [/\.php$/],
		requires: { tech: ["php", "laravel", "symfony"] },
		notes: "Weak entry-point anchor. Confirm the route or controller carries an auth middleware and a policy or gate check for the record it touches.",
		examples: ["Route::post('/users', [UserController::class, 'store'])", "class UserController extends Controller"],
		counterExamples: ["class UserRepository"],
	},
	{
		slug: "java-entry-point",
		label: "JVM web entry point",
		tier: "noisy",
		patterns: [/@(RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\s*\(/, /@(RestController|Controller)\b/],
		filePatterns: [/\.(java|kt)$/],
		requires: { tech: ["jvm", "spring"] },
		notes: "Weak entry-point anchor. Check for @PreAuthorize or an equivalent security config entry, and confirm the method authorizes the specific resource, not just the caller.",
		examples: ["@GetMapping('/users')", "@RestController"],
		counterExamples: ["@Component"],
	},
	{
		slug: "terraform-public-exposure",
		label: "infrastructure exposed publicly",
		tier: "precise",
		patterns: [/0\.0\.0\.0\/0/, /\bacl\s*=\s*['"]public-read/, /\bpublicly_accessible\s*=\s*true/, /"Principal"\s*:\s*"\*"/],
		filePatterns: [/\.tf$/, /\.tfvars$/],
		requires: { tech: ["terraform"] },
		notes: "Report when the exposed resource carries data or an admin port. An open ingress on a public load balancer for 80 or 443 is usually intended; 22, 3389, or a database port is not.",
		examples: ["cidr_blocks = ['0.0.0.0/0']", "acl = 'public-read'", "publicly_accessible = true"],
		counterExamples: ["cidr_blocks = ['10.0.0.0/8']"],
	},
	{
		slug: "container-privileged",
		label: "privileged or root container",
		tier: "normal",
		patterns: [/\bprivileged\s*:\s*true/, /\bUSER\s+root\b/i, /--privileged\b/, /allowPrivilegeEscalation\s*:\s*true/, /hostNetwork\s*:\s*true/],
		filePatterns: [/Dockerfile[^/]*$/, /\.ya?ml$/, /compose\.ya?ml$/],
		requires: { tech: ["docker"] },
		notes: "A privileged container shares the host kernel namespace, so a compromise inside it becomes host compromise. Report when the workload also handles untrusted input.",
		examples: ["privileged: true", "USER root", "hostNetwork: true"],
		counterExamples: ["USER node"],
	},
	{
		slug: "agentic-prompt-injection",
		label: "untrusted data interpolated into a model prompt",
		tier: "normal",
		patterns: [/\b(prompt|messages|system|instructions)\s*[:=][^;\n]{0,80}\$\{/, /\b(prompt|systemPrompt)\s*[:=]\s*[`'"][^`'"]*\+\s*\w/, /\.(complete|chat|invoke|generate|createMessage)\s*\(\s*[^)]*\b(req|request|input|userInput|body)\b/],
		notes: "Text pulled from files, web pages, tickets, or tool output can carry instructions the model will follow. Report when such data reaches a prompt and the model can then call a tool with side effects.",
		examples: ["const prompt = `Summarize: ${userInput}`", "llm.invoke(req.body.text)"],
		counterExamples: ["const prompt = 'Summarize the document.'"],
	},
	{
		slug: "agent-tool-handler",
		label: "agent or MCP tool handler",
		tier: "normal",
		patterns: [/\b(registerTool|addTool|setRequestHandler|tool)\s*\(\s*['"`]/, /\btools\s*:\s*\[/, /CallToolRequestSchema/],
		notes: "Each tool is an independent entry point reachable by anything that can influence the model. Report when a tool performs a privileged action with no per-call authorization or argument validation.",
		examples: ["server.registerTool('runQuery', schema, handler)", "tools: ["],
		counterExamples: ["const toolNames = list.map(String)"],
	},
	{
		slug: "iac-secret-plaintext",
		label: "plaintext secret in infrastructure config",
		tier: "precise",
		patterns: [/\b(password|secret|token|access_key|secret_key)\s*=\s*['"][^'"\n$]{8,}['"]/i, /\b(ENV|ARG)\s+\w*(PASSWORD|SECRET|TOKEN|KEY)\w*\s*=\s*\S+/],
		filePatterns: [/\.tf$/, /\.tfvars$/, /Dockerfile[^/]*$/, /\.ya?ml$/],
		notes: "Values committed here reach every image layer, state file, and CI log. A variable reference or secret-manager lookup is the fix; confirm the literal is not a placeholder.",
		examples: ["password = 'supersecret123'", "ENV API_TOKEN=abc123def456"],
		counterExamples: ["password = var.db_password"],
	},
];

function positiveInt(value, fallback, name, max) {
	const number = Number(value ?? fallback);
	if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`security-review: ${name} must be an integer from 1 to ${max}`);
	return number;
}

// Manifest token -> tech tag. Matchers declare requires.tech against these.
const TECH_MANIFESTS = [
	{ file: "package.json", max: 400_000, tags: { node: /./, nextjs: /"next"\s*:/, react: /"react"\s*:/, express: /"express"\s*:/, fastify: /"fastify"\s*:/, nestjs: /"@nestjs\/core"\s*:/, hono: /"hono"\s*:/, koa: /"koa"\s*:/, trpc: /"@trpc\//, graphql: /"(graphql|@apollo\/server)"\s*:/, prisma: /"@prisma\/client"\s*:/, drizzle: /"drizzle-orm"\s*:/, mongoose: /"(mongoose|mongodb)"\s*:/, mcp: /"@modelcontextprotocol\//, svelte: /"@sveltejs\/kit"\s*:/, vue: /"(vue|nuxt)"\s*:/ } },
	{ file: "requirements.txt", max: 200_000, tags: { python: /./, django: /^\s*django\b/im, flask: /^\s*flask\b/im, fastapi: /^\s*fastapi\b/im, sqlalchemy: /^\s*sqlalchemy\b/im } },
	{ file: "pyproject.toml", max: 200_000, tags: { python: /./, django: /\bdjango\b/i, flask: /\bflask\b/i, fastapi: /\bfastapi\b/i, sqlalchemy: /\bsqlalchemy\b/i } },
	{ file: "go.mod", max: 200_000, tags: { go: /./, gin: /gin-gonic\/gin/, echo: /labstack\/echo/, chi: /go-chi\/chi/, fiber: /gofiber\/fiber/ } },
	{ file: "Gemfile", max: 200_000, tags: { ruby: /./, rails: /['"]rails['"]/, sinatra: /['"]sinatra['"]/ } },
	{ file: "composer.json", max: 200_000, tags: { php: /./, laravel: /"laravel\/framework"\s*:/, symfony: /"symfony\// } },
	{ file: "Cargo.toml", max: 200_000, tags: { rust: /./, axum: /^\s*axum\b/im, actix: /^\s*actix-web\b/im } },
	{ file: "pom.xml", max: 400_000, tags: { jvm: /./, spring: /springframework/ } },
	{ file: "build.gradle", max: 200_000, tags: { jvm: /./, spring: /springframework/ } },
];

const TECH_SENTINELS = [
	{ tag: "nextjs", names: ["next.config.js", "next.config.mjs", "next.config.ts"] },
	{ tag: "django", names: ["manage.py"] },
	{ tag: "laravel", names: ["artisan"] },
	{ tag: "docker", names: ["Dockerfile", "docker-compose.yml", "compose.yaml"] },
	{ tag: "github-actions", names: [".github"] },
	{ tag: "dotnet", names: ["global.json"] },
];

// Fails open: an unrecognized project yields an empty set and every matcher runs ungated.
function detectTech(root) {
	const tech = new Set();
	for (const manifest of TECH_MANIFESTS) {
		let content;
		try {
			const full = resolve(root, manifest.file);
			if (!statSync(full).isFile() || statSync(full).size > manifest.max) continue;
			content = readFileSync(full, "utf8");
		} catch {
			continue;
		}
		for (const [tag, pattern] of Object.entries(manifest.tags)) if (pattern.test(content)) tech.add(tag);
	}
	for (const sentinel of TECH_SENTINELS) {
		for (const name of sentinel.names) {
			try {
				statSync(resolve(root, name));
				tech.add(sentinel.tag);
				break;
			} catch {
				/* absent */
			}
		}
	}
	try {
		if (readdirSync(root).some((entry) => entry.endsWith(".tf"))) tech.add("terraform");
	} catch {
		/* unreadable root */
	}
	return tech;
}

// Tech detection is advisory only. It informs the report and matcher intent, but it must never
// disable a matcher: a polyglot or monorepo checkout can easily present one stack's manifest at the
// root while the risky code belongs to another. Real gating is done by filePatterns (path evidence)
// and requires.sentinel (content evidence), neither of which relies on inference.
function activeMatchers() {
	return { matchers: MATCHERS };
}

function inside(base, value) {
	const path = resolve(base, value || ".");
	const rel = relative(base, path);
	if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`security-review: path escapes workflow cwd: ${value}`);
	return path;
}

function realInside(base, path) {
	const realBase = realpathSync(base);
	const realPath = realpathSync(path);
	const rel = relative(realBase, realPath);
	if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`security-review: real path escapes scope: ${path}`);
	return realPath;
}

function scopedPath(root, path) {
	return realInside(root, inside(root, path));
}

function relPath(root, path) {
	const rel = relative(root, path).replaceAll("\\", "/");
	return rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel) ? rel : null;
}

function ignored(path) {
	const parts = path.split("/");
	if (parts.some((part) => IGNORE_DIRS.has(part))) return true;
	return path.endsWith(".lock") || path.endsWith(".min.js") || path.endsWith(".map") || path.endsWith(".d.ts") || path.endsWith(".md") || path.endsWith(".mdx");
}

function safeFile(root, path, maxFileSize, direct) {
	if (!path || path.startsWith("../") || isAbsolute(path) || (!direct && ignored(path))) return false;
	// Our own output can contain verbatim secret-bearing evidence lines; never feed it back in.
	if (path === ARTIFACT_DIR || path.startsWith(`${ARTIFACT_DIR}/`) || path.includes(`/${ARTIFACT_DIR}/`)) return false;
	if (!direct && !SOURCE_EXTS.has(extname(path).toLowerCase()) && !SOURCE_FILENAMES.has(basename(path))) return false;
	try {
		const full = scopedPath(root, path);
		const stat = statSync(full);
		return stat.isFile() && stat.size <= maxFileSize;
	} catch {
		return false;
	}
}

function walk(root, maxFileSize) {
	const found = [];
	const visit = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = resolve(dir, entry.name);
			const rel = relPath(root, full);
			if (!rel) continue;
			if (entry.isDirectory()) {
				if (!IGNORE_DIRS.has(entry.name)) visit(full);
			} else if (entry.isFile() && safeFile(root, rel, maxFileSize, false)) {
				found.push(rel);
			}
		}
	};
	visit(root);
	return found.sort();
}

function git(root, args) {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
	if (result.status !== 0) return null;
	return String(result.stdout || "")
		.split(/\r?\n/)
		.map((line) => line.trim().replaceAll("\\", "/"))
		.filter(Boolean);
}

function changedFiles(root) {
	let tracked = git(root, ["diff", "--name-only", "--relative", "--diff-filter=AMRC", "HEAD", "--", "."]);
	if (tracked == null) {
		const staged = git(root, ["diff", "--name-only", "--relative", "--cached", "--diff-filter=AMRC", "--", "."]) || [];
		const working = git(root, ["diff", "--name-only", "--relative", "--diff-filter=AMRC", "--", "."]) || [];
		tracked = [...staged, ...working];
	}
	const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "--", "."]) || [];
	return [...new Set([...tracked, ...untracked])].sort();
}

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@{}~^-]{0,254}$/;

// Refs reach git as argv entries, so a leading "-" would be parsed as a flag.
function checkedRef(root, value, name) {
	const ref = String(value ?? "").trim();
	if (!REF_PATTERN.test(ref)) throw new Error(`security-review: ${name} is not a valid git ref: ${value}`);
	if (!git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) throw new Error(`security-review: ${name} does not resolve to a commit: ${ref}`);
	return ref;
}

function branchDiffFiles(root, base, head) {
	const range = `${base}...${head}`;
	const changed = git(root, ["diff", "--name-only", "--relative", "--diff-filter=AMRC", range, "--", "."]);
	if (changed == null) throw new Error(`security-review: unable to diff ${range}`);
	return [...new Set(changed)].sort();
}

// Candidates are read from the working tree, so reviewing a ref we are not on would report findings
// against content that was never examined.
function requireCheckedOut(root, head) {
	const headSha = git(root, ["rev-parse", "--verify", "--quiet", `${head}^{commit}`])?.[0];
	const currentSha = git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?.[0];
	if (!headSha || !currentSha) throw new Error("security-review: unable to resolve HEAD for the branch diff");
	if (headSha !== currentSha) {
		throw new Error(
			`security-review: head (${head} = ${headSha.slice(0, 8)}) is not the checked-out commit (${currentSha.slice(0, 8)}). ` +
				"Files are reviewed from the working tree, so check that ref out first or omit head.",
		);
	}
}

// git() trims each line, so --porcelain status columns cannot be parsed positionally here.
function dirtyAmong(root, paths) {
	const selected = new Set(paths);
	const unstaged = git(root, ["diff", "--name-only", "--relative", "--", "."]) || [];
	const staged = git(root, ["diff", "--name-only", "--relative", "--cached", "--", "."]) || [];
	return [...new Set([...unstaged, ...staged])].filter((path) => selected.has(path)).sort();
}

function readText(path) {
	const data = readFileSync(path);
	if (data.includes(0)) throw new Error("binary file");
	return data.toString("utf8").replaceAll("\r\n", "\n");
}

const snippet = (line) => line.trim().replace(/\s+/g, " ").slice(0, 240);

function scanContent(path, content, matchers) {
	const candidates = [];
	for (const matcher of matchers) {
		if (matcher.filePatterns && !matcher.filePatterns.some((pattern) => pattern.test(path))) continue;
		// Whole-file precondition: the anchor only means anything in the right kind of file.
		if (matcher.requires?.sentinel && !matcher.requires.sentinel.some((pattern) => pattern.test(content))) continue;
		for (const [index, line] of content.split("\n").entries()) {
			if (!matcher.patterns.some((pattern) => pattern.test(line))) continue;
			candidates.push({
				vulnClass: matcher.slug,
				noiseTier: matcher.tier,
				line: index + 1,
				snippet: snippet(line),
				matchedPattern: matcher.label,
			});
		}
	}
	const unique = [];
	const seen = new Set();
	for (const candidate of candidates) {
		const key = `${candidate.vulnClass}:${candidate.line}:${candidate.matchedPattern}`;
		if (!seen.has(key)) {
			seen.add(key);
			unique.push(candidate);
		}
	}
	return unique;
}

// Precise anchors must survive the per-file cap ahead of noisy ones.
function rankForCap(candidates, maxPerFile) {
	if (candidates.length <= maxPerFile) return candidates;
	return [...candidates]
		.sort((left, right) => (NOISE[left.noiseTier] ?? 1) - (NOISE[right.noiseTier] ?? 1) || left.line - right.line)
		.slice(0, maxPerFile);
}

function scanFile(root, path, direct, maxPerFile, matchers) {
	const content = readText(scopedPath(root, path));
	const unique = scanContent(path, content, matchers);
	const ranked = rankForCap(unique, maxPerFile);
	return {
		record: {
			filePath: path,
			fileHash: createHash("sha256").update(content).digest("hex"),
			candidates: ranked,
			reviewMode: unique.length ? "candidate-anchored" : "full-static-review",
		},
		candidateCount: unique.length,
		candidatesDropped: Math.max(0, unique.length - maxPerFile),
		include: direct || unique.length > 0,
	};
}

function rankRecord(record, priorityPaths) {
	const tiers = record.candidates.map((candidate) => NOISE[candidate.noiseTier] ?? 1);
	const noise = tiers.length ? Math.min(...tiers) : 3;
	const priority = priorityPaths.findIndex((prefix) => record.filePath === prefix || record.filePath.startsWith(prefix + "/"));
	return [noise, priority < 0 ? priorityPaths.length : priority, -record.candidates.length, record.filePath];
}

function compareTuple(left, right) {
	for (let i = 0; i < left.length; i++) {
		if (left[i] < right[i]) return -1;
		if (left[i] > right[i]) return 1;
	}
	return 0;
}

export async function discover(input = {}, ctx) {
	const opts = input && typeof input === "object" && !Array.isArray(input) ? input : {};
	const hasFiles = Array.isArray(opts.files) && opts.files.length > 0;
	const scopes = [opts.root ? "root" : null, hasFiles ? "files" : null, opts.base ? "base" : null].filter(Boolean);
	if (scopes.length > 1) throw new Error(`security-review: choose one scope, not ${scopes.join(" and ")}`);
	if (opts.head && !opts.base) throw new Error("security-review: head requires base");
	const root = realInside(ctx.cwd, inside(ctx.cwd, opts.root || "."));
	if (!statSync(root).isDirectory()) throw new Error(`security-review: root is not a directory: ${opts.root}`);
	const maxFileSize = positiveInt(opts.max_file_size, 200000, "max_file_size", 5_000_000);
	const maxFiles = positiveInt(opts.max_files, 60, "max_files", 200);
	const maxCandidates = positiveInt(opts.max_candidates, 500, "max_candidates", 2000);
	const maxPerFile = positiveInt(opts.max_candidates_per_file, 20, "max_candidates_per_file", 100);
	const priorityPaths = (Array.isArray(opts.priority_paths) ? opts.priority_paths : []).map((path) => String(path).replace(/^\/+|\/+$/g, "")).filter(Boolean);

	let selected;
	let source;
	let direct = false;
	let branchDiffDirty = [];
	if (hasFiles) {
		direct = true;
		source = "explicit files";
		selected = [...new Set(opts.files.map((path) => String(path).replace(/^\/+/, "")).filter((path) => safeFile(root, path, maxFileSize, true)))].sort();
	} else if (opts.base) {
		const base = checkedRef(root, opts.base, "base");
		const head = checkedRef(root, opts.head ?? "HEAD", "head");
		requireCheckedOut(root, head);
		direct = true;
		source = `branch diff ${base}...${head}`;
		selected = branchDiffFiles(root, base, head).filter((path) => safeFile(root, path, maxFileSize, true));
		branchDiffDirty = dirtyAmong(root, selected);
	} else if (opts.root) {
		source = `root:${opts.root}`;
		selected = walk(root, maxFileSize);
	} else {
		const changed = changedFiles(root).filter((path) => safeFile(root, path, maxFileSize, true));
		if (changed.length) {
			direct = true;
			source = "staged, unstaged, and untracked changes";
			selected = changed;
		} else {
			source = "repository scan (no local changes)";
			selected = walk(root, maxFileSize);
		}
	}

	const records = [];
	let unreadable = 0;
	let candidateCount = 0;
	let candidatesDropped = 0;
	const tech = detectTech(root);
	const { matchers } = activeMatchers();
	for (const path of selected) {
		try {
			const scanned = scanFile(root, path, direct, maxPerFile, matchers);
			candidateCount += scanned.candidateCount;
			candidatesDropped += scanned.candidatesDropped;
			if (scanned.include) records.push(scanned.record);
		} catch {
			unreadable++;
		}
	}
	records.sort((left, right) => compareTuple(rankRecord(left, priorityPaths), rankRecord(right, priorityPaths)));
	const preCapRecords = records.length;
	const boundaries = [];
	if (records.length > maxFiles) {
		records.length = maxFiles;
		boundaries.push(`Selected ${maxFiles}/${preCapRecords} review record(s) (max_files=${maxFiles}).`);
	}
	let remaining = maxCandidates;
	const capped = [];
	for (const record of records) {
		if (!direct && remaining <= 0) break;
		const keep = direct && !record.candidates.length ? [] : record.candidates.slice(0, remaining);
		candidatesDropped += Math.max(0, record.candidates.length - keep.length);
		remaining -= keep.length;
		if (direct || keep.length) capped.push({ ...record, candidates: keep });
	}
	if (candidateCount > maxCandidates) boundaries.push(`Selected at most ${maxCandidates}/${candidateCount} candidate hit(s) (max_candidates=${maxCandidates}).`);
	if (candidatesDropped) boundaries.push(`${candidatesDropped} candidate hit(s) omitted by per-file/global caps.`);
	if (unreadable) boundaries.push(`${unreadable} selected file(s) were unreadable or binary.`);

	if (branchDiffDirty.length) boundaries.push(`${branchDiffDirty.length} file(s) in the diff have uncommitted changes; the review covers the working tree, not the committed diff: ${branchDiffDirty.slice(0, 5).join(", ")}${branchDiffDirty.length > 5 ? ", ..." : ""}.`);

	const presentSlugs = new Set(capped.flatMap((record) => record.candidates.map((candidate) => candidate.vulnClass)));
	const slugNotes = {};
	for (const matcher of MATCHERS) if (matcher.notes && presentSlugs.has(matcher.slug)) slugNotes[matcher.slug] = matcher.notes;

	return {
		root,
		source,
		direct,
		tech: [...tech].sort(),
		matchersTotal: MATCHERS.length,
		slugNotes,
		selectedCount: selected.length,
		preCapRecords,
		records: capped,
		candidateCount: capped.reduce((count, record) => count + record.candidates.length, 0),
		preCapCandidateCount: candidateCount,
		unreadable,
		boundaries,
	};
}

function evidenceFor(lines, line) {
	const start = Math.max(0, line - 3);
	const end = Math.min(lines.length, line + 2);
	return lines
		.slice(start, end)
		.map((text, index) => `${start + index + 1}: ${text}`)
		.join("\n")
		.slice(0, 2000);
}

export async function validateFindings(input = {}, ctx) {
	const requestedRoot = inside(ctx.cwd, relative(ctx.cwd, resolve(String(input.root || ctx.cwd))));
	const root = realInside(ctx.cwd, requestedRoot);
	const allowed = new Map((Array.isArray(input.records) ? input.records : []).map((record) => [String(record.filePath), record]));
	const valid = [];
	const rejected = [];
	const seen = new Set();
	for (const finding of Array.isArray(input.findings) ? input.findings : []) {
		const filePath = String(finding?.filePath || "").replace(/^\/+/, "");
		const record = allowed.get(filePath);
		if (!record) {
			rejected.push({ finding, reason: "file is outside the enumerated batch" });
			continue;
		}
		try {
			const content = readText(scopedPath(root, filePath));
			const hash = createHash("sha256").update(content).digest("hex");
			if (hash !== record.fileHash) {
				rejected.push({ finding, reason: "file changed after discovery" });
				continue;
			}
			const lines = content.split("\n");
			const line = Number(finding.line);
			if (!Number.isInteger(line) || line < 1 || line > lines.length) {
				rejected.push({ finding, reason: "line is outside the current file" });
				continue;
			}
			const severity = String(finding.severity || "");
			if (!SEVERITIES.has(severity)) {
				rejected.push({ finding, reason: "invalid severity" });
				continue;
			}
			const anchor = String(finding.anchor || "").trim();
			if (!anchor) {
				rejected.push({ finding, reason: "missing semantic anchor" });
				continue;
			}
			const signature = `${filePath}:${String(finding.vulnClass || "")}:${anchor}`;
			if (seen.has(signature)) continue;
			seen.add(signature);
			valid.push({ ...finding, filePath, line, fileHash: hash, evidence: evidenceFor(lines, line) });
		} catch (error) {
			rejected.push({ finding, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return { valid, rejected };
}

const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const artifactStamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");

export async function writeFindings(input = {}, ctx) {
	const root = realInside(ctx.cwd, inside(ctx.cwd, String(input.root || ".")));
	const label = String(input.name ?? artifactStamp()).trim();
	if (!ARTIFACT_NAME_PATTERN.test(label)) throw new Error(`security-review: invalid artifact name: ${input.name}`);
	mkdirSync(resolve(root, ARTIFACT_DIR), { recursive: true });
	// realpath after mkdir: a symlinked artifact directory would otherwise escape the root.
	const dir = realInside(root, resolve(root, ARTIFACT_DIR));
	const fileName = `findings-${label}.json`;
	const target = resolve(dir, fileName);
	if (relative(dir, target) !== fileName) throw new Error("security-review: artifact path escaped the artifact directory");
	if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("security-review: refusing to write through a symlink");
	const document = {
		schemaVersion: "1.0",
		documentType: "security-review.findings",
		generatedAt: new Date().toISOString(),
		scope: input.scope ?? null,
		root: relative(ctx.cwd, root) || ".",
		stats: input.stats ?? {},
		boundaries: Array.isArray(input.boundaries) ? input.boundaries : [],
		findings: Array.isArray(input.findings) ? input.findings : [],
	};
	writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return { path: relative(ctx.cwd, target), count: document.findings.length };
}
writeFindings.mutates = true;

// Test-only surface; not part of the workflow host effect contract.
export const __matchers = MATCHERS;
export const __activeMatchers = activeMatchers;
export const __detectTech = detectTech;
export const __scanContent = scanContent;
export const __safeFile = safeFile;
export const __rankForCap = rankForCap;

const HISTORY_SUBJECT_LIMIT = 120;

// Read-only: lets verification distinguish "never real" from "already fixed".
export async function fileHistory(input = {}, ctx) {
	const root = realInside(ctx.cwd, inside(ctx.cwd, String(input.root || ".")));
	const filePath = String(input.filePath || "").replace(/^\/+/, "");
	if (!filePath || filePath.startsWith("../") || isAbsolute(filePath)) return { commits: [], available: false };
	const lines = git(root, ["log", "--no-merges", "-n", "10", "--since=6.months", "--format=%h %ad %s", "--date=short", "--", filePath]);
	if (lines == null) return { commits: [], available: false };
	return { commits: lines.map((line) => line.slice(0, HISTORY_SUBJECT_LIMIT)), available: true };
}

const CONTEXT_SOURCES = [".security-review/CONTEXT.md", "SECURITY.md", ".github/SECURITY.md", "docs/SECURITY.md"];
const CONTEXT_LIMIT = 8000;

// Policy data, never instructions: the caller wraps this in the untrusted-input rule.
// In branch-diff mode the policy is read from the base ref, so a change under review cannot
// widen its own exemptions.
export async function resolveContext(input = {}, ctx) {
	const root = realInside(ctx.cwd, inside(ctx.cwd, String(input.root || ".")));
	const inline = String(input.context ?? "").trim();
	if (inline) return { source: "inline args.context", text: inline.slice(0, CONTEXT_LIMIT), truncated: inline.length > CONTEXT_LIMIT, trusted: true };
	const base = String(input.base ?? "").trim();
	if (base && REF_PATTERN.test(base)) {
		for (const candidate of CONTEXT_SOURCES) {
			const lines = git(root, ["show", `${base}:${candidate}`]);
			if (!lines?.length) continue;
			const text = lines.join("\n").trim();
			if (!text) continue;
			return { source: `${candidate} @ ${base}`, text: text.slice(0, CONTEXT_LIMIT), truncated: text.length > CONTEXT_LIMIT, trusted: true };
		}
		return { source: null, text: "", truncated: false, trusted: true };
	}
	for (const candidate of CONTEXT_SOURCES) {
		try {
			const full = scopedPath(root, candidate);
			if (!statSync(full).isFile()) continue;
			const text = readText(full).trim();
			if (!text) continue;
			return { source: candidate, text: text.slice(0, CONTEXT_LIMIT), truncated: text.length > CONTEXT_LIMIT, trusted: false };
		} catch {
			/* absent or unreadable */
		}
	}
	return { source: null, text: "", truncated: false, trusted: false };
}

// Reads the newest prior artifact so a run can report what changed. Must be called before writeFindings.
export async function previousFindings(input = {}, ctx) {
	const root = realInside(ctx.cwd, inside(ctx.cwd, String(input.root || ".")));
	let entries;
	let dir;
	try {
		dir = realInside(root, resolve(root, ARTIFACT_DIR));
		entries = readdirSync(dir).filter((name) => /^findings-.+\.json$/.test(name)).sort();
	} catch {
		return { available: false, findings: [], source: null, scope: null };
	}
	for (const name of entries.reverse()) {
		try {
			const full = resolve(dir, name);
			if (lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
			if (statSync(full).size > MAX_ARTIFACT_BYTES) continue;
			const parsed = JSON.parse(readText(full));
			if (parsed?.documentType !== "security-review.findings" || !Array.isArray(parsed.findings)) continue;
			return {
				available: true,
				source: `${ARTIFACT_DIR}/${name}`,
				scope: parsed.scope ?? null,
				generatedAt: parsed.generatedAt ?? null,
				findings: parsed.findings.map((finding) => ({
					anchor: String(finding.anchor || ""),
					filePath: String(finding.filePath || ""),
					vulnClass: String(finding.vulnClass || ""),
					severity: String(finding.severity || ""),
					title: String(finding.title || ""),
				})),
			};
		} catch {
			/* skip unreadable or malformed artifacts */
		}
	}
	return { available: false, findings: [], source: null, scope: null };
}
