import { meta as auditMeta, run as runAudit } from "./audit.mjs";
import { meta as planMeta, run as runPlan } from "./plan.mjs";
import { meta as repairMeta, run as runRepair } from "./repair.mjs";
import { meta as deepResearchMeta, run as runDeepResearch } from "./research.mjs";
import { meta as reviewQueueMeta, run as runReviewQueue } from "./review.mjs";
import { run as runSecurityReview, meta as securityReviewMeta } from "./security.mjs";
import { run as runTriage, meta as triageMeta } from "./triage.mjs";
import { run as runVerify, meta as verifyMeta } from "./verify.mjs";

/** Source names are independent of durable native identities. @type {Readonly<Record<string, string>>} */
export const WORKFLOW_FILES = Object.freeze({
	audit: "audit.mjs",
	"deep-research": "research.mjs",
	plan: "plan.mjs",
	"plan-repair": "repair.mjs",
	"review-queue": "review.mjs",
	"security-review": "security.mjs",
	triage: "triage.mjs",
	verify: "verify.mjs",
});

/** Native Workflow definitions registered by the Foundry control plane. */
export const FOUNDRY_WORKFLOWS = Object.freeze({
	audit: Object.freeze({ meta: auditMeta, run: runAudit }),
	deepResearch: Object.freeze({ meta: deepResearchMeta, run: runDeepResearch }),
	plan: Object.freeze({ meta: planMeta, run: runPlan }),
	repair: Object.freeze({ meta: repairMeta, run: runRepair }),
	reviewQueue: Object.freeze({ meta: reviewQueueMeta, run: runReviewQueue }),
	securityReview: Object.freeze({ meta: securityReviewMeta, run: runSecurityReview }),
	triage: Object.freeze({ meta: triageMeta, run: runTriage }),
	verify: Object.freeze({ meta: verifyMeta, run: runVerify }),
});
