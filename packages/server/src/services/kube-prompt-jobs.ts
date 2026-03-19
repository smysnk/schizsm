import {
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  type V1Container,
  type V1EnvVar,
  type V1EnvFromSource,
  type V1Job,
  type V1Volume,
  type V1VolumeMount
} from "@kubernetes/client-node";

export const promptWorkerContainerRoles = [
  "repo-bootstrap",
  "codex-executor",
  "repo-publisher"
] as const;

export type PromptWorkerContainerRole = (typeof promptWorkerContainerRoles)[number];

export const promptWorkerSecretKinds = ["git", "codex", "database"] as const;
export type PromptWorkerSecretKind = (typeof promptWorkerSecretKinds)[number];

export type PromptWorkerSecretBoundary = {
  role: PromptWorkerContainerRole;
  allowedSecrets: PromptWorkerSecretKind[];
};

export const promptWorkerSecretBoundaries: PromptWorkerSecretBoundary[] = [
  { role: "repo-bootstrap", allowedSecrets: ["git"] },
  { role: "codex-executor", allowedSecrets: ["codex", "database"] },
  { role: "repo-publisher", allowedSecrets: ["git", "database"] }
];

export type PromptWorkerRuntimeLayout = "single-container" | "isolated";

export type KubePromptWorkerImages = {
  executor: string;
  gitHelper: string;
  pullPolicy?: "Always" | "IfNotPresent" | "Never";
};

export type KubePromptWorkerJobInput = {
  namespace: string;
  jobName: string;
  promptId: string;
  promptAttempt: number;
  promptRunnerSessionId: string;
  executorImage: string;
  gitHelperImage: string;
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  runtimeSecretName: string;
  runtimeLayout?: PromptWorkerRuntimeLayout;
  workspaceEmptyDirSizeLimit?: string;
  secretMemorySizeLimit?: string;
  ttlSecondsAfterFinished?: number;
  backoffLimit?: number;
  cpuRequest?: string;
  cpuLimit?: string;
  memoryRequest?: string;
  memoryLimit?: string;
  workspaceDir?: string;
};

type KubeSecurityContext = {
  allowPrivilegeEscalation: boolean;
  readOnlyRootFilesystem: boolean;
  runAsNonRoot: boolean;
  runAsUser: number;
  runAsGroup: number;
  capabilities: { drop: string[] };
  seccompProfile: { type: "RuntimeDefault" };
};

export type KubePromptJobService = {
  buildJobSpec: (input: KubePromptWorkerJobInput) => V1Job;
  createJob: (input: KubePromptWorkerJobInput) => Promise<{ name: string; namespace: string }>;
  getJob: (namespace: string, name: string) => Promise<unknown>;
  listPromptPods: (namespace: string, jobName: string) => Promise<unknown[]>;
  getPodLogs: (namespace: string, podName: string, containerName?: string) => Promise<string>;
  deleteJob: (namespace: string, name: string) => Promise<void>;
};

export const promptWorkerWorkspaceDir = "/workspace/document-store";
export const promptWorkerRuntimeDir = "/run/schizm";
export const promptWorkerSecretPaths = {
  git: `${promptWorkerRuntimeDir}/secrets/git`,
  codex: `${promptWorkerRuntimeDir}/secrets/codex`,
  database: `${promptWorkerRuntimeDir}/secrets/database`
} as const;

const defaultSecurityContext = (): KubeSecurityContext => ({
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  runAsNonRoot: true,
  runAsUser: 10001,
  runAsGroup: 10001,
  capabilities: { drop: ["ALL"] },
  seccompProfile: { type: "RuntimeDefault" }
});

const createCommonEnv = (input: KubePromptWorkerJobInput): V1EnvVar[] => [
  { name: "PROMPT_ID", value: input.promptId },
  { name: "PROMPT_ATTEMPT", value: String(input.promptAttempt) },
  { name: "PROMPT_JOB_NAME", value: input.jobName },
  { name: "PROMPT_DISPATCHED_BY_SESSION", value: input.promptRunnerSessionId },
  { name: "PROMPT_RUNNER_EXECUTION_MODE", value: "kube-worker" },
  { name: "DOCUMENT_STORE_DIR", value: input.workspaceDir || promptWorkerWorkspaceDir },
  { name: "PROMPT_WORKSPACE_DIR", value: input.workspaceDir || promptWorkerWorkspaceDir },
  { name: "PROMPT_RUNTIME_DIR", value: promptWorkerRuntimeDir },
  { name: "HOME", value: `${promptWorkerRuntimeDir}/home` },
  { name: "CODEX_HOME", value: `${promptWorkerRuntimeDir}/home/.codex` },
  { name: "PROMPT_WORKER_IMAGE", value: input.executorImage },
  {
    name: "WORKER_POD_NAME",
    valueFrom: {
      fieldRef: {
        fieldPath: "metadata.name"
      }
    }
  },
  {
    name: "WORKER_POD_NAMESPACE",
    valueFrom: {
      fieldRef: {
        fieldPath: "metadata.namespace"
      }
    }
  },
  {
    name: "WORKER_NODE_NAME",
    valueFrom: {
      fieldRef: {
        fieldPath: "spec.nodeName"
      }
    }
  }
];

