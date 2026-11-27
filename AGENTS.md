# Fixing bugs in this repository

Check prevention and recovery separately. A fresh success shows that the bug no longer occurs; it does not show that someone already affected can continue.

If the bug leaves state behind, reproduce that state in a disposable environment, apply the fix, and follow the steps available to the affected user until their original work can continue. A new task is not a substitute. If recovery needs approval or has no safe path, say what remains blocked and why. Do not act on live state to prove recovery.

## Reviewing code changes

Cover new or changed behavior with a test. Observe it fail for the intended reason before the implementation change (red), then pass with the change (green). For a behavior-preserving refactor, keep the same regression controls working before and after; don't manufacture a failure by breaking unrelated code.

Have the independent **Rubber Duck** reviewer inspect the final code and its tests. Address blocking findings and review any resulting changes before handoff. If the reviewer or a required control is unavailable, say so; a self-review or a green suite alone does not satisfy this gate.

For Foundry and its bundled skill, follow the [Foundry contributor instructions](.copilot/extensions/foundry/AGENTS.md), including its [verification requirements](.copilot/extensions/foundry/AGENTS.md#verification).
