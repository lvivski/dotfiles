import { openDatabase } from "./database.mjs";
import { closeAtEntry, historical } from "./historical.mjs";
import { fail } from "./values.mjs";
/** Only entered for a persisted historical attempt. The old runner never executes here.
 * @param {string} cwd @param {string} id @param {string} job */
export function close(cwd,id,job){
	const db=openDatabase(cwd);
	try{db.mutateLocked(id,run=>{
		const e=run.effects.find(e=>e.id===job);
		if(e?.tool!=="bash" || !historical(e))fail("unissued_check","Original historical command changed");
		closeAtEntry(run,e,cwd);
	});}finally{db.close();}
}
