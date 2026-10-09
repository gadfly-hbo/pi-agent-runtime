# SDK 0.3.2: explicit host checkpoints (candidate)

Authorized by the JuanerAI Change005 v1.2 user on 2026-10-09. This is a bounded candidate, not a release or a product adoption claim. Canonical MacBook application/readback and independent review remain outstanding. Pi dependencies stay pinned to 0.86.1.

## Public contract

`runAgent` accepts optional `checkpoint`, `saveCheckpoint`, and `shouldYield`. Neutral checkpoints contain version, stable business taskId, declared purpose, authorized conversation messages, state and an optional in-flight tool ID. The host owns durable transactions, content access and egress permission, product Run/Attempt identity matching, historical budget reconciliation, and the explicit resume decision. Refresh, restart, mode switching and discovery never trigger this API automatically.

Model output is acknowledged before tools are admitted. A `tool-admitted` checkpoint is acknowledged before each real tool effect; the actual result is acknowledged before a dependent model request. A failed acknowledgement returns STATE_FAILED. This critical callback cannot be replaced by observational onEvent. Authorized content belongs in the host's protected storage, not ordinary SDK metadata audit.

After a business tool completes, shouldYield may return true. Once the waiting checkpoint is acknowledged, the result is waiting/BUSINESS_WAIT, not cancellation or business completion. A later explicit call can supply that checkpoint and new user text. The native Pi Agent receives the conversation. The same BudgetStore, task identity, immutable purpose plan and limits remain in force; checkpoints never import, erase or reset consumption.

For an unadmitted pending batch, the SDK reconstructs the saved assistant output through the native Pi loop. Acknowledged tool results are supplied as context without another effect or resource charge. Remaining tools still pass authorization, admission, accounting, audit and durable acknowledgement. Prompt must be empty when resuming a pending batch, so a new intent is never silently discarded. A tool-admitted checkpoint indicates a potentially unknown effect and is rejected until the host reconciles it; clearing the marker is not permission to replay an unknown effect.

An empty prompt with a completed checkpoint reads the saved answer through current publication authorization without new model/tool requests. It does not prove analysis verification, product acceptance, or zero historical consumption.

## Compatibility and exclusions

Omitting the new fields preserves existing APIs. Checkpointed runs currently require sequential tool execution: explicit parallel plus checkpoint hooks is rejected, never silently reconfigured. Ordinary parallel runs are unchanged. No automatic recovery, session discovery, compaction, sandbox, mutable purpose plan, budget reset or parallel runtime is introduced. The host retains external resource and unknown-effect responsibilities.
