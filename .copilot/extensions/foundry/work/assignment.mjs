import { chart, select, to } from "./chart.mjs";

/** @template {string} E @template {string} S @template {string} A @param {E} on @param {S} target @param {A} action @param {string} description @param {...string} when */
const outcome=(on,target,action,description,...when)=>({...to(on,target,description),action,when});
/** @template {string} E @param {E} on */
const repair=on=>[outcome(on,"blocked","attestation","Keep the failed attestation: its grant forbids changing the bytes.","attestation"),
	outcome(on,"blocked","exhausted","Preserve the candidate and failure when the repair allowance is spent.","exhausted"),
	outcome(on,"waiting","repair","Queue the permitted repair; the queue itself is not a write grant.")];
const stop=to("stop","blocked","Record why this assignment cannot proceed under its current grant."),
	staff=to("staff","writing","Reserve the writer's scoped generation on its checked inputs."),
	submit=to("submit","checking","Send the submitted candidate to its component evaluator."),
	integrate=to("integrate","qualified","Record this output's inclusion in the checked product, not a release verdict."),
	paired=to("paired-pass","published","Publish the exact output supported by the fresh component observation."),
	request=to("request","waiting","Put the requested output in the queue for input and writer admission.");
const settled=[integrate,...repair("repair"),request];
export const assignment=chart("assignment","idle",{
	idle:[request],
	waiting:[staff,stop],
	writing:[submit,stop],
	checking:[outcome("component","published","publish","Make the passing candidate available for integration.","passed"),
		outcome("component","blocked","incomplete","Keep the incomplete observation without treating it as a verdict.","incomplete"),
		outcome("component","blocked","unfunded","Stop because the run has no assignment budget for repair.","unfunded"),...repair("component"),stop,paired],
	published:[integrate,to("repeat","repeated","Retain the checked output without treating an unchanged product as progress."),...repair("repair"),stop,staff,paired],
	qualified:settled,repeated:settled,
	blocked:[staff,to("recheck","checking","Observe the retained candidate under an authorized check."),...repair("repair"),paired,
		to("deliver","qualified","Record inclusion after the separately approved delivery checks pass."),stop],
},{description:"Tracks one scoped output from request through checking and integration.",states:{
	idle:"The output is known but has not been requested.",
	waiting:"The output or its repair has been requested. Inputs, a reservation or permission may still be missing.",
	writing:"A writer reservation owns this generation. Its native binding is a separate fact.",
	checking:"The candidate is frozen for its component evaluation; the writer cannot keep editing that submission.",
	published:"The component check supports this candidate. It is not yet an integrated product.",
	qualified:"This output was included in a checked product. The whole run has a separate release decision.",
	repeated:"This checked output would reproduce an already assessed product.",
	blocked:"A recorded stop prevents this assignment from continuing on its current terms.",
}});

/** @param {import("./model.js").Node} node @param {Exclude<(typeof assignment.states)[keyof typeof assignment.states][number]["on"],"component"|"repair">} signal */
export function assign(node,signal) {
	node.state=select(assignment,node.state,signal).target;
}
