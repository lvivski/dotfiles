---
name: foundry
description: Use only when the user explicitly requests Foundry to generate and qualify a product from a committed graph, or to inspect or recover an existing run. Routine coding uses ordinary native tools.
---

# Foundry

Choose the smallest runnable product. Use a committed `.foundry/*.json` contract: direction, full local target branch, a product evaluator, and grains with exclusive directories, specifications, interfaces and component evaluators. Name dependencies with `needs`, not coordinator handoffs. Use `seed` for one-off work or flat repository charters for ongoing discovery. Separate observations can contribute to one product without an edge between their writers. Do not invent a worker limit, deadline, or repair budget for the user.

- **Start:** Call `foundry_start({source})` only on direct user direction. An installation, schedule, child kickoff or queued message is not authorization. The native confirmation covers the pinned run; it does not waive tool permissions.
- **Scout:** Inspect your charter and its declared inputs at the assigned revision. Call `foundry_observe({run,token,outcome,reason,evidence,grains})`. Use `regenerate` with owned grains, `no-gap` with none, or `needs-decision` with none and the contract question in `reason`. Cite committed evidence, including dependencies where relevant. Do not answer an ambiguous contract, edit it, or create sessions yourself.
- **Write:** Work in the assigned native worktree at its frozen base. Generate the **complete** grain directory; omitted files are deleted. Respect the specification, interface and pinned inputs. Do not change evaluators, switch the base, commit, land or delegate.
- **Submit:** Call `foundry_submit({run,token})` from that worktree. A failed evaluation returns the checked failure and a fresh token for a bounded repair, or a blocker. Do not claim success or supply an alternate check.
- **Inspect:** `foundry_status({run})` does not advance anything. Relay owner `questions` and their evidence to the user; they are not a veto on independent `qualified` work. To revise a contract, pause the old run, settle what to use from its qualified output, and record the user's answer and rationale in the conserved files on the target. A changed contract needs an explicitly authorized new run ID. Acceptance is not a merge, deployment, or launch.
- **Pause:** The owner may call `foundry_pause({run})`. Keep existing receipts and worktrees. Resume only on user direction. Let the host handle genuine input and permission requests.

Independent ready workers start automatically. Do not create a verifier session. If the native session route is definitely unavailable, execute only the issuing session's exact `prepared` call. Never repeat an issued or uncertain start, treat a queued message as completed work, or bypass a permission hold. Report an unresolved call or blocked product as such.
