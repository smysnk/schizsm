import { expect, test, type Page } from "@playwright/test";

const promptText =
  "I keep noticing that the thoughts I avoid all day only come back when I'm washing dishes at night, like the running water gives them permission to surface.";
const longWrapPromptText =
  "sometimesathoughtarrivesasasingleunbrokenthreadthatstillneedstowrapcleanlyinsidetheterminalwithoutspillingpastthelcdedge".repeat(
    6
  );
const firstPlaceholderQuestion = "What are you thinking about?";

type TerminalStyleSample = {
  userColor: string;
  userAnimationName: string;
  bodyAnimationName: string;
  screenAnimationName: string;
};

async function collectTerminalStyleSamples(page: Page): Promise<TerminalStyleSample[]> {
  return page.evaluate(async () => {
    const terminal = document.querySelector("[data-testid='prompt-terminal']");
    const body = terminal?.querySelector(".retro-lcd__body");
    const screen = terminal?.querySelector(".retro-lcd__screen");

    if (!(terminal instanceof HTMLElement) || !(body instanceof HTMLElement) || !(screen instanceof HTMLElement)) {
      throw new Error("Prompt terminal elements were not found.");
    }

    const readUserCell = () =>
      Array.from(terminal.querySelectorAll(".retro-lcd__cell")).find((cell) => {
        const text = cell.textContent?.replace(/\u00a0/gu, "").trim() || "";
        return text.length > 0 && !cell.classList.contains("retro-lcd__cell--faint");
      });

    const readSample = () => {
      const userCell = readUserCell();
      const userStyle = window.getComputedStyle(userCell || body);
      return {
        userColor: userStyle.color,
        userAnimationName: userStyle.animationName,
        bodyAnimationName: window.getComputedStyle(body).animationName,
        screenAnimationName: window.getComputedStyle(screen).animationName
      };
    };

    const samples = [readSample()];

    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      samples.push(readSample());
    }

    return samples;
  });
}

type TerminalBounds = {
  terminalRect: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
  userRectCount: number;
  visibleViolationCount: number;
  visibleViolations: Array<{
    entryIndex: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
  }>;
};

