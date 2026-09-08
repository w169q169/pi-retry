import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Model a runtime where AgentSession's Agent is not the extension's imported
// class, so the subscribe hook never captures it. Exercise public events and
// sendMessage instead of manually installing an Agent into the extension.
vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class { subscribe() {} continue() {} },
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  AgentSession: class { _prepareRetry() { return false; } },
}));
vi.mock("../../src/config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/config.js")>();
  return { ...actual, loadPiRetryConfig: () => actual.DEFAULT_RETRY_CONFIG };
});

const overload = "Error: Error Code server_is_overloaded: Our servers are currently overloaded. Please try again later.";
const error = (errorMessage = overload) => ({
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
  const { default: extension } = await import("../../retry.ts");
  extension(api);
  async function fire(name: string, event = {}) {
    for (const handler of handlers[name] ?? []) await handler(event, ctx);
  }
  await fire("session_start");
  return { sendMessage, controller, fire, async finish(next: object) {
    message = next;
    await fire("turn_end", { message });
    await fire("agent_end", { messages: [message] });
  } };
}

describe("automatic server overload retry without a captured Agent", () => {
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

  it("stops after the configured failures at maximum backoff", async () => {
    const fixture = await setup();
    const delays = [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000];
    for (const [index, delay] of delays.entries()) {
      await fixture.finish(error());
      await vi.advanceTimersByTimeAsync(delay);
      expect(fixture.sendMessage).toHaveBeenCalledTimes(index + 1);
    }
    await fixture.finish(error());
    await vi.advanceTimersByTimeAsync(120000);
    expect(fixture.sendMessage).toHaveBeenCalledTimes(delays.length);
  });

  it("keeps permanent failures out of the fallback", async () => {
    const fixture = await setup();
    await fixture.finish(error("Invalid API key; server_is_overloaded"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fixture.sendMessage).not.toHaveBeenCalled();
  });
});
