import { Global } from "@opencode-ai/core/global"
import path from "path"
import fs from "fs/promises"
import { ulid } from "ulid"
import type { BrowserScreenshot, BrowserScreenshotOptions, BrowserViewport } from "./browser-types"

export async function ensureArtifactDir(sessionID: string) {
  const dir = path.join(Global.Path.cache, "browser", "artifacts", sessionID)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export async function ensureProfileDir(sessionID: string) {
  const dir = path.join(Global.Path.cache, "browser", "profiles", sessionID)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export async function screenshotPath(sessionID: string, options: BrowserScreenshotOptions) {
  const format = options.format ?? "png"
  const id = ulid()
  return {
    id,
    format,
    path: path.join(await ensureArtifactDir(sessionID), `${id}.${format}`),
  }
}

export function screenshotArtifact(input: {
  id: string
  path: string
  format: "png" | "jpeg"
  viewport: BrowserViewport
}): BrowserScreenshot {
  return {
    id: input.id,
    path: input.path,
    mime: input.format === "jpeg" ? "image/jpeg" : "image/png",
    width: input.viewport.width,
    height: input.viewport.height,
    createdAt: Date.now(),
  }
}
