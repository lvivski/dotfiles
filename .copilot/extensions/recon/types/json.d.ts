/** JSON contracts for standalone analysis workflows and their projections. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export type JsonObject = { [key: string]: JsonValue };

export type JsonSchema = {
	type?: "null" | "boolean" | "integer" | "number" | "string" | "array" | "object"
	| ("null" | "boolean" | "integer" | "number" | "string" | "array" | "object")[];
	properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema;
	additionalProperties?: boolean; enum?: JsonValue[]; const?: JsonValue; default?: JsonValue;
	anyOf?: JsonSchema[]; oneOf?: JsonSchema[]; allOf?: JsonSchema[];
	minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
	minItems?: number; maxItems?: number; pattern?: string; description?: string;
};
