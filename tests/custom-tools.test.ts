import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  customToolAgentDef,
  customToolToBetaRunnable,
  defineTool,
  enabledCustomToolNames,
  isCustomToolEnabled,
  sanitizeJsonSchemaForAnthropic,
} from "../src/tools/custom-tools-runtime";

// `defineTool` is a no-op typed wrapper. These tests pin down the
// surface area users actually consume so a refactor that changes the
// signature breaks here loudly rather than silently in the wiring.

const ECHO = defineTool({
  name: "echo",
  description: "Echoes back what you give it.",
  inputSchema: z.object({
    text: z.string().describe("Text to echo."),
  }),
  run: async ({ text }) => `echo: ${text}`,
});

const ECHO_WITH_GATE = defineTool({
  name: "echo_gated",
  description: "Echoes, but only when SECRET_BINDING is configured.",
  inputSchema: z.object({ text: z.string() }),
  requires: (env) =>
    Boolean((env as unknown as { SECRET_BINDING?: unknown }).SECRET_BINDING),
  run: async ({ text }) => `gated: ${text}`,
});

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    ANTHROPIC_API_KEY: "test",
    ANTHROPIC_ENVIRONMENT_KEY: "test",
    ENVIRONMENT_ID: "env",
    WEBHOOK_SECRET: "secret",
    ...overrides,
  } as unknown as Env;
}

describe("isCustomToolEnabled", () => {
  it("treats predicate-less tools as always enabled", () => {
    expect(isCustomToolEnabled(ECHO, makeEnv())).toBe(true);
  });

  it("calls the requires predicate when present", () => {
    expect(isCustomToolEnabled(ECHO_WITH_GATE, makeEnv())).toBe(false);
    expect(
      isCustomToolEnabled(ECHO_WITH_GATE, makeEnv({ SECRET_BINDING: {} })),
    ).toBe(true);
  });

  it("treats a throwing predicate as 'not available'", () => {
    const broken = defineTool({
      name: "broken",
      description: "x",
      inputSchema: z.object({}),
      requires: () => {
        throw new Error("boom");
      },
      run: async () => "x",
    });
    expect(isCustomToolEnabled(broken, makeEnv())).toBe(false);
  });
});

