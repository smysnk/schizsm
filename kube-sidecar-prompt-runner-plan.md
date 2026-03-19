# Kubernetes Prompt Worker Plan

This plan describes how to move all prompt execution out of the long-lived API pod and into ephemeral Kubernetes worker pods.

The goal is to keep the API deployment as the control plane and run each prompt inside its own isolated pod with its own clone, Codex session, Git operations, and lifecycle.

## Assumption

This document assumes that "launched sidecar pods" means:

- a new ephemeral pod is launched for prompt execution
- that pod is owned by a Kubernetes `Job`
- the API pod is not the execution environment

This is intentionally not a literal "sidecar container attached to the API deployment", because that would:

- couple prompt execution to API pod restarts
- make concurrency and cleanup harder
- make per-prompt isolation weaker
- keep Codex, Git, SSH, and document-store state mixed into the API pod

So the recommended implementation is:

- API pod: queue coordinator and UI/API host
- worker pod: one prompt execution

## Security Goals

The Kubernetes worker design should also satisfy these security constraints:

1. the main prompt execution container is a specialized hardened image with only the binaries it needs
2. the main prompt execution container never runs as root
3. the main prompt execution container has:
   - `allowPrivilegeEscalation: false`
   - all Linux capabilities dropped
   - `readOnlyRootFilesystem: true`
   - `seccompProfile: RuntimeDefault`
4. the worker pod does not receive a Kubernetes API token unless a specific container truly needs it
5. secrets are never baked into the image
6. secrets are mounted only into the container that needs them
7. after Codex launches, the Codex execution container no longer has secret files or secret env vars available on disk or in its environment
8. Git credentials are isolated from the Codex execution container

## Security Assumption

The requirement "it will not have any secrets in the container after the Codex process launches" is interpreted as:

- the Codex execution container may briefly receive the minimum auth needed to start Codex
- once Codex is running, secret files are deleted from that container's writable runtime area
- secret environment variables are unset before the long-running execution phase continues
- SSH keys used for clone and push are never mounted into the Codex execution container in the first place

This still allows Codex itself to keep whatever token material it has already loaded in its own memory, because otherwise it would not be able to talk to its backend.

## Goals

The Kubernetes worker design should:

1. run every prompt in an isolated pod
2. keep the API deployment free of Codex execution responsibility
3. preserve the current single-commit, runner-owned final Git flow
4. preserve audit timing injection and audit sync
5. make prompt logs and job state visible in prompt history
6. support clean retries by creating a new worker pod per attempt
7. keep the document store and Codex credentials scoped to worker pods

## Non-Goals

This first design is not trying to:

- run multiple prompts concurrently against the same document-store branch
- eliminate the current queue model
- redesign the prompt contract in `program.md`
- replace Fleet or the existing deployment model for `web` and `api`

## Current Constraints

Today, prompt execution is still tied to the API process:

- [prompt-runner.ts](/Users/josh/play/schizm/packages/server/src/services/prompt-runner.ts)
- [env.ts](/Users/josh/play/schizm/packages/server/src/config/env.ts)
- [docker-entrypoint.sh](/Users/josh/play/schizm/docker/docker-entrypoint.sh)
- [container-bootstrap.sh](/Users/josh/play/schizm/docker/container-bootstrap.sh)

Current behavior:

1. the API process polls Postgres for queued prompts
2. it claims a prompt
3. it prepares local execution state
4. it runs Codex locally
5. it appends timing to `audit.md`
6. it creates one final commit
7. it pushes the document-store repo
8. it syncs audit data back into Postgres

This means the API pod currently needs:

- Git
- SSH setup
- Codex auth
- document-store clone/bootstrap logic
- enough CPU and memory for prompt execution

That is what this plan removes.

## Target Architecture

### Control Plane

The API deployment remains responsible for:

