import { Schema } from "effect"
import { SessionID } from "@/session/schema"

export const BrowserViewport = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
}).annotate({ identifier: "BrowserViewport" })
export type BrowserViewport = Schema.Schema.Type<typeof BrowserViewport>

export const BrowserScreenshot = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  mime: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  createdAt: Schema.Number,
}).annotate({ identifier: "BrowserScreenshot" })
export type BrowserScreenshot = Schema.Schema.Type<typeof BrowserScreenshot>

export const BrowserConsoleEntry = Schema.Struct({
  type: Schema.String,
  text: Schema.String,
  location: Schema.optional(Schema.String),
  time: Schema.Number,
}).annotate({ identifier: "BrowserConsoleEntry" })
export type BrowserConsoleEntry = Schema.Schema.Type<typeof BrowserConsoleEntry>

export const BrowserNetworkEntry = Schema.Struct({
  method: Schema.String,
  url: Schema.String,
  resourceType: Schema.String,
  status: Schema.optional(Schema.Number),
  statusText: Schema.optional(Schema.String),
  failed: Schema.Boolean,
  errorText: Schema.optional(Schema.String),
  time: Schema.Number,
}).annotate({ identifier: "BrowserNetworkEntry" })
export type BrowserNetworkEntry = Schema.Schema.Type<typeof BrowserNetworkEntry>

export const BrowserPageInfo = Schema.Struct({
  url: Schema.String,
  title: Schema.optional(Schema.String),
}).annotate({ identifier: "BrowserPageInfo" })
export type BrowserPageInfo = Schema.Schema.Type<typeof BrowserPageInfo>

export const BrowserActivity = Schema.Struct({
  type: Schema.String,
  label: Schema.optional(Schema.String),
  startedAt: Schema.Number,
}).annotate({ identifier: "BrowserActivity" })
export type BrowserActivity = Schema.Schema.Type<typeof BrowserActivity>

export const BrowserState = Schema.Struct({
  sessionID: SessionID,
  url: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  status: Schema.Literals(["idle", "loading", "ready", "error", "closed"]),
  error: Schema.optional(Schema.String),
  activity: Schema.optional(BrowserActivity),
  viewport: BrowserViewport,
  latestScreenshot: Schema.optional(BrowserScreenshot),
  createdAt: Schema.Number,
  lastUsedAt: Schema.Number,
  console: Schema.mutable(Schema.Array(BrowserConsoleEntry)),
  pageErrors: Schema.mutable(Schema.Array(BrowserConsoleEntry)),
  network: Schema.mutable(Schema.Array(BrowserNetworkEntry)),
  pages: Schema.mutable(Schema.Array(BrowserPageInfo)),
  initialized: Schema.Boolean,
  stagehand: Schema.Struct({
    available: Schema.Boolean,
    enabled: Schema.Boolean,
  }),
}).annotate({ identifier: "BrowserState" })
export type BrowserState = Schema.Schema.Type<typeof BrowserState>

export type BrowserOpenOptions = {
  waitUntil?: "load" | "domcontentloaded" | "networkidle"
  reset?: boolean
  viewport?: BrowserViewport
}

export type BrowserScreenshotOptions = {
  fullPage?: boolean
  quality?: number
  format?: "png" | "jpeg"
}

export type BrowserActionOptions = {
  timeoutMs?: number
  takeScreenshot?: boolean
}

export type BrowserExtractOptions = {
  takeScreenshot?: boolean
}
