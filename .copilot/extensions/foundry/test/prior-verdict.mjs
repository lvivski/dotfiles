// Model the pre-discriminator observer *before* the exclusive signer sees its
// result. Never edit the authenticated receipt or substitute a stored command.
import { registerHooks } from "node:module";
registerHooks({load(url,context,next){
	if(!url.endsWith("/work/verdict.mjs"))return next(url,context);
	const original=JSON.stringify(url+"?original-observer");
	return {format:"module",shortCircuit:true,source:`export * from ${original};import {interrupted as observe} from ${original};
		export function interrupted(...args){const {failure,...fields}=observe(...args);return fields;}`};
}});
