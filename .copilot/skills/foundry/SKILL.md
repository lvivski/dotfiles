---
name: foundry
description: Use only when the user explicitly requests Foundry to generate and qualify a product from a committed graph, or to inspect or recover an existing run. Routine coding uses ordinary native tools.
---

# Foundry

Keep the user's full product brief as the `direction`. Split the **work**, not the finish line. Commit a `.foundry/*.json` contract with a local target branch, `productCheck` for milestone invariants, and a distinct `goalCheck` that exercises the promised end-user outcomes together. Check that the final evaluator rejects a plausible unfinished product. If the goal is ambiguous, resolve it with the operator before starting; workers cannot redefine it.

Give each grain an exclusive directory, specification, interface, component check and owning squad. Use `needs` only for consumed outputs. In a goal run, omit `seed`: the squads choose the work on an unmet baseline and on every checked milestone. Use a seeded contract **without** `goalCheck` only when the user explicitly wants a one-off.

- **Start:** Call `foundry_start({source})` only on direct user direction. An installation, schedule, child kickoff or queued message is not authorization. The native confirmation covers the pinned run; it does not waive tool permissions.
- **Scout:** Inspect your charter and its declared inputs at the assigned revision. Call `foundry_observe({run,token,outcome,reason,evidence,grains})`. Use `regenerate` with owned grains, `no-gap` with none, or `needs-decision` with none and the contract question in `reason`. Cite committed evidence, including dependencies where relevant. Do not answer an ambiguous contract, edit it, or create sessions yourself.
- **Write:** Work in the assigned native worktree at its frozen base. Generate the **complete** grain directory; omitted files are deleted. Respect the specification, interface and pinned inputs. Do not change evaluators, switch the base, commit, land or delegate.
- **Submit:** Call `foundry_submit({run,token})` from that worktree. A failed evaluation returns the checked failure and a fresh token for a bounded repair, or a blocker. Do not claim success or supply an alternate check.
- **Inspect:** `foundry_status({run})` does not advance anything. In a goal run, `checkpoint` is progress. `qualified` stays null until both committed checks pass on the same exact commit; the target branch stays unchanged. An unmet goal starts the next discovery round within the existing authorization. Relay concrete blockers and contract questions, not a completion claim. To revise a contract, pause the old run and record the user's answer and rationale in the conserved files on the target. A changed contract needs an explicitly authorized new run ID.
- **Pause:** The owner may call `foundry_pause({run})`. If the final goal evaluator exited 2, report the missing external observation. Once it is supplied, a paused run can recheck on an explicitly authorized `foundry_start({source})`. Keep existing receipts and worktrees; a denied or uncertain call is not a reason to retry. Let the host handle genuine input and permission requests.

All ready assignments start automatically in parallel. Set `limits.workers` only when the operator wants a cap; only capped runs offer **Keep** or **Increase** when more work is ready. If a native session route is definitely unavailable, execute the exact `prepared` call once in its issuing session. Never repeat an issued or uncertain start, treat a queued message as completed work, or bypass a permission hold. Report an unresolved call or blocked product as such.
