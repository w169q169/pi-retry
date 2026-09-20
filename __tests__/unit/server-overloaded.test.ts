import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordRetrySessionAgent } from "../../src/session-registry.js";

// Model a runtime where the session registry has no Agent bound to the
// session manager. Exercise public events and sendMessage instead of a
// registry-driven hidden AgentSession turn.
vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class { subscribe() {} continue() {} },
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  AgentSession: class {
    _prepareRetry() { return false; }
    bindExtensions() {}
  },
}));
// These tests contrast overload errors (exempt from the max-delay cutoff)
// with ordinary errors, so they pin a positive limit instead of the unlimited
// default. The extension seeds its per-session policy from the module default
// (configureSession never runs here), so DEFAULT_RETRY_CONFIG is pinned too.
vi.mock("../../src/config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/config.js")>();
  const pinned = { ...actual.DEFAULT_RETRY_CONFIG, maxRetriesAtMaxDelay: 3 };
  return {
    ...actual,
    DEFAULT_RETRY_CONFIG: pinned,
    loadPiRetryConfig: () => pinned,
  };
});

const overload = "Error: Error Code server_is_overloaded: Our servers are currently overloaded. Please try again later.";
const error = (errorMessage = overload) => ({
  role: "assistant", stopReason: "error", errorMessage, content: [],
});
const success = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };

beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function setup(captureAgent = false) {
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
  const sessionManager = { getEntries: () => [{ type: "message", message }] };
  const ctx = {
    mode: "rpc", ui: { notify: vi.fn() }, signal: controller.signal,
    sessionManager,
  } as unknown as ExtensionContext;
  const { default: extension } = await import("../../retry.ts");
  extension(api);
  const agent = {
    state: { messages: [error()] as object[] },
    waitForIdle: vi.fn().mockResolvedValue(undefined),
  };
  if (captureAgent) {
    recordRetrySessionAgent(sessionManager, agent as any);
    sendMessage.mockImplementation(() => { agent.state.messages = [error()]; });
  }
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

describe("automatic server overload retry", () => {
  it("retries the exact error with backoff and stops after success", async () => {
    const fixture = await setup();
    await fixture.finish(error());
    await vi.advanceTimersByTimeAsync(1999);
    expect(fixture.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
    expect(fixture.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ customType: "pi-retry:retry", display: false }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
    await fixture.finish(error());
    await vi.advanceTimersByTimeAsync(3999);
    expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.sendMessage).toHaveBeenCalledTimes(2);
    await fixture.finish(success);
    await vi.advanceTimersByTimeAsync(120000);
    expect(fixture.sendMessage).toHaveBeenCalledTimes(2);
    // A later independent failure starts at the initial delay again.
    await fixture.finish(error());
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("does not schedule duplicate retries for repeated agent_end events", async () => {
    const fixture = await setup();
    await fixture.finish(error());
    await fixture.fire("agent_end");
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["input", "session_shutdown", "session_start"])("cancels pending retry on %s", async event => {
    const fixture = await setup();
    await fixture.finish(error());
    await vi.advanceTimersByTimeAsync(500);
    await fixture.fire(event);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fixture.sendMessage).not.toHaveBeenCalled();
  });

  it("does not retry after the run is aborted", async () => {
    const fixture = await setup();
    await fixture.finish(error());
    fixture.controller.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fixture.sendMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])("continues beyond eight retries, then stops on success (captured Agent: %s)", async captureAgent => {
    const fixture = await setup(captureAgent);
    const delays = [2000, 4000, 8000, 16000, 32000, ...Array(7).fill(60000)];
    for (const [index, delay] of delays.entries()) {
      if (!captureAgent || index === 0) await fixture.finish(error());
      await vi.advanceTimersByTimeAsync(delay);
      expect(fixture.sendMessage).toHaveBeenCalledTimes(index + 1);
    }
    if (captureAgent) {
      fixture.sendMessage.mockImplementation(() => { fixture.agent.state.messages = [success]; });
      await vi.advanceTimersByTimeAsync(60000);
    } else {
      await fixture.finish(success);
    }
    const attempts = fixture.sendMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180000);
    expect(fixture.sendMessage).toHaveBeenCalledTimes(attempts);
  });

  it.each([false, true])("can cancel after more than eight retries (captured Agent: %s)", async captureAgent => {
    const fixture = await setup(captureAgent);
    const delays = [2000, 4000, 8000, 16000, 32000, ...Array(4).fill(60000)];
    for (const [index, delay] of delays.entries()) {
      if (!captureAgent || index === 0) await fixture.finish(error());
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(fixture.sendMessage).toHaveBeenCalledTimes(9);
    if (!captureAgent) await fixture.finish(error());
    fixture.controller.abort();
    await fixture.fire("turn_end", { message: { role: "assistant", stopReason: "aborted", content: [] } });
    await vi.advanceTimersByTimeAsync(180000);
    expect(fixture.sendMessage).toHaveBeenCalledTimes(9);
  });

  it("retains the configured ordinary error retry limit with a captured Agent", async () => {
    const fixture = await setup(true);
    fixture.sendMessage.mockImplementation(() => { fixture.agent.state.messages = [error("Connection error")]; });
    await fixture.finish(error("Connection error"));
    await vi.advanceTimersByTimeAsync(500000);
    expect(fixture.sendMessage).toHaveBeenCalledTimes(8);
  });

  it("keeps permanent failures out of the fallback", async () => {
    const fixture = await setup();
    await fixture.finish(error("Invalid API key; server_is_overloaded"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fixture.sendMessage).not.toHaveBeenCalled();
  });
});
