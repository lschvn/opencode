import { BrowserService } from "@/browser"
import type { BrowserState } from "@/browser/browser-types"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"

const Viewport = Schema.Struct({
  width: Schema.Number.annotate({ description: "Viewport width in CSS pixels" }),
  height: Schema.Number.annotate({ description: "Viewport height in CSS pixels" }),
})
type ViewportInput = Schema.Schema.Type<typeof Viewport>

const BrowserOpenParameters = Schema.Struct({
  url: Schema.String.annotate({ description: "URL to open. localhost URLs without a protocol are accepted." }),
  waitUntil: Schema.optional(Schema.Literals(["load", "domcontentloaded", "networkidle"])).annotate({
    description: "Navigation wait strategy. Defaults to domcontentloaded.",
  }),
  reset: Schema.optional(Schema.Boolean).annotate({ description: "Close any existing page before opening" }),
  viewport: Schema.optional(Viewport).annotate({ description: "Optional viewport size" }),
})
type BrowserOpenParameters = Schema.Schema.Type<typeof BrowserOpenParameters>

const BrowserActParameters = Schema.Struct({
  instruction: Schema.String.annotate({ description: "Natural language instruction for the browser action" }),
  timeoutMs: Schema.optional(Schema.Number).annotate({ description: "Action timeout in milliseconds" }),
  takeScreenshot: Schema.optional(Schema.Boolean).annotate({ description: "Update screenshot after the action" }),
})
type BrowserActParameters = Schema.Schema.Type<typeof BrowserActParameters>

