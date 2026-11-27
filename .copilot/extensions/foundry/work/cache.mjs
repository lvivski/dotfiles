import { lstatSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { hostname, release, tmpdir } from "node:os";
import path from "node:path";
import { verifyPreparation } from "./outcomes.mjs";
import { copyPrepared } from "./preparation.mjs";
import { artifactDigest } from "./product.mjs";
import { digest, fail, FoundryError } from "./values.mjs";

/** @typedef {{ledger:string,run:string,group:string,effect:string,prior:{id:string,claim:string}[],
 * sign:(inputs:string,tree:string)=>string,note:(message:string)=>void}} Batch */

/** A serial rollout needs no shared writable index or build lock. Each producer atomically
 * publishes its own disposable slot. Only a prior runner claim for this batch can attest it.
 * @param {string} cwd @param {string} commit @param {NodeJS.ProcessEnv} env @param {Batch} batch */
export function buildCache(cwd,commit,env,batch){
	const home=realpathSync(tmpdir()),inputs=digest(["prepared-v1",batch.ledger,batch.run,batch.group,commit,
		hostname(),process.platform,release(),process.arch,process.execPath,process.version,process.umask(),env]);
	/** @param {string} id */
	const slot=id=>path.join(home,`foundry-build-${digest([id,inputs])}`);
	/** @param {string} message */
	const note=message=>batch.note(`${message} (inputs ${inputs})`);
	return {
		get(){
			for(const {id,claim} of batch.prior){
				const dir=slot(id),stat=lstatSync(dir,{throwIfNoEntry:false});
				if(!stat)continue;
				try{
					if(!stat.isDirectory() || stat.mode&0o077 || process.getuid && stat.uid!==process.getuid() || realpathSync(dir)!==dir)
						fail("unsafe_storage","Expected a private unlinked build cache directory");
					const children=readdirSync(dir,{withFileTypes:true}),entry=children[0];
					const seal=children.length===1 && entry.isDirectory() && /^([0-9a-f]{64})\.([A-Za-z0-9_-]{86})$/.exec(entry.name);
					if(seal && verifyPreparation(claim,inputs,seal[1],seal[2])){
						const source=path.join(dir,entry.name),expected=seal[1];
						if(artifactDigest(cwd,source)===expected){
							note(`reused ${expected} from ${id}`);return {source,expected};
						}
					}
				}catch(error){
					if(error instanceof Error && "code" in error && error.code==="ENOENT")continue;
					if(!(error instanceof FoundryError && ["unsafe_storage","invalid_artifact","unsupported_tree","invalid_path","tree_conflict"].includes(error.code)))throw error;
				}
				note(`rejected invalid cached build from ${id}`);break;
			}
		},
		/** @param {string} source @param {string} expected */
		put(source,expected){
			const stage=mkdtempSync(path.join(home,"foundry-build-stage-"));
			try{
				const name=`${expected}.${batch.sign(inputs,expected)}`;
				copyPrepared(cwd,source,path.join(stage,name),expected);
				renameSync(stage,slot(batch.effect));
			}finally{rmSync(stage,{recursive:true,force:true});}
			note(`built ${expected}`);
		}
	};
}
