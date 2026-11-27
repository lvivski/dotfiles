import { machine, to } from "../machine.mjs";

/** @typedef {import("../mending.mjs").Repair} Repair */
/** @param {string} on @param {Repair["state"]} target @param {string} why @param {...string} when */
const edge=(on,target,why,...when)=>({...to(on,target,why),when});
const hold=edge("hold","held","Keep the original failure and explain what evidence or authority is missing.");
export const mending=machine("test-recovery","diagnosing",{
	diagnosing:[edge("control","draft","The original observer rejected a known-good case at the named assertion.","rejectsGood"),
		edge("control","unobserved","The test accepts known-good behavior, but the actual observation is still missing.","acceptsGood","missing"),
		edge("control","product","The original test accepted the control; investigate the product, not the test.","acceptsGood"),
		edge("unavailable","unobserved","The control could not observe either. Preserve the missing observation and let independent work continue.","missing"),hold],
	draft:[edge("claim","authoring","Claim one tool-less test author on frozen inputs."),hold],
	authoring:[edge("submit","checking","Pin the exact change and check it against the independent controls."),edge("capacity","draft","Queue the author only after confirmed non-admission."),hold],
	checking:[edge("control","review","The repaired observer accepts the good case and rejects the holdout at the named assertion.","discriminates"),hold],
	review:[edge("claim","reviewing","Claim independent Rubber Duck review of the diff and signed controls."),hold],
	reviewing:[edge("endorse","approved","The independent reviewer endorsed the unchanged requirements and exact observed assertion."),edge("capacity","review","Queue the reviewer only after confirmed non-admission."),hold],
	approved:[edge("install","applied","Adopt the reviewed observer pin and assess the original product afresh."),hold],
	product:[],unobserved:[],applied:[],held:[],
},{description:"Distinguishes a broken observer from a product defect and certifies a test-only repair, never a release.",states:{
	diagnosing:"Run the unchanged test against a predeclared good control.",draft:"A demonstrated test defect needs a test-only proposal.",
	authoring:"The exact author call is outstanding.",checking:"Run the proposed test separately on known-good and known-bad inputs.",
	review:"Independent controls passed; semantic review is still required.",reviewing:"Await the bound independent reviewer.",
	approved:"Revalidate the stop and original inputs before recording a new evaluator pin.",applied:"The new test pin needs fresh release evidence.",
	product:"The control did not demonstrate a test defect; continue ordinary product scheduling.",unobserved:"No test defect was established for the missing observation. No implementation failure or retry is inferred.",held:"No automatic change is authorized.",
}});
