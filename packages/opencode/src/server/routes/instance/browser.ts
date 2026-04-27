import { BrowserService } from "@/browser"
import { lazy } from "@/util/lazy"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import fs from "fs/promises"
import z from "zod"
import { jsonRequest, runRequest } from "./trace"

const viewport = z.object({
  width: z.number(),
  height: z.number(),
})

export const BrowserRoutes = lazy(() =>
  new Hono()
    .get(
      "/:sessionID/state",
      describeRoute({
        summary: "Get browser state",
        description: "Get integrated browser state for an OpenCode session.",
        operationId: "browser.state",
        responses: {
          200: { description: "Browser state", content: { "application/json": { schema: resolver(z.any()) } } },
        },
      }),
      async (c) =>
        jsonRequest("BrowserRoutes.state", c, function* () {
          const browser = yield* BrowserService.Service
          return yield* browser.state(c.req.param("sessionID"))
        }),
    )
    .post(
      "/:sessionID/open",
      validator(
        "json",
        z.object({
          url: z.string(),
          waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
          reset: z.boolean().optional(),
          viewport: viewport.optional(),
        }),
      ),
      async (c) =>
        jsonRequest("BrowserRoutes.open", c, function* () {
          const browser = yield* BrowserService.Service
          const body = c.req.valid("json")
          return yield* browser.open(c.req.param("sessionID"), body.url, body)
        }),
    )
    .post("/:sessionID/reload", async (c) =>
      jsonRequest("BrowserRoutes.reload", c, function* () {
        const browser = yield* BrowserService.Service
        return yield* browser.reload(c.req.param("sessionID"))
      }),
    )
    .post("/:sessionID/back", async (c) =>
      jsonRequest("BrowserRoutes.back", c, function* () {
        const browser = yield* BrowserService.Service
        return yield* browser.back(c.req.param("sessionID"))
      }),
    )
    .post("/:sessionID/forward", async (c) =>
      jsonRequest("BrowserRoutes.forward", c, function* () {
        const browser = yield* BrowserService.Service
        return yield* browser.forward(c.req.param("sessionID"))
      }),
    )
    .post(
      "/:sessionID/click",
      validator(
        "json",
        z.object({
          x: z.number(),
          y: z.number(),
        }),
      ),
      async (c) =>
        jsonRequest("BrowserRoutes.click", c, function* () {
          const browser = yield* BrowserService.Service
          const body = c.req.valid("json")
          return yield* browser.click(c.req.param("sessionID"), body.x, body.y)
        }),
    )
    .post(
      "/:sessionID/screenshot",
      validator(
        "json",
        z
          .object({
            fullPage: z.boolean().optional(),
            quality: z.number().optional(),
            format: z.enum(["png", "jpeg"]).optional(),
          })
          .optional(),
      ),
      async (c) =>
        jsonRequest("BrowserRoutes.screenshot", c, function* () {
          const browser = yield* BrowserService.Service
          return yield* browser.screenshot(c.req.param("sessionID"), c.req.valid("json") ?? {})
        }),
    )
    .post("/:sessionID/resize", validator("json", viewport), async (c) =>
      jsonRequest("BrowserRoutes.resize", c, function* () {
        const browser = yield* BrowserService.Service
        return yield* browser.resize(c.req.param("sessionID"), c.req.valid("json"))
      }),
    )
    .post("/:sessionID/close", async (c) =>
      jsonRequest("BrowserRoutes.close", c, function* () {
        const browser = yield* BrowserService.Service
        return yield* browser.close(c.req.param("sessionID"))
      }),
    )
    .get("/:sessionID/screenshot", async (c) => {
      const data = await runRequest(
        "BrowserRoutes.screenshotFile",
        c,
        BrowserService.Service.use((browser) => browser.screenshotFile(c.req.param("sessionID"))),
      )
      if (!data) return c.text("No browser screenshot available", 404)
      return new Response(new Uint8Array(await fs.readFile(data.path)), {
        status: 200,
        headers: {
          "content-type": data.mime,
          "cache-control": "no-store",
        },
      })
    }),
)
