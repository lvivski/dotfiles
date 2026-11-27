/** @template [T=never] */
export class FoundryError extends Error {
	/** @param {string} code @param {string} message @param {T} [obstacle] */
	constructor(code, message,obstacle) { super(message); this.code = code; if(obstacle)this.obstacle=obstacle; }
}
/** @param {string} code @param {string} message @returns {never} */
export function fail(code,message){throw new FoundryError(code,message);}

/** @param {unknown} value @param {string} label */
export function text(value, label) {
	if (typeof value !== "string" || !value.trim() || value.includes("\0"))
		fail("invalid_field", `Expected ${label}`);
	return value;
}
/** @param {unknown} value */
export function relative(value) {
	const s = text(value, "repository-relative path");
	if (/[\\:\x00-\x1f\x7f]/.test(s) || s.split("/").some(part => !part || part === "." || part === ".." ||
		/^\.git[ .]*$/i.test(part) || /[ .]$/.test(part)))
		fail("invalid_path", `Invalid repository path: ${s}`);
	return s;
}

/** @typedef {import("./recipe-types.js").VerificationInputs} Inputs */
/** @typedef {import("./recipe-types.js").VerificationScope} Scope */
/** @param {unknown} x @returns {x is Record<string,unknown>} */
const record=x=>!!x && typeof x==="object" && !Array.isArray(x);
/** @param {Record<string,unknown>} x @param {string[]} keys */
const only=(x,keys)=>Object.keys(x).every(k=>keys.includes(k));
/** @param {unknown} x */
export const oid=x=>typeof x==="string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(x);
/** @param {unknown} x */
export const hash=x=>typeof x==="string" && /^[0-9a-f]{64}$/.test(x);
/** @param {unknown} x */
const path=x=>typeof x==="string" && relative(x)===x;
/** @param {unknown} x */
const paths=x=>Array.isArray(x) && x.every(path) && x.length===new Set(x).size;
/** @param {unknown} x */
export const validName=x=>typeof x==="string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(x) && !Object.hasOwn(Object.prototype,x);
/** @param {unknown} x */
const files=x=>record(x) && paths(x.directories) && paths(x.files);
/** @param {unknown} x */
const scope=x=>record(x) && (x.kind==="goal" && only(x,["kind"]) ||
	x.kind==="component" && only(x,["kind","grain","directories","files"]) && validName(x.grain) && files(x) ||
	x.kind==="product" && only(x,["kind","outputs"]) && Array.isArray(x.outputs) &&
	x.outputs.every(o=>record(o) && validName(o.id) && only(o,["id","directories","files","exclude"]) && files(o) &&
		(o.exclude===undefined || record(o.exclude) && only(o.exclude,["directories","files"]) && files(o.exclude))) &&
	x.outputs.length===new Set(x.outputs.map(o=>o.id)).size);
/** @param {unknown} x @param {boolean} [replacement] */
const checker=(x,replacement=false)=>record(x) && path(x.path) && oid(x.blob) && (x.mode==="100644" || x.mode==="100755") &&
	only(x,replacement?["path","blob","mode","replacement"]:["path","blob","mode"]) && (x.replacement===undefined ||
		record(x.replacement) && only(x.replacement,["revision","before"]) && oid(x.replacement.revision) && oid(x.replacement.before));
/** Validate the closed wire format before using a path, Git name, or environment value.
 * @param {unknown} v @returns {v is Inputs} */
export function validInputs(v){
	try{return record(v) && only(v,["version","commit","checker","scope","overlay","prepared","delta","control"]) &&
		v.version===1 && oid(v.commit) && checker(v.checker,true) && scope(v.scope) &&
		(v.overlay===undefined || record(v.overlay) && only(v.overlay,["revision","paths"]) && oid(v.overlay.revision) && Array.isArray(v.overlay.paths) &&
			paths(v.overlay.paths) && v.overlay.paths.every((p,i,a)=>!i || a[i-1]<p)) &&
		(v.prepared===undefined || hash(v.prepared) && record(v.scope) && v.scope.kind==="component") &&
		(v.delta===undefined || record(v.scope) && v.scope.kind==="goal" && record(v.delta) &&
			only(v.delta,["hash","inline"]) && hash(v.delta.hash) && typeof v.delta.inline==="boolean") &&
		(v.control===undefined || record(v.control) && only(v.control,["commit","checker","example"]) && oid(v.control.commit) &&
			checker(v.control.checker) && (v.control.example==="good" || v.control.example==="bad"));
	}catch{return false;}
}

/** Provenance commits needed only by the source resolver, never implicit transfer heads.
 * @param {Inputs} v */
export function inputCommits(v){
	if(!validInputs(v))fail("invalid_inputs","Unrecognized verification inputs");
	return [v.commit,...(v.overlay?[v.overlay.revision]:[]),...(v.checker.replacement?[v.checker.replacement.revision]:[]),
		...(v.control?[v.control.commit]:[])];
}
/** Identical bytes for signed ledger subjects and standalone replay-carrier identities.
 * Object keys are ordered; arrays keep their original order. @param {unknown} value @returns {string} */
export function canonical(value){
	if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
	if(value && typeof value==="object")return "{"+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)
		.map(([k,v])=>JSON.stringify(k)+":"+canonical(v)).join(",")+"}";
	return JSON.stringify(value);
}
/** Explicit row order and field order keep the evaluator's JSON environment stable even
 * if a recipient reserializes the manifest. @param {Extract<Scope,{kind:"product"}>} scope */
export const checkedOwnership=scope=>Object.fromEntries(scope.outputs.map(({id,directories,files,exclude})=>[id,{directories,files,
	...(exclude && {exclude:{directories:exclude.directories,files:exclude.files}})}]));

/** @param {Scope} scope @param {NodeJS.ProcessEnv} [host] */
export function verificationEnvironment(scope,host={}){
	const env={...host};
	for(const key of ["GRAIN","DIRECTORY","DIRECTORIES","FILES","OUTPUTS","OWNERSHIP","PREPARED_DIR","GOAL_DELTA","GOAL_DELTA_FILE","GOAL_FEEDBACK_FILE"])
		delete env[`FOUNDRY_${key}`];
	if(scope.kind==="component"){
		env.FOUNDRY_GRAIN=scope.grain;env.FOUNDRY_DIRECTORIES=JSON.stringify(scope.directories);
		if(scope.directories.length===1)env.FOUNDRY_DIRECTORY=scope.directories[0];
		if(scope.files.length)env.FOUNDRY_FILES=JSON.stringify(scope.files);
	}else if(scope.kind==="product"){
		env.FOUNDRY_OWNERSHIP=JSON.stringify(checkedOwnership(scope));
		env.FOUNDRY_OUTPUTS=JSON.stringify(Object.fromEntries(scope.outputs.map(({id,directories:d})=>[id,d.length===1?d[0]:d])));
	}
	return env;
}
