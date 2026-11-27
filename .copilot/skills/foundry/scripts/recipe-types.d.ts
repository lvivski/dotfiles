type Paths={directories:string[];files:string[]};
export type OwnedPaths=Paths & {exclude?:Paths};
export type VerificationScope =
	| {kind:"component";grain:string;directories:string[];files:string[]}
	| {kind:"product";outputs:({id:string} & OwnedPaths)[]}
	| {kind:"goal"};
export interface Checker {path:string;blob:string;mode:"100644"|"100755"}
/** Immutable Git sources and Foundry-controlled inputs, not an execution grant or a verdict. */
export interface VerificationInputs {
	version:1;
	commit:string;
	checker:Checker & {replacement?:{revision:string;before:string}};
	overlay?:{revision:string;paths:string[]};
	scope:VerificationScope;
	prepared?:string; // Fingerprint of the private build tree actually supplied.
	delta?:{hash:string;inline:boolean}; // Private scheduling input is never bundled.
	control?:{commit:string;checker:Checker;example:"good"|"bad"};
}
