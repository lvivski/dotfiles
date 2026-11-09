export type ReviewFixture = {
	repo: string; number: number; title: string; platform: string; url: string;
	me: string; my_teams: string[]; reviewers: { name: string; required?: boolean }[]; codeowners: string;
	files: string[]; diff: string; coverage: string; updatedAt: string; freshness?: import("@github/copilot-sdk").JsonValue;
	assignments: { account: string; reviewer: string; kind: string; reviewerId?: string; required?: boolean }[];
	evidence: {
		version: number;
		source: {
			platform: string; host: string; repository: string; number: number; account: string;
			baseRevision: string; headRevision: string; iteration?: number;
		};
		completeness: { files: boolean; diff: boolean; assignments: boolean };
		failures: import("@github/copilot-sdk").JsonValue[];
	};
};
