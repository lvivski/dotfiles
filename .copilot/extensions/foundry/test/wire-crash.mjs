import { DatabaseSync } from "node:sqlite";
const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec,written=new WeakSet();
DatabaseSync.prototype.prepare=function(/** @type {string} */ sql){
	const statement=prepare.call(this,sql);
	if(sql.startsWith("UPDATE runs SET document=")){
		const run=statement.run.bind(statement);
		Object.defineProperty(statement,"run",{value:(/** @type {import("node:sqlite").SQLInputValue[]} */ ...values)=>{
			const result=run(...values);if(result.changes)written.add(this);return result;
		}});
	}
	return statement;
};
DatabaseSync.prototype.exec=function(/** @type {string} */ sql){
	if(sql!=="COMMIT" || !written.has(this))return exec.call(this,sql);
	if(process.env.CRASH_SIDE==="before")process.exit(86);
	exec.call(this,sql);process.exit(87);
};
