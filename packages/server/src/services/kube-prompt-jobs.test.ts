import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSingleContainerPromptWorkerJobSpec,
  buildPromptWorkerJobSpec,
  promptWorkerSecretPaths
} from "./kube-prompt-jobs";

const buildSpec = () =>
  buildPromptWorkerJobSpec({
    namespace: "schizm",
    jobName: "prompt-123",
    promptId: "prompt-123",
    promptAttempt: 2,
    promptRunnerSessionId: "runner-1",
    executorImage: "example.com/schizm-prompt-executor:latest",
    gitHelperImage: "example.com/schizm-git-helper:latest",
    runtimeSecretName: "schizm-runtime-secret"
  });

test("buildPromptWorkerJobSpec applies hardened pod defaults", () => {
  const spec = buildSpec();
  const podSpec = spec.spec.template.spec;

  assert.equal(podSpec.restartPolicy, "Never");
  assert.equal(podSpec.automountServiceAccountToken, false);
  assert.equal(podSpec.securityContext.runAsNonRoot, true);
  assert.equal(podSpec.securityContext.seccompProfile.type, "RuntimeDefault");
});

test("buildPromptWorkerJobSpec isolates secrets by container role", () => {
  const spec = buildSpec();
  const podSpec = spec.spec.template.spec;
  const bootstrap = podSpec.initContainers[0];
  const executor = podSpec.containers[0];
  const publisher = podSpec.containers[1];

  assert.deepEqual(
    bootstrap.volumeMounts.map((mount) => mount.name),
    ["workspace", "runtime", "git-secret"]
  );
  assert.deepEqual(
    executor.volumeMounts.map((mount) => mount.name),
    ["workspace", "runtime", "codex-secret", "database-secret"]
  );
  assert.deepEqual(
    publisher.volumeMounts.map((mount) => mount.name),
    ["workspace", "runtime", "git-secret", "database-secret"]
  );

  assert.ok(
    !executor.volumeMounts.some((mount) => mount.mountPath === promptWorkerSecretPaths.git)
  );
});

test("buildPromptWorkerJobSpec drops privileges for every container", () => {
  const spec = buildSpec();
  const containers = [
    ...spec.spec.template.spec.initContainers,
    ...spec.spec.template.spec.containers
  ];

  for (const container of containers) {
    assert.equal(container.securityContext.runAsNonRoot, true);
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  }
});

test("buildSingleContainerPromptWorkerJobSpec injects runtime env for the worker pod", () => {
  const spec = buildSingleContainerPromptWorkerJobSpec({
    namespace: "schizm",
    jobName: "prompt-123",
    promptId: "prompt-123",
    promptAttempt: 2,
    promptRunnerSessionId: "runner-1",
    executorImage: "example.com/schizm-prompt-executor:latest",
    gitHelperImage: "example.com/schizm-git-helper:latest",
    runtimeSecretName: "schizm-runtime-secret"
  });
  const container = spec.spec.template.spec.containers[0];
  const envNames = container.env.map((entry) => entry.name);

  assert.equal(spec.spec.template.spec.initContainers, undefined);
  assert.equal(container.name, "codex-executor");
  assert.ok(envNames.includes("DOCUMENT_STORE_DIR"));
  assert.ok(envNames.includes("PROMPT_WORKSPACE_DIR"));
  assert.ok(envNames.includes("PROMPT_RUNTIME_DIR"));
  assert.ok(envNames.includes("HOME"));
  assert.ok(envNames.includes("CODEX_HOME"));
  assert.ok(envNames.includes("WORKER_POD_NAME"));
  assert.ok(envNames.includes("WORKER_NODE_NAME"));
  assert.equal(container.envFrom[0]?.secretRef?.name, "schizm-runtime-secret");
});