- prompt creation
- prompt claiming
- worker Job creation
- worker Job observation
- publishing prompt/workspace events
- exposing prompt history and logs over GraphQL

### Execution Plane

The worker pod should be split into narrowly scoped containers:

1. `repo-bootstrap` init container
   - minimal Git/SSH image
   - mounts the SSH key
   - clones or resets the document-store repo into a shared workspace
   - exits before Codex starts
2. `codex-executor` main container
   - specialized hardened image
   - contains only the prompt runtime, Codex CLI, Node runtime, and CA certificates
   - does not contain Git or SSH tooling
   - receives only Codex auth material
   - deletes its auth file and unsets auth env vars after Codex starts
3. `repo-publisher` sidecar container
   - minimal Git/SSH image
   - waits for the executor to finish
   - creates the one final commit
   - pushes the configured branch
   - exits after publishing or failure

This split keeps the most sensitive combinations separated:

- Codex does not run in the same container that holds SSH keys
- Git push credentials do not need to remain present in the executor
- the main execution image can be much smaller and more locked down

### Persistence Boundary

The worker pod should treat Postgres as the source of truth for prompt state.

That means:

- prompt status lives in `prompts`
- richer attempt metadata should live in either `prompts.metadata` or a new executions table
- logs/artifacts that must survive pod deletion must be copied into durable storage before exit

## Recommended End-To-End Flow

### 1. Prompt Queueing

Unchanged:

- user submits prompt
- row is created in `prompts` with `status='queued'`

### 2. Prompt Dispatch

The API runner becomes a dispatcher instead of an in-process executor.

It should:

1. acquire the existing Postgres advisory lease
2. claim the next queued prompt
3. create a prompt execution record
4. create a Kubernetes Job for that prompt
5. store the Job name, namespace, and intended worker image in prompt metadata
6. release control back to the polling loop

At this point the API is no longer doing the prompt work itself.

### 3. Repo Bootstrap

The init container starts first and:

1. mounts the SSH key from a memory-backed secret volume
2. configures `~/.ssh/id_ed25519`
3. clones or resets `DOCUMENT_STORE_GIT_URL` into a shared workspace volume
4. configures repo author identity
5. exits

At that point, the SSH key is never exposed to the Codex execution container.

### 4. Codex Execution

The main executor container starts and:

1. loads the prompt by explicit prompt ID
2. mounts a memory-backed auth file for Codex only
3. launches Codex against the shared document-store workspace
4. removes its auth file and clears related env vars after Codex has started
5. parses structured output
6. validates canvas state
7. appends timing into the just-written audit entry
8. writes a publish-intent artifact for the publisher sidecar
9. syncs interim audit/result state to Postgres

### 5. Final Commit And Push

The publisher sidecar then:

1. waits for the executor success sentinel
2. performs the one final commit
3. pushes the configured branch
4. writes the final commit SHA and push result to a shared status artifact

### 6. Completion

On success:

- prompt status becomes `completed`
- execution record stores final commit SHA, queue wait time, processing time, worker Job name, pod name, image, and completion time

On failure:

- prompt status becomes `failed`
- execution record stores stage, error, exit code, pod/job identifiers, and recent logs

### 7. Cleanup

The Job should use:

- `ttlSecondsAfterFinished`

This keeps debugging possible for a short period while allowing automatic cleanup later.

The shared workspace and memory-backed secret volumes are destroyed with the pod.

## Key Design Decision: Keep Single-Writer Semantics First

Even though Kubernetes makes concurrency easier, the document store still has a single branch and single-writer Git workflow.

So the first implementation should preserve:

- only one active prompt execution at a time per document-store branch

That means:

- keep the current advisory lease
- dispatch at most one live worker per branch
- do not attempt parallel prompt merges in phase 1

Later, if desired, we can add:

- per-branch execution queues
- branch-per-prompt fan-out with merge queues

## Hardened Image Strategy

The prompt worker should stop using the general-purpose API image for execution.