async function collectTerminalBounds(page: Page): Promise<TerminalBounds> {
  return page.getByTestId("prompt-terminal").evaluate((terminal) => {
    const terminalRect = terminal.getBoundingClientRect();
    const lines = Array.from(terminal.querySelectorAll(".retro-lcd__line"));

    const getRangeRects = (element: Element | null) => {
      if (!element) {
        return [];
      }

      const range = document.createRange();
      range.selectNodeContents(element);

      return Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => ({
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        }));
    };

    const userRects = lines.flatMap((line) => getRangeRects(line));
    const visibleViolations: Array<{
      entryIndex: number;
      left: number;
      right: number;
      top: number;
      bottom: number;
    }> = [];

    lines.forEach((line, entryIndex) => {
      for (const rect of getRangeRects(line)) {
        const intersectsViewport =
          rect.bottom > terminalRect.top && rect.top < terminalRect.bottom;

        if (!intersectsViewport) {
          continue;
        }

        if (
          rect.left < terminalRect.left - 1 ||
          rect.right > terminalRect.right + 1 ||
          rect.top < terminalRect.top - 1 ||
          rect.bottom > terminalRect.bottom + 1
        ) {
          visibleViolations.push({
            entryIndex,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom
          });
        }
      }
    });

    return {
      terminalRect: {
        left: terminalRect.left,
        right: terminalRect.right,
        top: terminalRect.top,
        bottom: terminalRect.bottom
      },
      userRectCount: userRects.length,
      visibleViolationCount: visibleViolations.length,
      visibleViolations
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const state = {
      prompts: [] as Array<Record<string, unknown>>,
      promptRunnerState: {
        paused: false,
        inFlight: false,
        activePromptId: null,
        activePromptStatus: null,
        pollMs: 5000,
        automationBranch: "codex/mindmap",
        worktreeRoot: ".codex-workdirs",
        runnerSessionId: "runner-e2e"
      },
      subscriptions: new Map<string, (payload: Record<string, unknown>) => void>(),
      nextId: 0
    };

    const now = () => new Date().toISOString();
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

    const buildWorkspacePayload = (reason: string, promptId: string | null = null) => ({
      emittedAt: now(),
      reason,
      promptId,
      promptRunnerState: clone(state.promptRunnerState),
      prompts: clone(state.prompts)
    });

    const emitWorkspace = (reason: string, promptId: string | null = null) => {
      const payload = buildWorkspacePayload(reason, promptId);

      for (const send of state.subscriptions.values()) {
        send(payload);
      }
    };

    const pushTransition = (
      prompt: Record<string, unknown>,
      status:
        | "scanning"
        | "deciding"
        | "writing"
        | "updating_canvas"
        | "auditing"
        | "syncing_audit"
        | "committing"
        | "pushing",
      reason: string
    ) => {
      const metadata = (prompt.metadata as Record<string, unknown>) || {};
      const runner = (metadata.runner as Record<string, unknown>) || {};
      const statusTransitions = Array.isArray(runner.statusTransitions)
        ? [...(runner.statusTransitions as Array<Record<string, unknown>>)]
        : [];

      statusTransitions.push({
        status,
        at: now(),
        reason
      });

      prompt.metadata = {
        ...metadata,
        runner: {
          ...runner,
          statusTransitions
        }
      };
    };

    const updatePromptStatus = (
      promptId: string,
      status:
        | "scanning"
        | "deciding"
        | "writing"
        | "updating_canvas"
        | "auditing"
        | "syncing_audit"
        | "committing"
        | "pushing"
        | "completed",
      reason: string
    ) => {
      const prompt = state.prompts.find((entry) => entry.id === promptId);

      if (!prompt) {
        return;
      }

      if (status === "completed") {
        prompt.status = "completed";
        prompt.finishedAt = now();
        prompt.updatedAt = now();
        prompt.audit = {
          branch: "codex/mindmap",
          sha: "14322c797065fa6ec19970b02ba6fd56c56140e7"
        };
        state.promptRunnerState.inFlight = false;
        state.promptRunnerState.activePromptId = null;
        state.promptRunnerState.activePromptStatus = null;
        emitWorkspace("Prompt updated to completed.", promptId);
        return;
      }

      prompt.status = status;
      prompt.startedAt = prompt.startedAt || now();
      prompt.updatedAt = now();
      pushTransition(prompt, status, reason);
      state.promptRunnerState.inFlight = true;
      state.promptRunnerState.activePromptId = promptId;
      state.promptRunnerState.activePromptStatus = status;
      emitWorkspace(`Prompt updated to ${status}.`, promptId);
    };

    const scheduleLifecycle = (promptId: string) => {
      const steps: Array<{
        delayMs: number;
        status:
          | "scanning"
          | "deciding"
          | "writing"
          | "updating_canvas"
          | "auditing"
          | "syncing_audit"
          | "committing"
          | "pushing"
          | "completed";
        reason: string;
      }> = [
        {
          delayMs: 220,
          status: "scanning",
          reason: "Preparing isolated git worktree."
        },
        {
          delayMs: 520,
          status: "deciding",
          reason: "Assembling Codex instruction payload."
        },
        {
          delayMs: 880,
          status: "writing",
          reason: "Launching Codex CLI."
        },
        {
          delayMs: 5200,
          status: "updating_canvas",
          reason: "Validating Obsidian canvas updates."
        },
        {
          delayMs: 5620,
          status: "auditing",
          reason: "Parsing Codex output."
        },
        {
          delayMs: 5980,
          status: "syncing_audit",
          reason: "Syncing audit.md back into the prompt row."
        },
        {
          delayMs: 6340,
          status: "committing",
          reason: "Promoting prompt branch onto codex/mindmap."
        },
        {
          delayMs: 6700,
          status: "pushing",
          reason: "Pushing codex/mindmap to origin."
        },
        {
          delayMs: 7060,
          status: "completed",
          reason: "Run complete."
        }
      ];

      for (const step of steps) {
        window.setTimeout(() => {
          updatePromptStatus(promptId, step.status, step.reason);
        }, step.delayMs);
      }
    };

    const jsonResponse = (payload: Record<string, unknown>) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();

      if (!url.includes("/graphql")) {
        return originalFetch(input, init);
      }

      const rawBody =
        typeof init?.body === "string"
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString()
            : "";
      const body = rawBody ? JSON.parse(rawBody) : {};
      const operationName = body.operationName || "";

      if (operationName === "Prompts") {
        return jsonResponse({
          data: {
            promptRunnerState: state.promptRunnerState,
            prompts: state.prompts
          }
        });
      }

      if (operationName === "CreatePrompt") {
        const createdAt = now();
        const promptId = `e2e-${String(++state.nextId).padStart(4, "0")}`;
        const prompt = {
          id: promptId,
          content: body.variables?.input?.content || "",
          status: "queued",
          metadata: {},
          audit: {},
          startedAt: null,
          finishedAt: null,
          errorMessage: null,
          createdAt,
          updatedAt: createdAt
        };

        state.prompts = [prompt];
        emitWorkspace("Prompt created and queued.", promptId);
        scheduleLifecycle(promptId);

        return jsonResponse({
          data: {
            createPrompt: clone(prompt)
          }
        });
      }

      if (operationName === "PausePromptRunner") {
        state.promptRunnerState.paused = true;
        emitWorkspace("Prompt runner paused by operator.");
        return jsonResponse({
          data: {
            pausePromptRunner: clone(state.promptRunnerState)
          }
        });
      }

      if (operationName === "ResumePromptRunner") {
        state.promptRunnerState.paused = false;
        emitWorkspace("Prompt runner resumed by operator.");
        return jsonResponse({
          data: {
            resumePromptRunner: clone(state.promptRunnerState)
          }
        });
      }

      return jsonResponse({ data: {} });
    };

    const NativeWebSocket = window.WebSocket;

    class MockGraphqlSocket extends EventTarget {
      url: string;
      readyState: number;
      onopen: ((event: Event) => void) | null;
      onmessage: ((event: MessageEvent<string>) => void) | null;
      onclose: ((event: CloseEvent) => void) | null;
      onerror: ((event: Event) => void) | null;

      constructor(url: string) {
        super();
        this.url = url;
        this.readyState = 0;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;

        window.setTimeout(() => {
          this.readyState = 1;
          const openEvent = new Event("open");
          this.dispatchEvent(openEvent);
          this.onopen?.(openEvent);
        }, 0);
      }

      send(rawMessage: string) {
        const message = JSON.parse(rawMessage);

        if (message.type === "connection_init") {
          window.setTimeout(() => {
            this.dispatchJson({ type: "connection_ack" });
          }, 0);
          return;
        }

        if (message.type === "subscribe") {
          const subscriptionId = message.id;
          state.subscriptions.set(subscriptionId, (payload) => {
            this.dispatchJson({
              id: subscriptionId,
              type: "next",
              payload: {
                data: {
                  promptWorkspace: payload
                }
              }
            });
          });
          this.dispatchJson({
            id: subscriptionId,
            type: "next",
            payload: {
              data: {
                promptWorkspace: buildWorkspacePayload("Initial workspace snapshot.")
              }
            }
          });
          return;
        }

        if (message.type === "complete") {
          state.subscriptions.delete(message.id);
        }
      }

      close() {
        this.readyState = 3;
        const closeEvent = new CloseEvent("close", { code: 1000 });
        this.dispatchEvent(closeEvent);
        this.onclose?.(closeEvent);
      }

      dispatchJson(payload: Record<string, unknown>) {
        const messageEvent = new MessageEvent("message", {
          data: JSON.stringify(payload)
        });
        this.dispatchEvent(messageEvent);
        this.onmessage?.(messageEvent);
      }
    }

    const GraphqlAwareWebSocket = function (
      this: unknown,
      url: string | URL,
      protocols?: string | string[]
    ) {
      const normalizedUrl = typeof url === "string" ? url : url.toString();

      if (normalizedUrl.includes("/graphql")) {
        return new MockGraphqlSocket(normalizedUrl);
      }

      return new NativeWebSocket(url, protocols);
    } as unknown as typeof WebSocket;

    GraphqlAwareWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    GraphqlAwareWebSocket.OPEN = NativeWebSocket.OPEN;
    GraphqlAwareWebSocket.CLOSING = NativeWebSocket.CLOSING;
    GraphqlAwareWebSocket.CLOSED = NativeWebSocket.CLOSED;
    GraphqlAwareWebSocket.prototype = NativeWebSocket.prototype;

    window.WebSocket = GraphqlAwareWebSocket;
  });
});