const BrowserObserveParameters = Schema.Struct({
  instruction: Schema.optional(Schema.String).annotate({ description: "Optional thing to look for" }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Maximum number of observations" }),
})
type BrowserObserveParameters = Schema.Schema.Type<typeof BrowserObserveParameters>

const BrowserExtractParameters = Schema.Struct({
  instruction: Schema.String.annotate({ description: "Information to extract from the current page" }),
  schema: Schema.optional(Schema.Unknown).annotate({ description: "Optional JSON schema or schema description" }),
  takeScreenshot: Schema.optional(Schema.Boolean).annotate({ description: "Update screenshot after extraction" }),
})
type BrowserExtractParameters = Schema.Schema.Type<typeof BrowserExtractParameters>

const BrowserScreenshotParameters = Schema.Struct({
  fullPage: Schema.optional(Schema.Boolean).annotate({ description: "Capture full scrollable page" }),
  quality: Schema.optional(Schema.Number).annotate({ description: "JPEG quality when format is jpeg" }),
  format: Schema.optional(Schema.Literals(["png", "jpeg"])).annotate({ description: "Screenshot image format" }),
})
type BrowserScreenshotParameters = Schema.Schema.Type<typeof BrowserScreenshotParameters>

const BrowserStateParameters = Schema.Struct({
  verbose: Schema.optional(Schema.Boolean).annotate({ description: "Include recent console and network entries" }),
})
type BrowserStateParameters = Schema.Schema.Type<typeof BrowserStateParameters>

const BrowserConsoleParameters = Schema.Struct({
  level: Schema.optional(Schema.Literals(["all", "error", "warning", "info"])).annotate({
    description: "Console level filter",
  }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Maximum number of entries" }),
})
type BrowserConsoleParameters = Schema.Schema.Type<typeof BrowserConsoleParameters>

const BrowserNetworkParameters = Schema.Struct({
  failedOnly: Schema.optional(Schema.Boolean).annotate({ description: "Only include failed/HTTP error requests" }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Maximum number of entries" }),
})
type BrowserNetworkParameters = Schema.Schema.Type<typeof BrowserNetworkParameters>

const BrowserEvalParameters = Schema.Struct({
  script: Schema.String.annotate({ description: "JavaScript source to execute in the current page" }),
})
type BrowserEvalParameters = Schema.Schema.Type<typeof BrowserEvalParameters>

const BrowserCloseParameters = Schema.Struct({})
type BrowserCloseParameters = Schema.Schema.Type<typeof BrowserCloseParameters>

const stateSummary = (state: BrowserState) => ({
  url: state.url,
  title: state.title,
  status: state.status,
  error: state.error,
  viewport: state.viewport,
  screenshot: state.latestScreenshot
    ? {
        id: state.latestScreenshot.id,
        path: state.latestScreenshot.path,
        mime: state.latestScreenshot.mime,
        createdAt: state.latestScreenshot.createdAt,
      }
    : undefined,
  consoleErrors: [...state.console, ...state.pageErrors].filter((entry) => entry.type === "error").slice(-5),
  networkFailures: state.network.filter((entry) => entry.failed).slice(-5),
  initialized: state.initialized,
  stagehand: state.stagehand,
})

const output = (value: unknown) => JSON.stringify(value, null, 2)

export const BrowserOpenTool = Tool.define(
  "browser_open",
  Effect.gen(function* () {
    const browser = yield* BrowserService.Service
    return {
      description:
        "Open a URL in the integrated browser for the current session. Use this to inspect, test, and debug web pages or local development servers such as Vite, React, Nuxt, Next.js, or other localhost apps. Returns the loaded URL, page title, status, and a screenshot reference.",
      parameters: BrowserOpenParameters,
      execute: (params: BrowserOpenParameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_open",
            patterns: [params.url],
            always: ["*"],
            metadata: params,
          })
          const state = yield* browser.open(ctx.sessionID, params.url, params)
          return {
            title: state.title ?? state.url ?? "Browser",
            metadata: {},
            output: output(stateSummary(state)),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const BrowserActTool = Tool.define(
  "browser_act",
  Effect.gen(function* () {
    const browser = yield* BrowserService.Service
    return {
      description:
        "Perform a browser interaction using a natural-language instruction, such as clicking a button, filling an input, selecting an option, or submitting a form. Use this after opening a page when you need to test the UI like a user. This may change page state and should respect permissions.",
      parameters: BrowserActParameters,
      execute: (params: BrowserActParameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_act",
            patterns: [params.instruction],
            always: ["*"],
            metadata: params,
          })
          const state = yield* browser.act(ctx.sessionID, params.instruction, params)
          return {
            title: state.title ?? "Browser action",
            metadata: {},
            output: output(stateSummary(state)),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const BrowserObserveTool = Tool.define(
  "browser_observe",
  Effect.gen(function* () {
    const browser = yield* BrowserService.Service
    return {
      description:
        "Inspect the current page and return relevant interactive elements or possible actions. Use this before browser_act when you need to understand what can be clicked, filled, selected, or submitted.",
      parameters: BrowserObserveParameters,
      execute: (params: BrowserObserveParameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_observe",
            patterns: [params.instruction ?? "*"],
            always: ["*"],
            metadata: params,
          })
          return {
            title: "Browser observations",
            metadata: {},
            output: output(yield* browser.observe(ctx.sessionID, params.instruction, params.limit)),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const BrowserExtractTool = Tool.define(
  "browser_extract",
  Effect.gen(function* () {
    const browser = yield* BrowserService.Service
    return {
      description:
        "Extract structured information from the current browser page, such as visible validation errors, table rows, product data, page headings, form state, or UI copy. Returns concise structured data.",
      parameters: BrowserExtractParameters,
      execute: (params: BrowserExtractParameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_extract",
            patterns: [params.instruction],
            always: ["*"],
            metadata: params,
          })
          return {
            title: "Browser extract",
            metadata: {},
            output: output(yield* browser.extract(ctx.sessionID, params.instruction, params.schema, params)),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const BrowserScreenshotTool = Tool.define(
  "browser_screenshot",
  Effect.gen(function* () {
    const browser = yield* BrowserService.Service
    return {
      description:
        "Capture the current browser page as a screenshot and update the integrated browser panel. Use this to visually inspect the UI after navigation or actions.",
      parameters: BrowserScreenshotParameters,
      execute: (params: BrowserScreenshotParameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_screenshot",
            patterns: ["*"],
            always: ["*"],
            metadata: params,
          })
          return {
            title: "Browser screenshot",
            metadata: {},
            output: output(yield* browser.screenshot(ctx.sessionID, params)),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const BrowserStateTool = Tool.define(
  "browser_state",
  Effect.gen(function* () {
    const browser = yield* BrowserService.Service
    return {
      description:
        "Return the current integrated browser state, including URL, title, viewport, loading/error status, latest screenshot, and whether a browser session is active.",
      parameters: BrowserStateParameters,
      execute: (params: BrowserStateParameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_state",
            patterns: ["*"],
            always: ["*"],
            metadata: params,
          })
          const state = yield* browser.state(ctx.sessionID)
          return {
            title: state.title ?? "Browser state",
            metadata: {},
            output: output(params.verbose ? state : stateSummary(state)),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const BrowserConsoleTool = Tool.define(
  "browser_console",
  Effect.gen(function* () {
    const browser = yield* BrowserService.Service
    return {
      description:
        "Return recent console logs and page errors from the integrated browser. Use this to debug frontend runtime errors, warnings, and client-side exceptions.",
      parameters: BrowserConsoleParameters,
      execute: (params: BrowserConsoleParameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_console",
            patterns: [params.level ?? "*"],
            always: ["*"],
            metadata: params,
          })
          return {
            title: "Browser console",
            metadata: {},
            output: output(yield* browser.console(ctx.sessionID, params.level, params.limit)),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const BrowserNetworkTool = Tool.define(
  "browser_network",
  Effect.gen(function* () {
    const browser = yield* BrowserService.Service
    return {
      description:
        "Return recent network activity, especially failed requests and HTTP errors. Use this to debug API failures, missing assets, CORS issues, and broken routes.",
      parameters: BrowserNetworkParameters,
      execute: (params: BrowserNetworkParameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_network",
            patterns: ["*"],
            always: ["*"],
            metadata: params,
          })
          return {
            title: "Browser network",
            metadata: {},
            output: output(yield* browser.network(ctx.sessionID, params.failedOnly, params.limit)),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const BrowserResizeTool = Tool.define(
  "browser_resize",
  Effect.gen(function* () {
    const browser = yield* BrowserService.Service
    return {
      description:
        "Resize the integrated browser viewport. Use this to test responsive layouts at desktop, tablet, or mobile dimensions.",
      parameters: Viewport,
      execute: (params: ViewportInput, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_resize",
            patterns: [`${params.width}x${params.height}`],
            always: ["*"],
            metadata: params,
          })
          return {
            title: "Browser resized",
            metadata: {},
            output: output(stateSummary(yield* browser.resize(ctx.sessionID, params))),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const BrowserEvalTool = Tool.define(
  "browser_eval",
  Effect.gen(function* () {
    const browser = yield* BrowserService.Service
    return {
      description:
        "Execute JavaScript in the current browser page for debugging or inspection. This is powerful and should be permission-protected.",
      parameters: BrowserEvalParameters,
      execute: (params: BrowserEvalParameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_eval",
            patterns: [params.script],
            always: ["*"],
            metadata: { script: params.script.slice(0, 500) },
          })
          return {
            title: "Browser eval",
            metadata: {},
            output: output(yield* browser.evaluate(ctx.sessionID, params.script)),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const BrowserCloseTool = Tool.define(
  "browser_close",
  Effect.gen(function* () {
    const browser = yield* BrowserService.Service
    return {
      description: "Close the integrated browser session and release browser resources.",
      parameters: BrowserCloseParameters,
      execute: (_: BrowserCloseParameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_close",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          return {
            title: "Browser closed",
            metadata: {},
            output: output(stateSummary(yield* browser.close(ctx.sessionID))),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
