import type { BrowserContext, ConsoleMessage, Page, Request, Response } from "playwright"
import { BrowserDependencyError, BrowserNavigationError, BrowserNotInitializedError } from "./browser-errors"
import { ensureProfileDir, screenshotArtifact, screenshotPath } from "./browser-artifacts"
import type {
  BrowserActionOptions,
  BrowserConsoleEntry,
  BrowserExtractOptions,
  BrowserNetworkEntry,
  BrowserOpenOptions,
  BrowserScreenshotOptions,
  BrowserState,
  BrowserViewport,
} from "./browser-types"

const DEFAULT_VIEWPORT = { width: 1280, height: 720 }
const DEFAULT_TIMEOUT = 30_000
const MAX_LOGS = 200
const MAX_NETWORK = 300

type Playwright = {
  chromium: {
    launchPersistentContext: (userDataDir: string, options: Record<string, unknown>) => Promise<BrowserContext>
  }
}

type BrowserConfig = {
  headless?: boolean
  viewport?: BrowserViewport
  timeoutMs?: number
  devtools?: boolean
}

type BrowserSessionRuntime = {
  context: BrowserContext
  page: Page
}

type ObserveResult = {
  text?: string
  role?: string
  tag: string
  selector?: string
  placeholder?: string
}

const trim = (value: string, max = 500) => (value.length > max ? `${value.slice(0, max)}...` : value)
const cap = <T>(items: T[], max: number) => {
  if (items.length <= max) return
  items.splice(0, items.length - max)
}

function normalizeUrl(input: string) {
  const value = input.trim()
  if (!value) throw new BrowserNavigationError("URL is required.")
  if (/^https?:\/\//i.test(value)) return value
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(:\d+)?(\/|$)/i.test(value)) return `http://${value}`
  if (/^[\w.-]+:\d+(\/|$)/.test(value)) return `http://${value}`
  throw new BrowserNavigationError("Invalid URL. Use http:// or https://, for example http://localhost:5173.")
}

function messageLocation(message: ConsoleMessage) {
  const loc = message.location()
  if (!loc.url) return
  return `${loc.url}:${loc.lineNumber}:${loc.columnNumber}`
}

function networkFailure(request: Request): BrowserNetworkEntry {
  return {
    method: request.method(),
    url: request.url(),
    resourceType: request.resourceType(),
    failed: true,
    errorText: request.failure()?.errorText,
    time: Date.now(),
  }
}

function networkResponse(response: Response): BrowserNetworkEntry {
  return {
    method: response.request().method(),
    url: response.url(),
    resourceType: response.request().resourceType(),
    status: response.status(),
    statusText: response.statusText(),
    failed: response.status() >= 400,
    time: Date.now(),
  }
}

async function loadPlaywright(): Promise<Playwright> {
  return import("playwright")
    .then((mod) => ({ chromium: mod.chromium }))
    .catch((error) => {
      throw new BrowserDependencyError(
        [
          "Playwright is required for the integrated browser but could not be loaded.",
          "Install dependencies with `bun install` from the repository root.",
          error instanceof Error ? error.message : String(error),
        ].join("\n"),
      )
    })
}

async function withLocator(
  page: Page,
  locators: Array<() => ReturnType<Page["locator"]>>,
  fn: (page: Page) => Promise<void>,
) {
  for (const make of locators) {
    const locator = make().first()
    const count = await locator.count().catch(() => 0)
    if (count === 0) continue
    await locator.click({ timeout: 5_000 })
    return
  }
  return fn(page)
}