test("types the live placeholder as a clean prefix sequence with no simulated typos", async ({
  page
}) => {
  await page.goto("/");

  const textarea = page.getByLabel("Retro LCD input");
  await expect(textarea).toBeVisible();

  const samples = await page.evaluate(async () => {
    const screen = document.querySelector("[data-testid='prompt-zen-form'] .retro-lcd__body");

    if (!(screen instanceof HTMLElement)) {
      throw new Error("Prompt LCD body was not found.");
    }

    const values: string[] = [];

    for (let index = 0; index < 8; index += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      values.push(
        Array.from(screen.querySelectorAll(".retro-lcd__line"))
          .map((line) => line.textContent?.replace(/\u00a0/gu, " ").trim() || "")
          .join("")
          .trim()
      );
    }

    return values;
  });

  const nonEmptySamples = samples.filter((value) => value.length > 0);

  expect(nonEmptySamples.length).toBeGreaterThan(0);

  let previousLength = 0;
  for (const sample of nonEmptySamples) {
    expect(firstPlaceholderQuestion.startsWith(sample)).toBe(true);
    expect(sample.length).toBeGreaterThanOrEqual(previousLength);
    previousLength = sample.length;
  }
});

test("centers the compose cursor inside the active text row", async ({ page }) => {
  await page.goto("/");

  const textarea = page.getByLabel("Retro LCD input");
  await expect(textarea).toBeVisible();

  await textarea.click();
  await textarea.fill("I cards");

  const metrics = await page.evaluate(() => {
    const root = document.querySelector("[data-testid='prompt-zen-form'] .retro-lcd");
    const grid = root?.querySelector(".retro-lcd__grid");
    const cursor = root?.querySelector(".retro-lcd__cursor");
    const line = Array.from(root?.querySelectorAll(".retro-lcd__line") ?? []).find(
      (node) => (node.textContent?.replace(/\u00a0/gu, "").trim().length || 0) > 0
    );

    if (
      !(root instanceof HTMLElement) ||
      !(grid instanceof HTMLElement) ||
      !(cursor instanceof HTMLElement) ||
      !(line instanceof HTMLElement)
    ) {
      throw new Error("Compose LCD elements were not found.");
    }

    const cursorRect = cursor.getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    const gridStyle = window.getComputedStyle(grid);
    const lineHeight = Number.parseFloat(gridStyle.lineHeight);

    return {
      cursorHeight: cursorRect.height,
      cursorTopOffset: cursorRect.top - lineRect.top,
      expectedTopOffset: (lineRect.height - cursorRect.height) / 2,
      lineHeight
    };
  });

  expect(Math.abs(metrics.cursorTopOffset - metrics.expectedTopOffset)).toBeLessThanOrEqual(3);
  expect(metrics.cursorHeight).toBeGreaterThan(0);
  expect(metrics.cursorHeight).toBeLessThanOrEqual(metrics.lineHeight);
});

