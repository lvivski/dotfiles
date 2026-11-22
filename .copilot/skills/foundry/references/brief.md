# Prepare a Foundry brief

`/foundry brief` turns a product idea into an agreement about what a user should be able to do and how someone else can tell it works. Foundry's scouts decide what to build next. If asked only for a prompt, give an example. If asked only for a review, report gaps and questions without editing files.

## Interview before writing

For a new or revised brief, use the skill tool to load `grilling` by name. If it isn't available in this session, follow the interview below. Skip the interview for help, review-only requests, and `start`.

Read the conversation and inspect the repo first. For an existing product, trace one real action from its public surface to its result; distinguish what worked, what failed, and what you couldn't observe. Don't quiz the user on facts you can find or assume current code must be kept or replaced. For a new product, start from the promised user experience.

Map the open product decisions and which answers they depend on. If the idea is missing, ask what the user wants to be able to do. Otherwise, make the first interaction a **real clarifying question** about the most consequential open decision, not a proposed brief or “does that sound right?”

Work in rounds: identify the choices that can be made now without guessing an answer to another question. In Copilot, deliver a round via `ask_user`, **one decision per prompt**. State the recommendation so “yes” accepts it, explain the tradeoff, and wait. After each answer, drop questions it settles and keep track of independent choices still open. Ask dependent follow-ups only once their premise is settled. A user's delegation is a decision; an unanswered recommendation is not.

Probe what a convincing demo could get wrong, which references are examples rather than required integrations, and what can wait. Bring contradictions back as concrete choices. For “support calls,” ask: **“Should someone who denies microphone access still be able to join and listen? I recommend yes so they don't miss the meeting.”** If yes, explore what peers should see. If no, explore how the caller can recover instead. Don't ask both follow-ups, or ask the user to design squads and a task graph.

**Read back, then wait.** When every material choice is answered, delegated, or explicitly out of scope, summarize the journey, hard constraints, exclusions, and evidence that would distinguish a pass from a convincing near miss. If everything was already settled, go straight to this step rather than inventing questions. Ask whether it describes the product they want. If corrected, revisit only the affected decisions. One explicit confirmation of this readback is enough to write or revise the brief; it does **not** authorize a commit or start. If the user says “draft it now” before agreement, give a **provisional draft** with unresolved decisions labeled. Don't overwrite a reviewed contract or present that draft as ready to start.

## Write the smallest runnable contract

Reuse existing checks where they fit. Write one `.foundry/<id>.json` using the [version-2 contract example](../../../extensions/foundry/README.md#commit-the-contract). Set `direction` to the whole agreed outcome, `target` to the intended existing local branch (`refs/heads/...`), and omit `grains` and `seed`.

Use just enough disjoint writable `areas` for independent work to start together. A charter says what a squad owns, not what it must build first. Pin charters, shared interfaces, check helpers and evaluators outside those areas. Component checks must work for newly discovered directories, not a list of predicted assignment IDs. Leave `limits.workers` unset unless the user wants a fixed concurrency cap. For unattended work, `limits.assignments` can bound total scout, writer and repair reservations; zero permits baseline checks only. Neither limit counts native helpers or promises a credit ceiling.

If deciding whether to create a writer requires investigating other checkouts, public docs or approved tools, an area squad may name `researchAgent`. `foundry-research` reads source and public docs; name a separately configured, appropriately scoped profile for connectors or disposable probes. Review the profile and permitted sources as part of the committed brief; findings cannot substitute for product checks.

- **`productCheck`:** What must still work on a useful intermediate version? A passing milestone lets the factory assess the combined result; it doesn't end the run.
- **`goalCheck`:** Exercise the promised behavior through the product. Use any supported way to build or drive it. Exit **0** only for the full outcome, **1** for a demonstrated product gap, **2** when required external evidence is unavailable. If a local observation proves one defect while a peer or device is unavailable, report the defect **and** mark the rest unverified. Once that defect is gone, missing evidence is still not a pass.

For example, “add a headless driver and two build scripts” is not a chat failure. “The sender saw *sent*, but after reconnect the recipient got the message twice” is. If there was no second client to observe, don't report a delivery failure. The check may name a real prerequisite without assigning its implementation to a squad.

## Rehearse and hand off

Run the trusted checks on a disposable copy of the target revision, not the user's dirty checkout. If the brief is uncommitted, overlay only its proposed files and label the result a draft preview. If the actual baseline already passes both checks, say so rather than inventing work.

Try a plausible partial product, including a failure or boundary case: it should pass the milestone but fail the goal for a specific reason. For a multi-step journey, simulate fixing **only** that gap: the **same** goal should expose the next observable gap or say what evidence is missing. Fixtures can calibrate a check; they cannot qualify a real product.

Return the brief path, target and tested revision, finish line, what each check actually returned, and any missing evidence. Distinguish a **draft** from a **committed brief**: activation reads `HEAD`, and the target must contain the same contract files. Commit only if authorized, and never include unrelated edits.

Don't implement the product, seed assignments, schedule work, or start workers. If the goal returned 2, name the observation needed before a run can make progress. For a ready brief give the exact short command using its filename stem: `.foundry/catalog.json` becomes `/foundry start catalog`, even if its internal run ID differs. They won't need a new start plan for each milestone.
