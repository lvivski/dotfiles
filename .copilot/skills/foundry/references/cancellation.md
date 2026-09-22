# Cancellation

Read before cancelling a plan. Cancellation is a two-phase protocol; requesting it does not prove
that external work has stopped.

1. Call `foundry_cancel` once with a stable request ID, reason, and user identity.
2. Archive or stop every attached App child session listed by the cancellation snapshot. Only
   archive sessions this coordinator created. Record `no-session-created` only for an attempt that
   never attached a session.
3. Call `foundry_cancel_verification_run` with the current revision and the same cancellation request
   ID. Use its `verificationDisposition`; never supply an arbitrary Factory run ID.
4. Capture a fresh exhaustive App session inventory after those termination attempts.
5. Call `foundry_finalize_cancellation` with exact attempt dispositions, the returned verification
   disposition when present, and the fresh inventory.

An absent, ambiguous, unreadable, paused, or still-active session/Factory state blocks finalization.
Use `finalizationOverride` only after the user explicitly accepts the uncertainty and supplies the
attributed reason.