test("keeps terminal text stable while the live teletype response starts", async ({
  page
}) => {
  test.slow();

  await page.goto("/");

  const textarea = page.getByLabel("Retro LCD input");
  await expect(textarea).toBeVisible();
  await expect
    .poll(async () =>
      page.locator("[data-testid='prompt-zen-form'] .retro-lcd__body").evaluate((screen) =>
        Array.from(screen.querySelectorAll(".retro-lcd__line"))
          .map((line) => line.textContent?.replace(/\u00a0/gu, "").trim() || "")
          .join("")
          .trim()
      )
    )
    .not.toBe("");

  const placeholderColor = await page
    .locator("[data-testid='prompt-zen-form'] .retro-lcd")
    .evaluate((element) => {
      const line = Array.from(element.querySelectorAll(".retro-lcd__line")).find(
        (node) => (node.textContent?.replace(/\u00a0/gu, "").trim().length || 0) > 0
      );

      return window.getComputedStyle(line || element.querySelector(".retro-lcd__grid") || element).color;
    });

  await textarea.click();
  await textarea.fill(promptText);

  const composeTextColor = await page
    .locator("[data-testid='prompt-zen-form'] .retro-lcd")
    .evaluate((element) =>
      window.getComputedStyle(element.querySelector(".retro-lcd__grid") || element).color
    );

  const composeCursor = page.locator("[data-testid='prompt-zen-form'] .retro-lcd__cursor");
  await expect(composeCursor).toBeVisible();

  const composeCursorStyle = await composeCursor.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderTopWidth: style.borderTopWidth,
      borderTopStyle: style.borderTopStyle
    };
  });

  expect(composeCursorStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(composeCursorStyle.borderTopWidth).toBe("0px");
  expect(composeCursorStyle.borderTopStyle).toBe("none");

  await textarea.press("Enter");

  const promptTerminal = page.getByTestId("prompt-terminal");
  await expect(promptTerminal).toBeVisible();
  await expect(page.getByTestId("prompt-terminal-user")).toContainText(promptText);

  const terminalCursor = promptTerminal.locator(".retro-lcd__cursor");
  await expect
    .poll(async () => terminalCursor.isVisible().catch(() => false), {
      timeout: 10_000
    })
    .toBe(true);

  const terminalCursorStyle = await terminalCursor.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderTopWidth: style.borderTopWidth,
      borderTopStyle: style.borderTopStyle,
      borderTopColor: style.borderTopColor
    };
  });

  expect(terminalCursorStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(terminalCursorStyle.borderTopWidth).not.toBe("0px");
  expect(terminalCursorStyle.borderTopStyle).toBe("solid");

  const styleSamples = await collectTerminalStyleSamples(page);
  for (const sample of styleSamples) {
    expect(sample.userColor).toBe(composeTextColor);
    expect(sample.userAnimationName).toBe("none");
    expect(sample.bodyAnimationName).toBe("none");
    expect(sample.screenAnimationName).toBe("none");
  }

  await expect(page.getByTestId("prompt-terminal-content")).toContainText("OK");
  await expect(page.getByTestId("prompt-terminal-content")).toContainText(
    "# queued for isolated git + codex run"
  );
  await expect(page.getByTestId("prompt-terminal-content")).toContainText(
    "# preparing isolated git worktree"
  );
  await expect(page.getByTestId("prompt-terminal-content")).toContainText("# running codex cli");

  const ackColor = await promptTerminal.evaluate((terminal) => {
    const cell = Array.from(terminal.querySelectorAll(".retro-lcd__cell")).find(
      (node) =>
        node.classList.contains("retro-lcd__cell--faint") &&
        (node.textContent?.replace(/\u00a0/gu, "").trim().length || 0) > 0
    );

    if (!(cell instanceof HTMLElement)) {
      throw new Error("Ack cell was not found.");
    }

    return window.getComputedStyle(cell).color;
  });

  expect(ackColor).toBe(placeholderColor);

  await expect
    .poll(async () => {
      const working = await page.getByTestId("prompt-terminal-working").textContent();
      return (working || "").length > 0;
    }, {
      timeout: 10_000
    })
    .toBe(true);

  await expect
    .poll(async () => promptTerminal.getAttribute("data-overflow"), {
      timeout: 10_000
    })
    .toBe("true");

  await expect(page.locator(".history-surface")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".surface-toggle__button[data-active='true']")).toContainText(
    "Prompt history"
  );
  await expect(page.locator(".prompt-history__grid")).toContainText(
    "I keep noticing that the thoughts I avoid all day"
  );
});

test("keeps terminal text inside the lcd bounds and wraps long prompt content", async ({
  page
}) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto("/");

  const textarea = page.getByLabel("Retro LCD input");
  await expect(textarea).toBeVisible();

  await textarea.click();
  await textarea.fill(longWrapPromptText);
  await textarea.press("Enter");

  const promptTerminal = page.getByTestId("prompt-terminal");
  await expect(promptTerminal).toBeVisible();
  await expect(page.getByTestId("prompt-terminal-content")).toContainText("OK");
  await expect(page.getByTestId("prompt-terminal-user")).toContainText(
    longWrapPromptText.slice(0, 48)
  );

  const bounds = await collectTerminalBounds(page);

  expect(bounds.userRectCount).toBeGreaterThan(1);
  expect(bounds.visibleViolationCount).toBe(0);
});