const createCommonResources = (input: KubePromptWorkerJobInput) => ({
  requests: {
    cpu: input.cpuRequest || "250m",
    memory: input.memoryRequest || "512Mi"
  },
  limits: {
    cpu: input.cpuLimit || "1000m",
    memory: input.memoryLimit || "1Gi"
  }
});

const createCommonVolumes = (input: KubePromptWorkerJobInput): V1Volume[] => [
  {
    name: "workspace",
    emptyDir: {
      sizeLimit: input.workspaceEmptyDirSizeLimit || "4Gi"
    }
  },
  {
    name: "runtime",
    emptyDir: {
      medium: "Memory",
      sizeLimit: input.secretMemorySizeLimit || "64Mi"
    }
  },
  {
    name: "git-secret",
    secret: {
      secretName: input.runtimeSecretName,
      items: [
        { key: "DOCUMENT_STORE_SSH_PRIVATE_KEY_BASE64", path: "id_ed25519.b64" },
        { key: "DOCUMENT_STORE_GIT_URL", path: "repo-url" },
        { key: "DOCUMENT_STORE_GIT_BRANCH", path: "repo-branch" },
        { key: "DOCUMENT_STORE_GIT_AUTHOR_NAME", path: "author-name" },
        { key: "DOCUMENT_STORE_GIT_AUTHOR_EMAIL", path: "author-email" }
      ]
    }
  },
  {
    name: "codex-secret",
    secret: {
      secretName: input.runtimeSecretName,
      items: [
        { key: "CODEX_AUTH_JSON_BASE64", path: "auth.json.b64" },
        { key: "OPENAI_API_KEY", path: "openai-api-key" }
      ]
    }
  },
  {
    name: "database-secret",
    secret: {
      secretName: input.runtimeSecretName,
      items: [
        { key: "DATABASE_URL", path: "database-url" },
        { key: "DB_SSL", path: "db-ssl" }
      ]
    }
  }
];

const volumeMount = (
  name: string,
  mountPath: string,
  readOnly = false
): V1VolumeMount => ({
  name,
  mountPath,
  readOnly
});

const buildPodTemplateBase = (input: KubePromptWorkerJobInput) => ({
  metadata: {
    labels: {
      "app.kubernetes.io/name": "schizm",
      "app.kubernetes.io/component": "prompt-worker",
      "schizm.dev/prompt-id": input.promptId,
      "schizm.dev/prompt-attempt": String(input.promptAttempt)
    }
  },
  spec: {
    restartPolicy: "Never" as const,
    automountServiceAccountToken: false,
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      fsGroup: 10001,
      seccompProfile: { type: "RuntimeDefault" as const }
    },
    volumes: createCommonVolumes(input)
  }
});