function quoted(input: string) {
  return [...input.matchAll(/["'`](.+?)["'`]/g)].map((match) => match[1]).filter((item): item is string => !!item)
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export class BrowserSession {
  private runtime?: BrowserSessionRuntime
  private chain = Promise.resolve()
  private state: BrowserState

  constructor(
    readonly sessionID: string,
    private config: BrowserConfig,
  ) {
    this.state = {
      sessionID: sessionID as BrowserState["sessionID"],
      status: "idle",
      viewport: config.viewport ?? DEFAULT_VIEWPORT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      console: [],
      pageErrors: [],
      network: [],
      pages: [],
      initialized: false,
      stagehand: {
        available: false,
        enabled: false,
      },
    }
  }

  snapshot() {
    return {
      ...this.state,
      console: [...this.state.console],
      pageErrors: [...this.state.pageErrors],
      network: [...this.state.network],
      pages: [...this.state.pages],
    }
  }

  console(level?: "all" | "error" | "warning" | "info", limit = 50) {
    const entries = [...this.state.console, ...this.state.pageErrors]
    const filtered = level && level !== "all" ? entries.filter((entry) => entry.type === level) : entries
    return filtered.slice(-limit)
  }

  network(failedOnly = true, limit = 50) {
    const entries = failedOnly ? this.state.network.filter((entry) => entry.failed) : this.state.network
    return entries.slice(-limit)
  }

  enqueue<T>(fn: () => Promise<T>) {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async open(url: string, options: BrowserOpenOptions = {}) {
    return this.enqueue(async () => {
      return this.withActivity({ type: "open", label: url }, async () => {
        if (options.viewport) await this.setViewport(options.viewport)
        if (options.reset && this.runtime) await this.closeRuntime()

        const page = await this.page()
        const target = normalizeUrl(url)
        this.touch({ status: "loading", error: undefined })

        await page
          .goto(target, {
            waitUntil: options.waitUntil ?? "domcontentloaded",
            timeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT,
          })
          .catch((error) => {
            this.touch({ status: "error", error: error instanceof Error ? error.message : String(error) })
            throw new BrowserNavigationError(
              `Failed to open ${target}. ${error instanceof Error ? error.message : String(error)}`,
            )
          })

        await this.refreshState("ready")
        await this.captureScreenshot({})
        return this.snapshot()
      })
    })
  }

  async reload() {
    return this.enqueue(async () => {
      const page = this.activePage()
      this.touch({ status: "loading", error: undefined })
      await page.reload({ waitUntil: "domcontentloaded", timeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT })
      await this.refreshState("ready")
      await this.captureScreenshot({})
      return this.snapshot()
    })
  }

  async back() {
    return this.enqueue(async () => {
      const page = this.activePage()
      this.touch({ status: "loading", error: undefined })
      await page
        .goBack({ waitUntil: "domcontentloaded", timeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT })
        .catch(() => null)
      await this.refreshState("ready")
      await this.captureScreenshot({})
      return this.snapshot()
    })
  }

  async forward() {
    return this.enqueue(async () => {
      const page = this.activePage()
      this.touch({ status: "loading", error: undefined })
      await page
        .goForward({ waitUntil: "domcontentloaded", timeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT })
        .catch(() => null)
      await this.refreshState("ready")
      await this.captureScreenshot({})
      return this.snapshot()
    })
  }

  async screenshot(options: BrowserScreenshotOptions = {}) {
    return this.enqueue(async () => {
      return this.captureScreenshot(options)
    })
  }

  async resize(viewport: BrowserViewport) {
    return this.enqueue(async () => {
      await this.setViewport(viewport)
      if (this.runtime) await this.captureScreenshot({})
      return this.snapshot()
    })
  }

  async observe(instruction?: string, limit = 20) {
    const page = this.activePage()
    const items = await page.evaluate(
      (input) => {
        const wanted = input.instruction?.toLowerCase()
        return Array.from(
          document.querySelectorAll<HTMLElement>(
            "a,button,input,textarea,select,[role=button],[role=link],[role=menuitem],[contenteditable=true]",
          ),
        )
          .map((el) => {
            const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim()
            const placeholder = el.getAttribute("placeholder") || undefined
            const role = el.getAttribute("role") || undefined
            return {
              tag: el.tagName.toLowerCase(),
              text,
              role,
              placeholder,
              selector: el.id ? `#${CSS.escape(el.id)}` : undefined,
            }
          })
          .filter((item) => {
            if (!wanted) return true
            const haystack = [item.text, item.placeholder, item.role, item.tag].filter(Boolean).join(" ").toLowerCase()
            return (
              haystack.includes(wanted) ||
              wanted.split(/\s+/).some((word) => word.length > 2 && haystack.includes(word))
            )
          })
          .slice(0, input.limit)
      },
      { instruction, limit },
    )
    return items as ObserveResult[]
  }

  async act(instruction: string, options: BrowserActionOptions = {}) {
    return this.enqueue(async () => {
      return this.withActivity({ type: "act", label: instruction }, async () => {
        const page = this.activePage()
        const timeout = options.timeoutMs ?? 10_000
        page.setDefaultTimeout(timeout)

        const lower = instruction.toLowerCase()
        const values = quoted(instruction)
        const target =
          values[0] ?? instruction.replace(/^(click|press|tap|choose|select|fill|type|enter)\s+/i, "").trim()
        const second = values[1]

        if (/^(fill|type|enter)\b/i.test(lower)) {
          const value = second ?? values[0]
          const field = second
            ? values[0]
            : instruction
                .replace(/^.*?\b(into|in|on)\s+/i, "")
                .replace(/["'`].+?["'`]/, "")
                .trim()
          if (!value) throw new Error("browser_act could not find text to enter. Quote the value to type.")
          const locator = page
            .getByLabel(new RegExp(escapeRegExp(field || target), "i"))
            .or(page.getByPlaceholder(new RegExp(escapeRegExp(field || target), "i")))
            .or(page.locator("input,textarea,[contenteditable=true]").first())
            .first()
          await locator.fill(value, { timeout })
        } else {
          await withLocator(
            page,
            [
              () => page.getByRole("button", { name: new RegExp(escapeRegExp(target), "i") }),
              () => page.getByRole("link", { name: new RegExp(escapeRegExp(target), "i") }),
              () => page.getByText(new RegExp(escapeRegExp(target), "i")),
              () => page.locator(target),
            ],
            () => {
              throw new Error(
                "browser_act could not identify the target. Try browser_observe first, then use a more specific quoted label or CSS selector.",
              )
            },
          )
        }

        await this.refreshState("ready")
        if (options.takeScreenshot !== false) await this.captureScreenshot({})
        return this.snapshot()
      })
    })
  }

  async click(x: number, y: number) {
    return this.enqueue(async () => {
      return this.withActivity({ type: "click", label: `${Math.round(x)}, ${Math.round(y)}` }, async () => {
        const page = this.activePage()
        await page.mouse.click(
          Math.max(0, Math.min(this.state.viewport.width, Math.round(x))),
          Math.max(0, Math.min(this.state.viewport.height, Math.round(y))),
        )
        await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => undefined)
        await this.refreshState("ready")
        await this.captureScreenshot({})
        return this.snapshot()
      })
    })
  }

  async extract(instruction: string, _schema?: unknown, options: BrowserExtractOptions = {}) {
    const page = this.activePage()
    const result = await page.evaluate((query) => {
      const visible = (document.body?.innerText ?? "").replace(/\s+\n/g, "\n").trim()
      const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
        .map((el) => ({ tag: el.tagName.toLowerCase(), text: (el.textContent ?? "").trim() }))
        .filter((item) => item.text)
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
        .map((el) => ({ text: (el.innerText || el.textContent || "").trim(), href: el.href }))
        .filter((item) => item.text || item.href)
        .slice(0, 50)
      const forms = Array.from(document.querySelectorAll("input,textarea,select")).map((el) => ({
        tag: el.tagName.toLowerCase(),
        name: el.getAttribute("name") || undefined,
        label: el.getAttribute("aria-label") || el.getAttribute("placeholder") || undefined,
        value: "value" in el ? String(el.value) : undefined,
      }))
      return {
        instruction: query,
        title: document.title,
        url: location.href,
        text: visible.slice(0, 12_000),
        headings,
        links,
        forms,
      }
    }, instruction)
    if (options.takeScreenshot) await this.captureScreenshot({})
    await this.refreshState("ready")
    return result
  }

  async evaluate(script: string) {
    const page = this.activePage()
    const result = await page.evaluate((source) => {
      return globalThis.eval(source)
    }, script)
    await this.refreshState("ready")
    return result
  }

  async close() {
    return this.enqueue(async () => {
      await this.closeRuntime()
      this.touch({ status: "closed", initialized: false, pages: [], url: undefined, title: undefined })
      return this.snapshot()
    })
  }

  private activePage() {
    if (!this.runtime || this.runtime.page.isClosed()) {
      this.touch({ status: "closed", initialized: false })
      throw new BrowserNotInitializedError()
    }
    return this.runtime.page
  }

  private async page() {
    if (this.runtime && !this.runtime.page.isClosed()) return this.runtime.page

    const playwright = await loadPlaywright()
    const context = await playwright.chromium
      .launchPersistentContext(await ensureProfileDir(this.sessionID), {
        headless: this.config.headless ?? true,
        viewport: this.state.viewport,
        ignoreHTTPSErrors: true,
        bypassCSP: false,
      })
      .catch((error) => {
        throw new BrowserDependencyError(
          [
            "Chromium could not be started for the integrated browser.",
            "Install the Playwright browser with `bunx playwright install chromium`.",
            error instanceof Error ? error.message : String(error),
          ].join("\n"),
        )
      })

    const page = context.pages()[0] ?? (await context.newPage())
    this.runtime = { context, page }
    this.watch(context, page)
    this.touch({ initialized: true, status: "idle" })
    return page
  }

  private async setViewport(viewport: BrowserViewport) {
    const next = {
      width: Math.max(320, Math.min(3840, Math.round(viewport.width))),
      height: Math.max(240, Math.min(2400, Math.round(viewport.height))),
    }
    this.touch({ viewport: next })
    if (this.runtime && !this.runtime.page.isClosed()) await this.runtime.page.setViewportSize(next)
  }

  private async captureScreenshot(options: BrowserScreenshotOptions) {
    const page = this.activePage()
    const shot = await screenshotPath(this.sessionID, options)
    await page.screenshot({
      path: shot.path,
      fullPage: options.fullPage ?? false,
      type: shot.format,
      ...(shot.format === "jpeg" && options.quality ? { quality: options.quality } : {}),
    })
    this.touch({
      latestScreenshot: screenshotArtifact({
        id: shot.id,
        path: shot.path,
        format: shot.format,
        viewport: this.state.viewport,
      }),
    })
    await this.refreshState("ready")
    return this.state.latestScreenshot
  }

  private async closeRuntime() {
    const runtime = this.runtime
    this.runtime = undefined
    if (runtime) await runtime.context.close().catch(() => undefined)
  }

  private watch(context: BrowserContext, page: Page) {
    const register = (p: Page) => {
      p.on("console", (message) => {
        this.state.console.push({
          type: message.type() === "warning" ? "warning" : message.type(),
          text: trim(message.text(), 2_000),
          location: messageLocation(message),
          time: Date.now(),
        })
        cap(this.state.console, MAX_LOGS)
      })
      p.on("pageerror", (error) => {
        this.state.pageErrors.push({
          type: "error",
          text: trim(error.message, 2_000),
          time: Date.now(),
        })
        cap(this.state.pageErrors, MAX_LOGS)
      })
      p.on("requestfailed", (request) => {
        this.state.network.push(networkFailure(request))
        cap(this.state.network, MAX_NETWORK)
      })
      p.on("response", (response) => {
        if (response.status() < 400) return
        this.state.network.push(networkResponse(response))
        cap(this.state.network, MAX_NETWORK)
      })
      p.on("framenavigated", () => {
        this.touch({ url: p.url(), status: "loading" })
      })
      p.on("load", () => {
        void this.refreshState("ready")
      })
      p.on("close", () => {
        if (this.runtime?.page !== p) return
        this.touch({ status: "closed", initialized: false })
      })
    }

    register(page)
    context.on("page", (next) => {
      this.runtime = { context, page: next }
      register(next)
      void this.refreshState("ready")
    })
  }

  private async refreshState(status: BrowserState["status"]) {
    const page = this.runtime?.page
    if (!page || page.isClosed()) {
      this.touch({ status: "closed", initialized: false })
      return
    }
    const title = await page.title().catch(() => undefined)
    this.touch({
      status,
      url: page.url(),
      title,
      pages:
        this.runtime?.context.pages().map((item) => ({ url: item.url(), title: item === page ? title : undefined })) ??
        [],
    })
  }

  private touch(patch: Partial<BrowserState>) {
    this.state = {
      ...this.state,
      ...patch,
      lastUsedAt: Date.now(),
    }
  }

  private async withActivity<T>(
    activity: Omit<NonNullable<BrowserState["activity"]>, "startedAt">,
    fn: () => Promise<T>,
  ) {
    this.touch({ activity: { ...activity, startedAt: Date.now() } })
    return fn().finally(() => {
      this.touch({ activity: undefined })
    })
  }
}
