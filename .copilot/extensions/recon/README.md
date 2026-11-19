# Recon

Evidence gathering, investigation, risk review, and triage through standalone native
`audit`, `deep-research`, `review-queue`, `security-review`, and `triage`
workflows, separated from Foundry's coordination/evidence runtime. Registered names,
arguments, outputs, verification, recovery, and explicit skill activation gates are unchanged.
They work without a Foundry goal or work store.

The extension owns research time-review dialogs and its workflow lifecycle. Findings stay in
the native report. A research opinion does not become a Foundry acceptance requirement.

`sync` mirrors this directory independently. For scoped development, mirror this extension
without running the full dotfiles operation, then reload extensions. The host supplies the SDK.
Run the behavioral tests in `test/`; Foundry's SDK checker accepts this directory as its optional
fifth argument to check both source trees with the same installed declarations.
