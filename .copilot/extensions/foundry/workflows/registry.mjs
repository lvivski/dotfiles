import { meta as auditMeta, run as runAudit } from "./audit.mjs";
import { meta as deepResearchMeta, run as runDeepResearch } from "./research.mjs";
import { meta as reviewQueueMeta, run as runReviewQueue } from "./review.mjs";
import { run as runSecurityReview, meta as securityReviewMeta } from "./security.mjs";
import { run as runTriage, meta as triageMeta } from "./triage.mjs";

/** Source names are independent of durable native identities. @type {Readonly<Record<string, string>>} */
export const WORKFLOW_FILES = Object.freeze({
	audit: "audit.mjs",
	"deep-research": "research.mjs",
	"review-queue": "review.mjs",
	"security-review": "security.mjs",
	triage: "triage.mjs",
});

/** Standalone analysis workflows; task execution needs none of them. */
export function createFoundryWorkflows() {
return Object.freeze({
	audit: Object.freeze({ meta: auditMeta, run: runAudit }),
	deepResearch: Object.freeze({ meta: deepResearchMeta, run: runDeepResearch }),
	reviewQueue: Object.freeze({ meta: reviewQueueMeta, run: runReviewQueue }),
	securityReview: Object.freeze({ meta: securityReviewMeta, run: runSecurityReview }),
	triage: Object.freeze({ meta: triageMeta, run: runTriage }),
});
}
export const FOUNDRY_WORKFLOWS = createFoundryWorkflows();
