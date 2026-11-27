/** A release decision permits work; it does not itself reserve a writer or verify a join.
 * `scoped` requires checkpoint inputs. `changed` permits integration, not a retry of
 * the same missing goal observation on unchanged bytes.
 * @satisfies {Record<string,{writers:"eligible"|"repair"|"none", scoped:boolean, join:"product"|"changed"|"none", discover:boolean}>} */
const modes = {
	open:                      {writers:"eligible", scoped:false, join:"product", discover:true},
	checkpoint:                {writers:"eligible", scoped:true,  join:"none",    discover:true},
	"repaired-checkpoint":     {writers:"eligible", scoped:true,  join:"changed", discover:true},
	"join-only":               {writers:"none",     scoped:false, join:"product", discover:false},
	"changed-join":            {writers:"none",     scoped:false, join:"changed", discover:false},
	"ownership-repairs":       {writers:"repair",   scoped:false, join:"none",    discover:false},
	"ownership-checkpoint-repairs":{writers:"repair",scoped:true, join:"none",    discover:false},
	closed:                    {writers:"none",     scoped:false, join:"none",    discover:false},
};

/** @typedef {keyof typeof modes} Admission */
/** @param {Admission} mode */
export function admissionPolicy(mode) {
	if (!Object.hasOwn(modes, mode)) throw new Error(`Unhandled work admission: ${mode}`);
	return modes[mode];
}