describe("customToolAgentDef", () => {
  it("converts a zod object schema to the Anthropic input_schema shape", () => {
    const def = customToolAgentDef(ECHO);
    expect(def).toMatchObject({
      name: "echo",
      description: "Echoes back what you give it.",
      inputSchema: {
        type: "object",
        properties: {
          text: expect.objectContaining({ type: "string", description: "Text to echo." }),
        },
        required: ["text"],
      },
    });
  });

  it("rejects non-object input schemas with a helpful error", () => {
    const bad = defineTool({
      name: "bad",
      description: "x",
      inputSchema: z.string() as unknown as z.ZodObject,
      run: async () => "x",
    });
    expect(() => customToolAgentDef(bad)).toThrow(/must use a z.object/);
  });

  // Regression: zod v4's `toJSONSchema(..., { reused: "ref" })` hoists
  // wrapped sub-schemas (`.default()`/`.optional()` + `.describe()`) into
  // `$defs` and leaves `$ref` pointers behind. We strip `$defs` before
  // sending to Anthropic, so any leftover `$ref` dangles and the API
  // rejects the agent on create. Inline mode keeps the payload valid.
  it("inlines reused sub-schemas — no $ref reaches the agent payload", () => {
    const wrappedDefaults = defineTool({
      name: "wrapped",
      description: "Mimics the property shapes that originally tripped the API.",
      inputSchema: z.object({
        format: z
          .enum(["a", "b"])
          .default("a")
          .describe("Default + describe wraps the enum."),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Optional + describe wraps the integer."),
      }),
      run: async () => "ok",
    });
    const def = customToolAgentDef(wrappedDefaults);
    const wire = JSON.stringify(def);
    expect(wire).not.toContain("$ref");
    expect(wire).not.toContain("$defs");
    const format = def.inputSchema.properties.format as Record<string, unknown>;
    expect(format.type).toBe("string");
    expect(format.enum).toEqual(["a", "b"]);
    const limit = def.inputSchema.properties.limit as Record<string, unknown>;
    expect(limit.type).toBe("integer");
    expect(limit.maximum).toBe(100);
  });

  // Regression: zod's `.email()` emits a regex with negative lookahead
  // that Anthropic's RE2-style validator rejects with "pattern must be
  // a valid regex". The sanitizer strips RE2-incompatible patterns but
  // keeps the `format: "email"` hint so the model still sees what's
  // expected.
  it("drops RE2-incompatible patterns from email fields, preserves format", () => {
    const emailTool = defineTool({
      name: "send",
      description: "x",
      inputSchema: z.object({
        to: z.string().email(),
        from: z.string().email().optional(),
      }),
      run: async () => "ok",
    });
    const def = customToolAgentDef(emailTool);
    const wire = JSON.stringify(def);
    expect(wire).not.toMatch(/\(\?<?[=!]/);
    const to = def.inputSchema.properties.to as Record<string, unknown>;
    expect(to.format).toBe("email");
    expect(to.pattern).toBeUndefined();
  });
});

describe("sanitizeJsonSchemaForAnthropic", () => {
  // The sanitizer is the load-bearing piece for both bug classes —
  // strip-on-the-way-out instead of strip-at-the-source so user-defined
  // tools get the same protection without the user knowing about RE2.
  it("removes `pattern` containing negative lookahead", () => {
    const out = sanitizeJsonSchemaForAnthropic({
      type: "string",
      pattern: "^(?!\\.)abc$",
    }) as Record<string, unknown>;
    expect(out.pattern).toBeUndefined();
    expect(out.type).toBe("string");
  });

  it("removes `pattern` containing lookbehind", () => {
    const out = sanitizeJsonSchemaForAnthropic({
      type: "string",
      pattern: "(?<=foo)bar",
    }) as Record<string, unknown>;
    expect(out.pattern).toBeUndefined();
  });

  it("removes `pattern` containing backreferences", () => {
    const out = sanitizeJsonSchemaForAnthropic({
      type: "string",
      pattern: "^(a)\\1$",
    }) as Record<string, unknown>;
    expect(out.pattern).toBeUndefined();
  });

  // Simple anchored character-class patterns are RE2-safe — these come
  // from user-defined `z.string().regex(...)` calls and should survive.
  it("keeps RE2-safe user patterns", () => {
    const out = sanitizeJsonSchemaForAnthropic({
      type: "string",
      pattern: "^[a-z0-9_-]+$",
    }) as Record<string, unknown>;
    expect(out.pattern).toBe("^[a-z0-9_-]+$");
  });

  it("recurses into nested properties and arrays", () => {
    const out = sanitizeJsonSchemaForAnthropic({
      type: "object",
      properties: {
        email: { type: "string", pattern: "^(?!x)y$" },
        items: {
          type: "array",
          items: { type: "string", pattern: "^(?<=a)b$" },
        },
      },
    }) as {
      properties: { email: { pattern?: string }; items: { items: { pattern?: string } } };
    };
    expect(out.properties.email.pattern).toBeUndefined();
    expect(out.properties.items.items.pattern).toBeUndefined();
  });
});

describe("customToolToBetaRunnable", () => {
  it("invokes the user's run function with validated input", async () => {
    const tool = customToolToBetaRunnable(ECHO, makeEnv());
    expect(tool.name).toBe("echo");
    const result = await tool.run({ text: "hi" });
    expect(result).toBe("echo: hi");
  });

  it("stringifies thrown errors into a tool-result string", async () => {
    const throwy = defineTool({
      name: "throwy",
      description: "x",
      inputSchema: z.object({}),
      run: async () => {
        throw new Error("kaboom");
      },
    });
    const tool = customToolToBetaRunnable(throwy, makeEnv());
    const result = await tool.run({});
    expect(result).toBe("error: kaboom");
  });
});

describe("enabledCustomToolNames", () => {
  it("returns only tools that pass the requires gate", () => {
    expect(enabledCustomToolNames([ECHO, ECHO_WITH_GATE], makeEnv())).toEqual([
      "echo",
    ]);
    expect(
      enabledCustomToolNames(
        [ECHO, ECHO_WITH_GATE],
        makeEnv({ SECRET_BINDING: {} }),
      ),
    ).toEqual(["echo", "echo_gated"]);
  });
});
