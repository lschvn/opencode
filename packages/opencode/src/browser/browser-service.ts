import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config"
import { InstanceState } from "@/effect"
import { Log } from "@/util"
import { Effect, Layer, Context } from "effect"
import fs from "fs/promises"
import { BrowserSession } from "./browser-session"
import { BrowserState as BrowserStateSchema } from "./browser-types"
import type {
  BrowserActionOptions,
  BrowserExtractOptions,
  BrowserOpenOptions,
  BrowserScreenshotOptions,
  BrowserState,
  BrowserViewport,
} from "./browser-types"

const log = Log.create({ service: "browser" })
export const Updated = BusEvent.define("browser.updated", BrowserStateSchema)

type State = {
  sessions: Map<string, BrowserSession>
}

export interface Interface {
  readonly getOrCreate: (sessionID: string) => Effect.Effect<BrowserSession>
  readonly open: (sessionID: string, url: string, options?: BrowserOpenOptions) => Effect.Effect<BrowserState>
  readonly act: (sessionID: string, instruction: string, options?: BrowserActionOptions) => Effect.Effect<BrowserState>
  readonly observe: (sessionID: string, instruction?: string, limit?: number) => Effect.Effect<unknown[]>
  readonly extract: (
    sessionID: string,
    instruction: string,
    schema?: unknown,
    options?: BrowserExtractOptions,
  ) => Effect.Effect<unknown>
  readonly screenshot: (
    sessionID: string,
    options?: BrowserScreenshotOptions,
  ) => Effect.Effect<BrowserState["latestScreenshot"]>
  readonly state: (sessionID: string) => Effect.Effect<BrowserState>
  readonly close: (sessionID: string) => Effect.Effect<BrowserState>
  readonly resize: (sessionID: string, viewport: BrowserViewport) => Effect.Effect<BrowserState>
  readonly evaluate: (sessionID: string, script: string) => Effect.Effect<unknown>
  readonly console: (
    sessionID: string,
    level?: "all" | "error" | "warning" | "info",
    limit?: number,
  ) => Effect.Effect<unknown[]>
  readonly network: (sessionID: string, failedOnly?: boolean, limit?: number) => Effect.Effect<unknown[]>
  readonly reload: (sessionID: string) => Effect.Effect<BrowserState>
  readonly back: (sessionID: string) => Effect.Effect<BrowserState>
  readonly forward: (sessionID: string) => Effect.Effect<BrowserState>
  readonly click: (sessionID: string, x: number, y: number) => Effect.Effect<BrowserState>
  readonly screenshotFile: (sessionID: string) => Effect.Effect<{ path: string; mime: string } | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Browser") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Browser.state")(function* () {
        const s: State = { sessions: new Map() }
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await Promise.all(
              [...s.sessions.values()].map((session) =>
                session.close().catch((error) => {
                  log.warn("failed to close browser session", { error })
                }),
              ),
            )
            s.sessions.clear()
          }),
        )
        return s
      }),
    )

    const getOrCreate = Effect.fn("Browser.getOrCreate")(function* (sessionID: string) {
      const s = yield* InstanceState.get(state)
      const existing = s.sessions.get(sessionID)
      if (existing) return existing

      const cfg = yield* config.get()
      if (cfg.browser?.enabled === false) {
        throw new Error("The integrated browser is disabled by config: browser.enabled is false.")
      }

      const session = new BrowserSession(sessionID, {
        headless: cfg.browser?.headless ?? true,
        viewport: cfg.browser?.viewport,
        timeoutMs: cfg.browser?.timeoutMs,
        devtools: cfg.browser?.devtools,
      })
      s.sessions.set(sessionID, session)
      return session
    })

    const publish = Effect.fn("Browser.publish")(function* (sessionID: string) {
      const session = yield* getOrCreate(sessionID)
      yield* bus.publish(Updated, session.snapshot()).pipe(Effect.catch(() => Effect.void))
    })

    const run = <T>(sessionID: string, effect: (session: BrowserSession) => Promise<T>) =>
      Effect.gen(function* () {
        const session = yield* getOrCreate(sessionID)
        const result = yield* Effect.promise(() => effect(session))
        yield* publish(sessionID)
        return result
      })

    return Service.of({
      getOrCreate,
      open: (sessionID, url, options) => run(sessionID, (session) => session.open(url, options)),
      act: (sessionID, instruction, options) => run(sessionID, (session) => session.act(instruction, options)),
      observe: (sessionID, instruction, limit) => run(sessionID, (session) => session.observe(instruction, limit)),
      extract: (sessionID, instruction, schema, options) =>
        run(sessionID, (session) => session.extract(instruction, schema, options)),
      screenshot: (sessionID, options) => run(sessionID, (session) => session.screenshot(options)),
      state: (sessionID) =>
        Effect.gen(function* () {
          const s = yield* InstanceState.get(state)
          const session = s.sessions.get(sessionID)
          if (session) return session.snapshot()
          return (yield* getOrCreate(sessionID)).snapshot()
        }),
      close: (sessionID) =>
        Effect.gen(function* () {
          const s = yield* InstanceState.get(state)
          const session = s.sessions.get(sessionID)
          if (!session) return (yield* getOrCreate(sessionID)).snapshot()
          const result = yield* Effect.promise(() => session.close())
          s.sessions.delete(sessionID)
          yield* bus.publish(Updated, result).pipe(Effect.catch(() => Effect.void))
          return result
        }),
      resize: (sessionID, viewport) => run(sessionID, (session) => session.resize(viewport)),
      evaluate: (sessionID, script) => run(sessionID, (session) => session.evaluate(script)),
      console: (sessionID, level, limit) => run(sessionID, (session) => Promise.resolve(session.console(level, limit))),
      network: (sessionID, failedOnly, limit) =>
        run(sessionID, (session) => Promise.resolve(session.network(failedOnly, limit))),
      reload: (sessionID) => run(sessionID, (session) => session.reload()),
      back: (sessionID) => run(sessionID, (session) => session.back()),
      forward: (sessionID) => run(sessionID, (session) => session.forward()),
      click: (sessionID, x, y) => run(sessionID, (session) => session.click(x, y)),
      screenshotFile: (sessionID) =>
        Effect.gen(function* () {
          const s = yield* InstanceState.get(state)
          const shot = s.sessions.get(sessionID)?.snapshot().latestScreenshot
          if (!shot) return
          const ok = yield* Effect.promise(() =>
            fs.access(shot.path).then(
              () => true,
              () => false,
            ),
          )
          if (!ok) return
          return { path: shot.path, mime: shot.mime }
        }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(Bus.defaultLayer))