### Recommended Images

1. `schizm-prompt-executor`
   - base: distroless or another minimal runtime image
   - includes:
     - Node runtime
     - compiled worker runtime
     - Codex CLI
     - CA certificates
   - excludes:
     - package managers
     - compilers
     - shells unless absolutely required
     - Git
     - SSH
     - curl, wget, and other general-purpose debug tools
2. `schizm-git-helper`
   - minimal image containing only:
     - Git
     - OpenSSH client
     - CA certificates
   - used by:
     - `repo-bootstrap` init container
     - `repo-publisher` sidecar

### Container Security Context

Every worker container should use an explicit security context:

- `runAsNonRoot: true`
- `runAsUser` and `runAsGroup` set to a fixed unprivileged UID/GID
- `fsGroup` only if the shared workspace requires it
- `readOnlyRootFilesystem: true`
- `allowPrivilegeEscalation: false`
- `capabilities.drop: ["ALL"]`
- `seccompProfile.type: RuntimeDefault`

The worker pod should also set:

- `automountServiceAccountToken: false`

unless we later add a strong reason for in-pod Kubernetes API calls.

## Secret Handling Model

### Secret Mount Rules

Secrets should be mounted only where needed:

- SSH private key:
  - mounted only in `repo-bootstrap`
  - mounted only in `repo-publisher`
  - never mounted in `codex-executor`
- Codex auth:
  - mounted only in `codex-executor`
- database credentials:
  - mounted only in containers that need to update prompt state

### Secret Storage Form

All runtime secrets should be exposed through:

- projected Kubernetes secrets
- mounted onto `emptyDir` volumes with `medium: Memory` where practical

Do not:

- write secrets into the image
- write secrets into persistent workspace volumes
- leave secrets in normal disk-backed temp directories

### Secret Lifetime

The executor container should:

1. copy Codex auth into an in-memory runtime path
2. launch Codex
3. immediately remove the auth file
4. unset `OPENAI_API_KEY`, `CODEX_AUTH_JSON_BASE64`, and any related variables in its process supervisor

That gives the executor a zero-secret steady state after launch, even though Codex itself may retain auth in memory internally.

## Network And Pod Policy

Worker pods should be constrained by network policy.

Recommended egress allowlist:

- Postgres
- Git remote host
- Codex/OpenAI endpoints
- DNS

Recommended deny posture:

- deny all other egress by default

This is especially important once worker pods have Git and Codex capabilities.

## Required Data Model Changes

The current `prompts` table can keep the high-level status, but worker-pod execution needs attempt-level tracking.

### Recommended New Table

Add a `prompt_executions` table:

