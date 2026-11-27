import { machine } from "./machine.mjs";

/** Rules propose a registered operation. Its own verifier, not the matching edge, decides whether it needs consent. */
export const strategy=machine("recovery","select",{
	select:[
		{on:"reference",when:["targeted"],action:"input",description:"Propose the requested bytes after an authorized source supplies them to this output."},
		{on:"reference",when:["approved"],action:"input",description:"Propose the previously approved match on its original pins after a proven non-delivery."},
		{on:"correction",when:["includedProducer","unclaimedSource"],action:"draft",description:"Send a signed adopted stop to its bounded included source without asking the owner to write a patch."},
	],
},{description:"Selects a recovery proposal from observed evidence. Selection never issues work or grants permission.",
	states:{select:"Consider one stopped attempt and its evidence on this wake. Nothing is persisted by selection."}});
