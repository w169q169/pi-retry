import { describe, it, expect, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  hasOverloadedError,
  hasRetryableError,
  isNonRetryableError,
  isContextOverflowError,
  getErrorCategory,
  OVERLOADED_ERROR_PATTERNS,
} from "../../src/index.js";
import retryExtension from "../../retry.js";

describe("server_is_overloaded error support", () => {
  const OVERLOADED_ERROR_MSG =
    "Error: Error Code server_is_overloaded: Our servers are currently overloaded. Please try again later.";

  const createAssistantError = (errorMessage: string): AgentMessage =>
    ({
      role: "assistant",
      stopReason: "error",
      errorMessage,
      content: [],
    } as unknown as AgentMessage);

  describe("pattern matching and classification", () => {
    it("hasOverloadedError recognizes exact error string", () => {
      const msg = createAssistantError(OVERLOADED_ERROR_MSG);
      expect(hasOverloadedError(msg)).toBe(true);
    });

    it("hasOverloadedError recognizes error code variant", () => {
      const msg = createAssistantError("server_is_overloaded");
      expect(hasOverloadedError(msg)).toBe(true);
    });

    it("hasOverloadedError recognizes server message variant", () => {
      const msg = createAssistantError(
        "Our servers are currently overloaded. Please try again later.",
      );
      expect(hasOverloadedError(msg)).toBe(true);
    });

    it("hasRetryableError classifies it as retryable", () => {
      const msg = createAssistantError(OVERLOADED_ERROR_MSG);
      expect(hasRetryableError(msg)).toBe(true);
    });

    it("isNonRetryableError returns false", () => {
      const msg = createAssistantError(OVERLOADED_ERROR_MSG);
      expect(isNonRetryableError(msg)).toBe(false);
    });

    it("isContextOverflowError returns false (not treated as overflow)", () => {
      const msg = createAssistantError(OVERLOADED_ERROR_MSG);
      expect(isContextOverflowError(msg)).toBe(false);
    });

    it("getErrorCategory classifies it as builtin / server error", () => {
      expect(getErrorCategory(OVERLOADED_ERROR_MSG)).toBe("builtin");
      expect(getErrorCategory("server_is_overloaded")).toBe("builtin");
    });
  });

  describe("manual /retry command integration", () => {
    it("notifies 'Manually retrying server overloaded error...' when /retry is invoked", async () => {
      const handlers: Record<string, Function[]> = {};
      const commands: Record<string, { handler: (args: string[], ctx: any) => Promise<void> }> = {};

      const api = {
        events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
        on(event: string, handler: Function) {
          (handlers[event] ??= []).push(handler);
        },
        registerCommand(name: string, opts: { handler: (args: string[], ctx: any) => Promise<void> }) {
          commands[name] = opts;
        },
        sendMessage: vi.fn(),
      } as unknown as ExtensionAPI;

      retryExtension(api);

      const msg = createAssistantError(OVERLOADED_ERROR_MSG);
      const ctx = {
        ui: { notify: vi.fn() },
        sessionManager: {
          getEntries: vi.fn().mockReturnValue([
            { type: "message", message: msg },
          ]),
        },
      } as unknown as ExtensionCommandContext;

      expect(commands["retry"]).toBeDefined();
      await commands["retry"].handler([], ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Manually retrying server overloaded error...",
        "info",
      );
    });
  });
});
