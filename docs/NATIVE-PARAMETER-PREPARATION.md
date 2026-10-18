# Native parameter preparation — local candidate

User-authorized 2026-10-17 for the JuanerAI interpret_meaning integration defect.
This is an offline candidate, not a release, service update or Provider Gate.
The immutable 0.5.1 package and all historical UNKNOWN remain unchanged.

## Acceptance

NP-01: expose a neutral prepareToolArguments(parameters, arguments) entry from the
shared SDK. It directly reuses installed Pi validateToolArguments, including its
native clone, normalization and complete schema validation. Return the native
validated object; do not discard it. No copied conversion rules, inference,
tool loop, new model call, retry, schema translator or supplier-specific branch.

NP-02: current trusted schema remains authoritative. For string enum ['1','2'],
numeric 1 may become string '1' through Pi; numeric 3, an unknown/ambiguous source,
extra properties, wrong array cardinality and missing required fields cannot be
admitted. Neither numeric index lookup nor source/sheet/name guessing is added.
The source object and schema are not mutated, including failed attempts.

NP-03: inputs/output use existing JsonObject, not Pi types. Invalid or non-JSON
contracts/arguments, over-limit data and validation errors become INVALID_TOOL
without original exception/cause/argument text. No logging or raw data storage.

NP-04: this pure synchronous capability supplies no authority. The host calls it
inside its existing effect/permission boundary and keeps semantic validation,
one-correction stopping, receipts, accounting and UNKNOWN semantics. Existing
SDK runtime/configuration/purpose/storage contracts and old callers are unchanged.
Returning a prepared object does not mean a business tool executed or succeeded.

## Integration decision

JuanerAI has task/phase-specific schemas and a stable generic native registry.
Replacing that registry with changing schemas would alter immutable task identity
and let native validation errors bypass the host's bounded correction boundary.
Expose Pi's existing operation through the shared Adapter instead; the existing
business dispatcher supplies its exact current schema and uses the returned
object before business execution. The product neither imports Pi directly nor
implements conversion. Enable narrowly for new interpretation calls; legacy
behavior is not silently migrated. Other business tools are out of this repair.

This does not enable constrained sampling. Pi's optional strict sampling and the
MiniMax endpoint's actual strict support are distinct; no unverified strict flag,
dependency upgrade or authenticated API probe is included here.

## Allowed / forbidden and verification

Allowed SDK paths: src/pi-adapter.ts, src/index.ts, package.json/package-lock.json
for the separately identified local candidate, this document and a focused
tests/native-parameter-preparation.test.ts. No changes to Pi dependencies,
existing runtime loops, public persistence, keys, old packages or active services.

Focused test command: node --test tests/native-parameter-preparation.test.ts.
Before implementation establish causal RED at the public SDK entry. Then run
focused GREEN, SDK typecheck/core/build/UI/package checks and an isolated JuanerAI
consumer using the new package without replacing its active installed SDK.
Every check uses synthetic data and fake transports only. Real validation needs
renewed user authorization after offline verification; publication is forbidden.