```text
id UUID PK
prompt_id UUID FK -> prompts(id)
attempt INTEGER
status TEXT
execution_mode TEXT
job_name TEXT
pod_name TEXT
namespace TEXT
image TEXT
worker_node TEXT
started_at TIMESTAMPTZ
finished_at TIMESTAMPTZ
exit_code INTEGER
error_message TEXT
metadata JSONB
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

This table should capture:

- Kubernetes identity
- attempt number
- worker lifecycle timestamps
- final exit details
- durable references to stdout/stderr snippets or artifacts

### Prompt Metadata Additions

Also store lightweight worker info in `prompts.metadata`, for UI convenience:

- `worker.jobName`
- `worker.podName`
- `worker.namespace`
- `worker.image`
- `worker.phase`
- `worker.attempt`
- `worker.logsPreview`

## Required Eventing Change

Today prompt workspace updates are published in-process through:

- [prompt-workspace-events.ts](/Users/josh/play/schizm/packages/server/src/services/prompt-workspace-events.ts)

That is not enough once workers run in separate pods.

### Recommendation

Move prompt workspace events to Postgres `LISTEN/NOTIFY`.

That gives us:

- worker pod can publish prompt status events
- API pod can subscribe and rebroadcast to GraphQL subscriptions
- prompt history stays live without polling

### Result

The event path becomes:

worker pod -> Postgres NOTIFY -> API listener -> GraphQL subscription -> web UI

## Kubernetes Resources To Add

### 1. Service Account And RBAC

The API deployment needs permission to:

- create Jobs
- get/list/watch/delete Jobs
- get/list/watch Pods
- read Pod logs

Recommended resources:

- `ServiceAccount`
- `Role`
- `RoleBinding`

Scope them to the `schizm` namespace.

The worker Job itself should not need these permissions if it only talks to Postgres.

### 2. Worker Job Template

The worker should run as a `Job` with:

- `restartPolicy: Never`
- `backoffLimit: 0` or `1`
- `ttlSecondsAfterFinished`
- explicit CPU/memory requests and limits
- disk-backed `emptyDir` for the repo workspace
- memory-backed `emptyDir` for transient secrets
- `automountServiceAccountToken: false`
- pod security context enforcing non-root execution
- a network policy selecting worker pods

### 3. Worker Container Commands

The new pod layout should include:

- init container:
  - `repo-bootstrap`
- main container:
  - `codex-executor`
- sidecar:
  - `repo-publisher`

The executor entrypoint should run a server-side command such as:

- `node packages/server/dist/worker/index.js --prompt-id ...`

The publisher should run a dedicated publish command such as:

- `node packages/server/dist/worker/publish.js --prompt-id ...`

### 4. Runtime Secret Strategy

The worker pod should receive only the secrets needed by each container:

- API pod:
  - dispatcher credentials
  - database credentials
- `repo-bootstrap` / `repo-publisher`:
  - `DOCUMENT_STORE_SSH_PRIVATE_KEY_BASE64`
  - `DOCUMENT_STORE_GIT_URL`
  - `DOCUMENT_STORE_GIT_BRANCH`
  - author name/email
- `codex-executor`:
  - `CODEX_AUTH_JSON_BASE64` or equivalent startup auth
  - database credentials

The cleanest first step is:

- keep one Kubernetes Secret object
- project only the relevant keys into each container

Later, split this into:

- API secret
- Git helper secret
- Codex executor secret

## Suggested Code Structure Changes

### 1. Split The Runner

Refactor [prompt-runner.ts](/Users/josh/play/schizm/packages/server/src/services/prompt-runner.ts) into two responsibilities:

- `PromptDispatcher`
  - claim prompt
  - create execution row
  - create Job
  - monitor Job
- `PromptWorkerRuntime`
  - do actual Codex/Git/audit work

### 2. Add A Kubernetes Job Service

Create a new service, for example:

```text
packages/server/src/services/kube-prompt-jobs.ts
```

It should own:

- Job name generation
- Job spec construction
- create/get/delete/watch helpers
- log retrieval helpers

### 3. Add A Worker Entrypoint

Create a new command entrypoint, for example:

```text
packages/server/src/worker/index.ts
```

It should:

1. load env
2. validate `PROMPT_ID`
3. run bootstrap steps
4. execute the prompt runtime
5. exit with a meaningful code

### 4. Replace Shell-Centric Bootstrap For Workers

The hardened worker path should minimize shell dependence.

Recommended direction:

- keep the current shell bootstrap for legacy/local flows initially
- build the Kubernetes worker path around compiled Node entrypoints and narrowly scoped helper commands
- avoid depending on a full shell environment inside the hardened executor image

The new split should be:

- `web`: Next.js
- `api`: GraphQL server and dispatcher
- `worker-executor`: prompt execution only
- `worker-publisher`: final commit and push only

## Job Payload Design

The API should create Jobs with explicit prompt context via env:

- `PROMPT_ID`
- `PROMPT_ATTEMPT`
- `PROMPT_RUNNER_EXECUTION_MODE=kube-worker`
- `PROMPT_DISPATCHED_BY_SESSION`
- `PROMPT_JOB_NAME`

The worker should not infer which prompt to run by polling.

It should receive exactly one prompt ID and process only that prompt.

The Job spec should also carry:

- a dedicated pod label set for network policy and observability
- explicit image digest references instead of mutable tags where practical
- a prompt attempt number
- a per-prompt workspace path

## Logging And Artifacts

Prompt history should show more than just status.

### Recommended Durable Artifacts

Store these on each execution:

- worker Job name
- pod name
- repo URL
- repo branch
- git operations
- final commit SHA
- queue wait duration
- processing duration
- stdout tail
- stderr tail

### Storage Strategy

For phase 1, store:

- small excerpts in Postgres metadata
- full logs in pod logs only

For phase 2, consider:

- object storage for full logs and artifacts

## UI Changes

Prompt history should expose worker details directly:

- Job name
- pod name
- namespace
- image
- node
- retry attempt
- queue wait time
- processing time
- recent pod logs

This fits naturally into the detailed prompt panel you already have.

The security-sensitive UI additions should also show:

- executor image name
- publisher image name
- whether the run used hardened worker mode
- whether the run used isolated secret handling

## Testing Plan

### Unit Tests

Add tests for:

- Job spec generation
- env mapping into worker Jobs
- prompt execution table writes
- Job name determinism
- event publication via Postgres notifications
- security context generation
- per-container secret projection
- `automountServiceAccountToken: false`
- non-root pod settings
- image allowlist assertions

### Integration Tests

Add tests for:

- dispatcher creates Job for queued prompt
- worker processes a prompt by explicit prompt ID
- worker success updates prompt + execution row
- worker failure updates prompt + execution row
- API can read pod logs into metadata
- executor container cannot see SSH key mount
- executor removes Codex auth file after launch
- publisher can commit/push without exposing Git credentials to the executor

### End-To-End Tests

Use a local Kubernetes cluster in CI later if needed:

- `kind` or `k3d`
- Postgres test container
- fake Codex binary
- one queued prompt -> one Job -> completed prompt

Add security-focused e2e checks for:

- worker pod runs as non-root
- worker pod has no service account token mount
- executor container does not have Git/SSH binaries if that is the intended hardening target
- secret files are absent from the executor filesystem after Codex launch

## Rollout Plan

## Phase 1: Model And Interfaces

Deliver:

- `prompt_executions` migration
- worker status metadata shape
- Job service interface
- worker entrypoint contract
- Postgres notification event design
- hardened worker pod contract
- per-container secret boundary contract

Files likely touched:

- [migrations.ts](/Users/josh/play/schizm/packages/server/src/db/migrations.ts)
- [prompt-repository.ts](/Users/josh/play/schizm/packages/server/src/repositories/prompt-repository.ts)
- new `kube-prompt-jobs.ts`
- new `packages/server/src/worker/index.ts`

## Phase 2: Worker Runtime Extraction

Deliver:

- extract current execution path out of `PromptRunner`
- make it callable by worker entrypoint
- keep exact current behavior for audit timing, single commit, and push verification
- split execution responsibilities into:
  - executor runtime
  - publisher runtime

Files likely touched:

- [prompt-runner.ts](/Users/josh/play/schizm/packages/server/src/services/prompt-runner.ts)
- [container-document-repo.ts](/Users/josh/play/schizm/packages/server/src/services/container-document-repo.ts)
- [prompt-audit-timing.ts](/Users/josh/play/schizm/packages/server/src/services/prompt-audit-timing.ts)

## Phase 3: Kubernetes Dispatch

Deliver:

- API dispatches Jobs instead of running prompts locally
- worker pod processes one prompt and exits
- prompt state updates flow through Postgres notifications

Files likely touched:

- new `kube-prompt-jobs.ts`
- [prompt-runner.ts](/Users/josh/play/schizm/packages/server/src/services/prompt-runner.ts)
- [prompt-workspace-events.ts](/Users/josh/play/schizm/packages/server/src/services/prompt-workspace-events.ts)

## Phase 4: Fleet And RBAC

Deliver:

- ServiceAccount, Role, RoleBinding for API dispatcher
- worker Job configuration values
- image/command wiring for `worker`
- namespace-scoped permissions for Job and Pod operations
- hardened pod security context
- projected secret mounts by container
- network policy for worker pods

Files likely touched:

- [fleet/schizm/values.yaml](/Users/josh/play/schizm/fleet/schizm/values.yaml)
- [fleet/schizm/templates/api-deployment.yaml](/Users/josh/play/schizm/fleet/schizm/templates/api-deployment.yaml)
- new Fleet RBAC templates
- possibly new ConfigMap values for worker defaults

## Phase 5: Logs, UI, And Retry Semantics

Deliver:

- prompt detail shows Job/pod/log context
- retries create new execution attempts
- pod log tail is captured into prompt metadata

Files likely touched:

- [idea-canvas.tsx](/Users/josh/play/schizm/packages/web/src/components/canvas/idea-canvas.tsx)
- [prompt-terminal.ts](/Users/josh/play/schizm/packages/web/src/components/canvas/prompt-terminal.ts)
- GraphQL schema/resolvers

## Phase 6: Remove In-Process Execution

Deliver:

- API no longer runs Codex locally
- API entrypoint no longer clones the document store on startup
- prompt processing is worker-only in production

Files likely touched:

- [docker-entrypoint.sh](/Users/josh/play/schizm/docker/docker-entrypoint.sh)
- [container-bootstrap.sh](/Users/josh/play/schizm/docker/container-bootstrap.sh)
- [env.ts](/Users/josh/play/schizm/packages/server/src/config/env.ts)

## Key Risks

### 1. Cross-Pod Event Propagation

The current in-memory event bus will not work once workers run in separate pods.

This is the biggest structural change and should be treated as first-class work, not a side detail.

### 2. Job Orphaning

If the API pod restarts after creating a Job, the worker may continue correctly but the dispatcher must be able to reconcile existing live Jobs on startup.

### 3. Secret Scope

The worker needs Git/SSH/Codex secrets. This increases the importance of keeping those secrets out of the API pod where possible.

It also increases the importance of not co-locating all secrets in the same execution container.

### 4. Log Durability

If logs stay only in pod logs and the Job is garbage-collected too quickly, debugging gets much harder.

### 5. Branch Serialization

Even with worker pods, concurrent writers to the same branch will still conflict. The first rollout should keep serialized execution.

### 6. Over-Hardening Too Early

If we remove shell tools, Git, or debugging aids from the executor image before the worker split is complete, rollout will become harder to debug.

So the hardening should be staged:

1. move execution into worker pods
2. split clone/publish away from Codex execution
3. then aggressively slim the executor image

## Recommended First Step

The best first implementation step is:

1. add `prompt_executions`
2. extract the current execution path into a worker-runtime module
3. split that worker runtime into:
   - executor runtime
   - publisher runtime
4. add a `worker` command path that can process a single explicit prompt ID locally
5. keep it runnable locally before introducing Kubernetes Job creation

That sequence lets you prove:

- worker boot
- prompt execution
- audit timing
- final commit/push
- prompt state persistence
- secret separation between executor and publisher

before adding the Kubernetes dispatcher layer.

## Success Criteria

This migration is successful when:

- API pods no longer execute Codex directly
- each prompt gets a distinct Kubernetes Job and pod
- prompt history shows worker Job/pod context and timings
- audit timing still lands in `audit.md`
- exactly one final commit is still created per prompt
- failures are debuggable from prompt history plus pod logs
- the executor container runs non-root and without privilege escalation
- the executor container does not retain secret files or auth env vars after Codex launch
- SSH/Git credentials are not present in the executor container
