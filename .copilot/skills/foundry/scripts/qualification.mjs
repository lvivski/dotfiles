// Offline transfer/description only. The caller chooses the trusted record and any separate execution.
import { execFileSync } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, createReadStream, createWriteStream, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as same } from "node:util";
import { entries, env, git, gitArgs, verifyTree } from "./git-files.mjs";
import { carrierEntries, copyPrepared, describeDisclosure, materializePlan, replayDestination } from "./materialize.mjs";
import { checkedOwnership, inputCommits, oid as validOid, validInputs, validName } from "./recipe.mjs";

const cwd=process.cwd(),self=fileURLToPath(import.meta.url);
const refuse=why=>{throw Error(why);};
const oid=id=>validOid(id)?id:refuse("Expected a full object ID");
const command=(root,args,input)=>git(root,args,input,undefined,Infinity,0);
const text=(root,args,input)=>command(root,args,input).toString().trimEnd();
const lines=s=>s?s.split("\n").sort():[];
const idsEqual=(a,b)=>same([...a].sort(),[...b].sort());
const ref=(id,history)=>`refs/foundry/${history?"objects":"replay"}/${oid(id)}`;
const passed=(r,commit)=>r && r.commit===commit && r.exit===0 && typeof r.check==="string" && r.check.length;
function destination(value){
	const out=path.resolve(value),parent=realpathSync(path.dirname(out));
	const name=path.join(parent,path.basename(out)),admin=lines(text(cwd,["rev-parse","--path-format=absolute","--git-dir","--git-common-dir"]));
	if(name.split(path.sep).some(p=>/^\.git[ .]*$/i.test(p)) || admin.some(d=>name===d || name.startsWith(d+path.sep)))
		refuse("Choose a new disposable destination outside Git administration");
	return name;
}
function record(r,history){
	const {product,goal}=r?.receipts??{},v5=r?.format==="foundry-qualification/v5";
	const legacy=r?.ownership!==undefined?4:product?.evaluatorRevision!==undefined?3:goal?.evaluatorRevision!==undefined?2:1;
	if(!v5 && r?.format!==`foundry-qualification/v${legacy}` || !passed(product,r.commit) || !passed(goal,r.commit) ||
		product.check===goal.check || goal.productEvaluatorRevision!==product.evaluatorRevision || !Array.isArray(r.outputs))
		refuse("Expected the owner's exact goal qualification record");
	if(!v5 && !history)refuse("Historical object transfer only: explicitly select --history; this record has no replay recipes");
	const ids=r.outputs.map(o=>o.id),pins=[r.commit,r.target.commit,r.contract.commit],components=product.components;
	for(const id of [r.contract.activation,product.evaluatorRevision,goal.evaluatorRevision])if(id!==undefined)pins.push(oid(id));
	if(new Set(ids).size!==ids.length || ids.some(id=>!validName(id)) ||
		r.ownership!==undefined && (!r.ownership || !idsEqual(ids,Object.keys(r.ownership))) || components!==undefined &&
		(!r.contract.activation || !components || Array.isArray(components) || !idsEqual(ids,Object.keys(components)) || r.outputs.some(o=>components[o.id]?.exit!==0 || components[o.id].check!==o.receipt?.check)))
		refuse("Included owners and joined component observations disagree");
	const all=[];
	function add(role,o,kind,commit,grain){
		if(v5){
			const v=o.inputs;if(!validInputs(v) || !["signed","reconstructed"].includes(o.inputEvidence) || v.control || o.test!==undefined ||
				o.overlay!==undefined || v.commit!==commit || v.checker.path!==o.check || v.scope.kind!==kind || v.scope.grain!==grain ||
				v.overlay?.revision!==o.evaluatorRevision)refuse("Verification inputs disagree with their observation");
			if(!history && !o.disclosure)refuse("Missing verified replay disclosure; obtain fresh owner proof");
			pins.push(...inputCommits(v));
		}else if(o.inputs!==undefined || o.inputEvidence!==undefined || o.disclosure!==undefined)refuse("Cannot downgrade a verification record");
		all.push({role,observation:o});
	}
	for(const o of r.outputs){
		if(!passed(o.receipt,o.commit) || !o.inputs || typeof o.inputs!=="object" || Array.isArray(o.inputs))refuse("Missing component receipt or prerequisite pins");
		pins.push(o.commit,o.base,o.generation,...Object.values(o.inputs));if(o.replaces!==undefined)pins.push(o.replaces);
		add("component:"+o.id,o.receipt,"component",o.commit,o.id);
	}
	if(v5){
		if(!validInputs(product.inputs) || product.inputs.scope.kind!=="product")refuse("Missing checked product scope");
		const owned=checkedOwnership(product.inputs.scope);
		if(!idsEqual(ids,Object.keys(owned)) || r.ownership && !same(r.ownership,owned))refuse("Product scope disagrees with the checked owners");
	}
	if(components){
		for(const id of v5?product.inputs.scope.outputs.map(o=>o.id):ids)add("joined:"+id,components[id],"component",r.commit,id);
		const joined=Object.values(components);
		if(v5 && joined.some(c=>c.inputs.prepared!==joined[0].inputs.prepared || !same(c.disclosure?.preparation,joined[0].disclosure?.preparation)))
			refuse("Joined observations disagree about their shared preparation");
	}
	add("product",product,"product",r.commit);add("goal",goal,"goal",r.commit);
	return {all,pins:[...new Set(pins.map(oid))].sort()};
}
function select(all,name){
	const selected=all.filter(({role})=>name==="all" || name==="release" && !role.startsWith("component:") ||
		name==="product" && role.startsWith("joined:") || name===role);
	if(!selected.length)refuse("Unknown or empty replay selection");
	return selected;
}
async function scratch(format,use){
	const root=realpathSync(mkdtempSync(path.join(tmpdir(),"foundry-transfer-")));
	try{git(root,["init","-q","--template=","--object-format="+format]);return await use(root);}
	finally{rmSync(root,{recursive:true,force:true});}
}
function exactHeads(root,bundle,ids,history){
	const expected=ids.map(id=>`${id} ${ref(id,history)}`);
	if(!idsEqual(lines(text(root,["bundle","list-heads",bundle])),expected))refuse("Bundle heads do not match the exact qualification pins");
}
function checkCommits(root,ids){
	if(text(root,["cat-file","--batch-check=%(objectname) %(objecttype)"],ids.join("\n")+"\n")!==ids.map(id=>`${id} commit`).join("\n"))
		refuse("Missing or non-commit qualification pin");
}
function retain(root,ids,history){
	git(root,["update-ref","--no-deref","--stdin"],ids.map(id=>`create ${ref(id,history)} ${id}\n`).join(""));
}
function bundleFrom(root,file,ids,history){
	const fd=openSync(file,"wx",0o600);
	try{execFileSync("git",gitArgs(root,["bundle","create","-","--stdin"]),{
		env,input:ids.map(id=>ref(id,history)).join("\n")+"\n",stdio:["pipe",fd,"pipe"]});exactHeads(root,file,ids,history);}
	catch(error){rmSync(file,{force:true});throw error;}finally{closeSync(fd);}
}
function snapshots(selected){
	return [...new Set(selected.flatMap(({observation:{disclosure:d}})=>[oid(d.subject.carrier),...(d.preparation?[oid(d.preparation.carrier)]:[])]))].sort();
}
function checkSource(root,all,store){
	for(const {observation:o} of all)if(o.inputs){
		const resolved=describeDisclosure(root,o.inputs,store);
		if(o.disclosure && !same(resolved,o.disclosure))refuse("Owner disclosure disagrees with the checked source paths, bytes or modes");
	}
}
async function pack(file,proof,selection,history){
	const {all,pins}=record(proof,history);
	if(history){
		console.error("Historical object transfer only: original commits and ALL reachable history will be disclosed.");
		if(text(cwd,["rev-parse","--is-shallow-repository"])!=="false")refuse("History export requires a complete repository");
		checkCommits(cwd,pins);checkSource(cwd,all);
	}
	const selected=select(all,selection),ids=history?pins:snapshots(selected);
	return scratch(text(cwd,["rev-parse","--show-object-format"]),async stage=>{
		if(!history){
			const objects=realpathSync(text(cwd,["rev-parse","--path-format=absolute","--git-path","objects"]));
			if(/[\r\n]/.test(objects))refuse("Unrepresentable object store path");
			writeFileSync(path.join(stage,".git","objects","info","alternates"),objects+"\n",{flag:"wx"});
			const stored=new Set();checkSource(cwd,selected,(type,id,bytes)=>{
				if(stored.has(id))return;
				if(text(stage,["hash-object","-w","-t",type,"--stdin"],bytes)!==id)refuse("Carrier hash disagrees with Git");
				stored.add(id);
			});
			retain(stage,ids,false);
		}
		const bundle=path.join(stage,"out.bundle");bundleFrom(history?cwd:stage,bundle,ids,history);
		await audit(bundle,selected,ids,history,verified=>copyFileSync(verified,file,constants.COPYFILE_EXCL));
	});
}
// Inspect the actual regular pack file (index-pack on stdin can leave trailing input unread).
// Allow only a self-contained bundle with precisely the declared headers and object format.
async function audit(file,selected,ids,history,verified){
	const format=text(cwd,["rev-parse","--show-object-format"]);
	await scratch(format,async stage=>{
		const snapshot=path.join(stage,"received.bundle"),source=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
		try{
			if(!fstatSync(source).isFile())refuse("Expected a regular bundle file");
			await pipeline(createReadStream(file,{fd:source,autoClose:false}),createWriteStream(snapshot,{flags:"wx",mode:0o600}));
		}finally{closeSync(source);}
		const heads=ids.map(id=>`${id} ${ref(id,history)}`),cap=`@object-format=${format}`;
		const max=Buffer.byteLength(["# v3 git bundle",cap,...heads,"",""].join("\n")),fd=openSync(snapshot,"r");
		const buffer=Buffer.alloc(max+12);let n=0;
		try{while(n<buffer.length){const size=readSync(fd,buffer,n,buffer.length-n,null);if(!size)break;n+=size;}}finally{closeSync(fd);}
		const end=buffer.indexOf("\n\n");if(end<0)refuse("Bundle headers do not match the exact qualification pins");
		const header=buffer.subarray(0,end).toString().split("\n"),version=header.shift();
		if(version==="# v3 git bundle" && header[0]===cap)header.shift();
		else if(version!=="# v2 git bundle" || format!=="sha1")refuse("Unsupported or foreign bundle format");
		if(!idsEqual(header,heads) || n<end+14 || !buffer.subarray(end+2,end+6).equals(Buffer.from("PACK")))
			refuse("Bundle heads do not match the exact qualification pins");
		const count=buffer.readUInt32BE(end+10),raw=path.join(stage,"received.pack");
		await pipeline(createReadStream(snapshot,{start:end+2}),createWriteStream(raw,{flags:"wx",mode:0o600}));
		const index=oid(text(stage,["index-pack","--strict",raw])),base=path.join(stage,".git","objects","pack","pack-"+index);
		renameSync(raw,base+".pack");renameSync(path.join(stage,"received.idx"),base+".idx");
		checkCommits(stage,ids);retain(stage,ids,history);
		command(stage,["fsck","--full","--strict","--no-reflogs","--no-dangling"]);
		if(history)checkSource(stage,selected);else for(const {observation:o} of selected){
			carrierEntries(stage,o,"subject");if(o.disclosure.preparation)carrierEntries(stage,o,"preparation");
		}
		const actual=lines(text(stage,["cat-file","--batch-all-objects","--batch-check=%(objectname)"]));
		const allowed=lines(text(stage,["rev-list","--objects","--no-object-names","--stdin"],ids.join("\n")+"\n"));
		if(actual.length!==count || !idsEqual(actual,allowed))refuse("Undisclosed object in transferred pack inventory");
		await verified(snapshot);
	});
}
async function adopt(file,proof,selection,history){
	const {all,pins}=record(proof,history),selected=select(all,selection),ids=history?pins:snapshots(selected);
	if(history)console.error("Historical object transfer only: retaining original commits and reachable history.");
	await audit(file,selected,ids,history,snapshot=>{
		command(cwd,["update-ref","--no-deref","--stdin"],ids.map(id=>`verify ${ref(id,history)} ${"0".repeat(id.length)}\n`).join(""));
		command(cwd,["-c","transfer.fsckObjects=true","bundle","unbundle",snapshot]);retain(cwd,ids,history);
	});
}
async function main(){
	const [action,...args]=process.argv.slice(2);
	if(action==="verify-tree" && (args.length===2 || args.length===4 && ["--empty-output","--new-feedback"].includes(args[2]) ||
		args.length===7 && args[2]==="--new-feedback" && args[4]==="--delta")){
		const [id,dir,binding,extra,,hash,file]=args;if(text(cwd,["rev-parse","--verify",ref(id,false)])!==id)refuse("Carrier not retained");
		if(replayDestination(dir)!==dir || realpathSync(dir)!==dir)refuse("The private export root moved or was replaced by a link");
		verifyTree(cwd,dir,entries(cwd,id,true));
		if(binding==="--empty-output" && (realpathSync(extra)!==extra || !lstatSync(extra).isDirectory() || readdirSync(extra).length))
			refuse("Prepare requires its new empty output directory");
		if(binding==="--new-feedback"){
			const index=/^check-(\d+)$/.exec(path.basename(dir));
			if(!index || extra!==path.join(path.dirname(dir),`feedback-${index[1]}`,"feedback.json") || replayDestination(extra)!==extra)
				refuse("Invalid private goal feedback binding");
			if(hash!==undefined){
				if(!/^[0-9a-f]{64}$/.test(hash) || file!==path.join(path.dirname(extra),"delta.json") || realpathSync(file)!==file)
					refuse("Invalid private scheduling binding");
				const st=lstatSync(file);
				if(!st.isFile() || st.nlink!==1 || createHash("sha256").update(readFileSync(file)).digest("hex")!==hash)
					refuse("Private scheduling input changed");
			}
			// Create at the final preflight, not while describing the plan. Never clear an earlier step's file.
			let fd;
			try{fd=openSync(extra,"wx+",0o600);}catch(error){
				if(error.code==="EEXIST")refuse("Goal feedback output already exists; rematerialize in a fresh staging area");
				throw error;
			}
			try{const st=fstatSync(fd);if(!st.isFile() || st.size!==0 || st.nlink!==1 || st.uid!==process.getuid() || (st.mode&0o777)!==0o600)
				refuse("Goal feedback must be a fresh, private, empty regular file");}finally{closeSync(fd);}
		}
	}else if(action==="copy-prepared" && args.length===3){
		const [expected,source,dest]=args;if(!/^[0-9a-f]{64}$/.test(expected) || replayDestination(dest)!==dest || destination(dest)!==dest)refuse("Invalid private prepared copy destination or digest");
		mkdirSync(dest,{mode:0o700});
		try{copyPrepared(cwd,source,dest,expected);}catch(error){rmSync(dest,{recursive:true,force:true});throw error;}
	}else if(action==="materialize" && (args.length===2 || args.length===4 && args[2]==="--delta-file")){
		const [selection,dest,,delta]=args,{all}=record(JSON.parse(readFileSync(0,"utf8")),false);
		const bytes=delta===undefined?undefined:readFileSync(delta);
		if(bytes && !isUtf8(bytes))refuse("Expected exact UTF-8 private scheduling input");
		if(destination(dest)!==path.resolve(dest))refuse("Replay destination may not use an aliased parent");
		console.log(JSON.stringify(await materializePlan(cwd,dest,select(all,selection),self,bytes?.toString("utf8"))));
	}else if(["pack","import"].includes(action)){
		const history=args[0]==="--history";if(history)args.shift();
		if(!args[0] || args.length>(history?1:2))refuse("Expected [--history] BUNDLE [SELECTION]");
		const [file,selection=history?"all":"release"]=args,proof=JSON.parse(readFileSync(0,"utf8"));
		if(action==="pack")await pack(destination(file),proof,selection,history);
		else await adopt(path.resolve(file),proof,selection,history);
		console.log(`${action==="pack"?"Bundled":"Retained"} ${history?"history pins":"parentless replay carriers"}; no branch updated.`);
	}else refuse("Usage: qualification.mjs pack|import [--history] BUNDLE [SELECTION] | materialize SELECTION NEW_DIRECTORY [--delta-file FILE]");
}
if(typeof import.meta.main!=="boolean")throw Error("qualification.mjs needs Node.js 22.18.0 or later in 22.x, or 24.2.0 or later (import.meta.main)");
if(import.meta.main)try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