export const buildPromptWorkerJobSpec = (input: KubePromptWorkerJobInput): V1Job => {
  const imagePullPolicy = input.imagePullPolicy || "IfNotPresent";
  const resources = createCommonResources(input);
  const templateBase = buildPodTemplateBase(input);

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: input.jobName,
      namespace: input.namespace,
      labels: templateBase.metadata.labels
    },
    spec: {
      ttlSecondsAfterFinished: input.ttlSecondsAfterFinished ?? 900,
      backoffLimit: input.backoffLimit ?? 0,
      template: {
        ...templateBase,
        spec: {
          ...templateBase.spec,
          initContainers: [
            {
              name: "repo-bootstrap",
              image: input.gitHelperImage,
              imagePullPolicy,
              command: ["node", "packages/server/dist/worker/index.js", "--role=repo-bootstrap"],
              env: createCommonEnv(input),
              volumeMounts: [
                volumeMount("workspace", input.workspaceDir || promptWorkerWorkspaceDir),
                volumeMount("runtime", promptWorkerRuntimeDir),
                volumeMount("git-secret", promptWorkerSecretPaths.git, true)
              ],
              securityContext: defaultSecurityContext(),
              resources
            }
          ],
          containers: [
            {
              name: "codex-executor",
              image: input.executorImage,
              imagePullPolicy,
              command: ["node", "packages/server/dist/worker/index.js", "--role=codex-executor"],
              env: createCommonEnv(input),
              volumeMounts: [
                volumeMount("workspace", input.workspaceDir || promptWorkerWorkspaceDir),
                volumeMount("runtime", promptWorkerRuntimeDir),
                volumeMount("codex-secret", promptWorkerSecretPaths.codex, true),
                volumeMount("database-secret", promptWorkerSecretPaths.database, true)
              ],
              securityContext: defaultSecurityContext(),
              resources
            },
            {
              name: "repo-publisher",
              image: input.gitHelperImage,
              imagePullPolicy,
              command: ["node", "packages/server/dist/worker/index.js", "--role=repo-publisher"],
              env: createCommonEnv(input),
              volumeMounts: [
                volumeMount("workspace", input.workspaceDir || promptWorkerWorkspaceDir),
                volumeMount("runtime", promptWorkerRuntimeDir),
                volumeMount("git-secret", promptWorkerSecretPaths.git, true),
                volumeMount("database-secret", promptWorkerSecretPaths.database, true)
              ],
              securityContext: defaultSecurityContext(),
              resources
            }
          ]
        }
      }
    }
  };
};

export const buildSingleContainerPromptWorkerJobSpec = (
  input: KubePromptWorkerJobInput
): V1Job => {
  const imagePullPolicy = input.imagePullPolicy || "IfNotPresent";
  const resources = createCommonResources(input);
  const templateBase = buildPodTemplateBase(input);
  const envFrom: V1EnvFromSource[] = [
    {
      secretRef: {
        name: input.runtimeSecretName
      }
    }
  ];

  const container: V1Container = {
    name: "codex-executor",
    image: input.executorImage,
    imagePullPolicy,
    command: ["node", "packages/server/dist/worker/index.js", "--role=codex-executor"],
    env: createCommonEnv(input),
    envFrom,
    volumeMounts: [
      volumeMount("workspace", input.workspaceDir || promptWorkerWorkspaceDir),
      volumeMount("runtime", promptWorkerRuntimeDir),
      volumeMount("git-secret", promptWorkerSecretPaths.git, true),
      volumeMount("codex-secret", promptWorkerSecretPaths.codex, true),
      volumeMount("database-secret", promptWorkerSecretPaths.database, true)
    ],
    securityContext: defaultSecurityContext(),
    resources
  };

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: input.jobName,
      namespace: input.namespace,
      labels: templateBase.metadata.labels
    },
    spec: {
      ttlSecondsAfterFinished: input.ttlSecondsAfterFinished ?? 900,
      backoffLimit: input.backoffLimit ?? 0,
      template: {
        ...templateBase,
        spec: {
          ...templateBase.spec,
          containers: [container]
        }
      }
    }
  };
};

const createKubernetesClients = () => {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromDefault();

  return {
    batchApi: kubeConfig.makeApiClient(BatchV1Api),
    coreApi: kubeConfig.makeApiClient(CoreV1Api)
  };
};

export const createKubePromptJobService = ({
  runtimeLayout = "single-container"
}: {
  runtimeLayout?: PromptWorkerRuntimeLayout;
} = {}): KubePromptJobService => {
  const clients = createKubernetesClients();
  const buildJobSpec = (input: KubePromptWorkerJobInput) =>
    runtimeLayout === "isolated"
      ? buildPromptWorkerJobSpec(input)
      : buildSingleContainerPromptWorkerJobSpec(input);

  return {
    buildJobSpec,
    createJob: async (input) => {
      const body = buildJobSpec(input);
      await clients.batchApi.createNamespacedJob(input.namespace, body);
      return { name: input.jobName, namespace: input.namespace };
    },
    getJob: async (namespace, name) =>
      clients.batchApi.readNamespacedJob(name, namespace),
    listPromptPods: async (namespace, jobName) => {
      const pods = await clients.coreApi.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `job-name=${jobName}`
      );

      return pods.items;
    },
    getPodLogs: async (namespace, podName, containerName) => {
      const logs = await clients.coreApi.readNamespacedPodLog(
        podName,
        namespace,
        containerName
      );

      return typeof logs === "string" ? logs : String(logs ?? "");
    },
    deleteJob: async (namespace, name) => {
      await clients.batchApi.deleteNamespacedJob(
        name,
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "Background",
        undefined
      );
    }
  };
};
