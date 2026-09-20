import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Older SDK shape: AgentSession has the retry seam but NOT bindExtensions, so
// the session registry cannot be installed and the extension must fall back to
// the subscribe-captured Agent plus a direct _prepareRetry patch.
vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class { subscribe() {} continue() {} },
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  AgentSession: class {
    _prepareRetry() { return false; }
    // No bindExtensions — pre-registry SDK.
  },
}));
vi.mock("../../src/config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/config.js")>();
  return { ...actual, loadPiRetryConfig: () => actual.DEFAULT_RETRY_CONFIG };
});

const error = (errorMessage = "Connection error.") => ({
  role: "assistant", stopReason: "error", errorMessage, content: [],
});
const success = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };

beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function setup() {
  const handlers: Record<string, Function[]> = {};
  const sendMessage = vi.fn();
  const api = {
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    on(name: string, handler: Function) { (handlers[name] ??= []).push(handler); },
    registerCommand() {},
    sendMessage,
  } as unknown as ExtensionAPI;
  let message = error() as object;
  const controller = new AbortController();
  const ctx = {
    mode: "rpc", ui: { notify: vi.fn() }, signal: controller.signal,
    sessionManager: { getEntries: () => [{ type: "message", message }] },
  } as unknown as ExtensionContext;
  const { Agent } = await import("@earendil-works/pi-agent-core");
  const { default: extension } = await import("../../retry.ts");
  extension(api);
  const agent = {
    state: { messages: [error()] as object[] },
    waitForIdle: vi.fn().mockResolvedValue(undefined),
  };
  // The fallback subscribes through the patched prototype; call it like the
  // real AgentSession does when it binds its event handler.
  (Agent.prototype.subscribe as (...args: unknown[]) => unknown).call(agent, vi.fn());
  async function fire(name: string, event = {}) {
    for (const handler of handlers[name] ?? []) await handler(event, ctx);
  }
  await fire("session_start");
  return { sendMessage, controller, fire, agent, async finish(next: object) {
    message = next;
    agent.state.messages = [next];
    await fire("turn_end", { message });
    await fire("agent_end", { messages: [message] });
  } };
}

describe("fallback mode (SDK without the session-registry seam)", () => {
  it("marks the load in the journal and retries connection errors via the captured Agent", async () => {
    const fixture = await setup();
    // The one-time fallback marker lands first.
    expect(fixture.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pi-retry:loaded", display: false }),
      { triggerTurn: false },
    );
    const markerCalls = fixture.sendMessage.mock.calls.length;

    await fixture.finish(error());
    await vi.advanceTimersByTimeAsync(1999);
    expect(fixture.sendMessage.mock.calls.length).toBe(markerCalls);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.sendMessage.mock.calls.length).toBe(markerCalls + 1);
    expect(fixture.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ customType: "pi-retry:retry", display: false }),
      { triggerTurn: true, deliverAs: "followUp" },
    );

    await fixture.finish(success);
    await vi.advanceTimersByTimeAsync(120000);
    expect(fixture.sendMessage.mock.calls.length).toBe(markerCalls + 1);
  });

  it("keeps retrying across consecutive failures (fresh loop per failure)", async () => {
    const fixture = await setup();
    const markerCalls = fixture.sendMessage.mock.calls.length;
    await fixture.finish(error());
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.sendMessage.mock.calls.length).toBe(markerCalls + 1);
    // The mock sendMessage does not drive a real turn, so the loop exits after
    // its retry (empty transcript reads as success); the next failure starts
    // a fresh loop with the initial backoff again.
    await fixture.finish(error());
    await vi.advanceTimersByTimeAsync(1999);
    expect(fixture.sendMessage.mock.calls.length).toBe(markerCalls + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.sendMessage.mock.calls.length).toBe(markerCalls + 2);
  });

  it("does not retry permanent failures", async () => {
    const fixture = await setup();
    const markerCalls = fixture.sendMessage.mock.calls.length;
    await fixture.finish(error("Invalid API key"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(fixture.sendMessage.mock.calls.length).toBe(markerCalls);
  });

  it("cancels the pending retry on user abort", async () => {
    const fixture = await setup();
    await fixture.finish(error());
    await vi.advanceTimersByTimeAsync(500);
    fixture.controller.abort();
    await fixture.fire("turn_end", { message: { role: "assistant", stopReason: "aborted", content: [] } });
    await vi.advanceTimersByTimeAsync(60000);
    // Only the load marker was sent — no retry turn.
    expect(fixture.sendMessage.mock.calls.filter(
      ([m]) => (m as { customType?: string }).customType === "pi-retry:retry",
    )).toHaveLength(0);
  });
});
