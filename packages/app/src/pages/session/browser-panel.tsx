import { For, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { createSizing } from "@/pages/session/helpers"
import { useSessionLayout } from "@/pages/session/session-layout"

type BrowserScreenshot = {
  id: string
  path: string
  mime: string
  createdAt: number
}

type BrowserState = {
  sessionID: string
  url?: string
  title?: string
  status: "idle" | "loading" | "ready" | "error" | "closed"
  error?: string
  activity?: { type: string; label?: string; startedAt: number }
  viewport: { width: number; height: number }
  latestScreenshot?: BrowserScreenshot
  console: Array<{ type: string; text: string; time: number }>
  pageErrors: Array<{ type: string; text: string; time: number }>
  network: Array<{ url: string; status?: number; failed: boolean; errorText?: string; time: number }>
  createdAt: number
  lastUsedAt: number
  initialized: boolean
  stagehand: { available: boolean; enabled: boolean }
}

const emptyState = (sessionID: string): BrowserState => ({
  sessionID,
  status: "idle",
  viewport: { width: 1280, height: 720 },
  console: [],
  pageErrors: [],
  network: [],
  createdAt: Date.now(),
  lastUsedAt: Date.now(),
  initialized: false,
  stagehand: { available: false, enabled: false },
})

export function BrowserPanel() {
  const layout = useLayout()
  const platform = usePlatform()
  const server = useServer()
  const sdk = useSDK()
  const { params, view } = useSessionLayout()
  const sizing = createSizing()

  let screenshotUrl: string | undefined
  let lastPreviewCapture = 0
  let wasOpened = false
  const [store, setStore] = createStore({
    state: undefined as BrowserState | undefined,
    url: "",
    busy: false,
    error: undefined as string | undefined,
    screenshot: undefined as string | undefined,
    screenshotID: undefined as string | undefined,
    autoOpenedMarker: undefined as string | undefined,
    userClosedMarker: undefined as string | undefined,
  })

  const sessionID = createMemo(() => params.id)
  const opened = createMemo(() => !!sessionID() && view().browser.opened())
  const width = createMemo(() => layout.browser.width())
  const state = createMemo(() => store.state ?? emptyState(sessionID() ?? ""))
  const errors = createMemo(() =>
    [...state().pageErrors, ...state().console.filter((entry) => entry.type === "error")].slice(-4),
  )
  const network = createMemo(() =>
    state()
      .network.filter((entry) => entry.failed)
      .slice(-4),
  )
  const loading = createMemo(() => store.busy || state().status === "loading" || !!state().activity)
  const marker = (next = state()) =>
    next.latestScreenshot?.id ?? (next.initialized ? `${next.url}:${next.lastUsedAt}` : undefined)

  const headers = (contentType?: string) => {
    const headers = new Headers()
    headers.set("x-opencode-directory", encodeURIComponent(sdk.directory))
    if (contentType) headers.set("content-type", contentType)
    const current = server.current
    if (current?.http.password) {
      headers.set("authorization", `Basic ${btoa(`${current.http.username ?? "opencode"}:${current.http.password}`)}`)
    }
    return headers
  }

  const request = async <T,>(path: string, init?: RequestInit & { json?: unknown }) => {
    const current = server.current
    if (!current) throw new Error("No server available")
    const response = await (platform.fetch ?? fetch)(`${current.http.url}${path}`, {
      ...init,
      headers: headers(init?.json === undefined ? undefined : "application/json"),
      body: init?.json === undefined ? init?.body : JSON.stringify(init.json),
    })
    if (!response.ok) throw new Error(await response.text())
    return (await response.json()) as T
  }

  const loadScreenshot = async (id: string) => {
    const current = server.current
    if (!current) return
    const response = await (platform.fetch ?? fetch)(
      `${current.http.url}/browser/${sessionID()}/screenshot?version=${encodeURIComponent(id)}`,
      {
        headers: headers(),
      },
    )
    if (!response.ok) return
    const next = URL.createObjectURL(await response.blob())
    if (screenshotUrl) URL.revokeObjectURL(screenshotUrl)
    screenshotUrl = next
    setStore({ screenshot: next, screenshotID: id })
  }

  const refreshState = async () => {
    const id = sessionID()
    if (!id) return
    const next = await request<BrowserState>(`/browser/${id}/state`)
    setStore("state", next)
    setStore("error", undefined)
    const screenshot = next.latestScreenshot
    if (screenshot && screenshot.id !== store.screenshotID) await loadScreenshot(screenshot.id)
    if (!store.url && next.url) setStore("url", next.url)
    const activeMarker = marker(next)
    if (
      !opened() &&
      activeMarker &&
      activeMarker !== store.userClosedMarker &&
      activeMarker !== store.autoOpenedMarker
    ) {
      setStore("autoOpenedMarker", activeMarker)
      view().browser.open()
    }
    return next
  }

  const run = async (fn: () => Promise<BrowserState | BrowserScreenshot | undefined>) => {
    if (store.busy) return
    setStore({ busy: true, error: undefined })
    await fn()
      .then(() => refreshState())
      .catch((error) => setStore("error", error instanceof Error ? error.message : String(error)))
      .finally(() => setStore("busy", false))
  }

  const open = () => {
    const id = sessionID()
    const url = store.url.trim()
    if (!id || !url) return
    void run(() => request<BrowserState>(`/browser/${id}/open`, { method: "POST", json: { url } }))
  }

  const action = (name: "reload" | "back" | "forward" | "close" | "screenshot") => {
    const id = sessionID()
    if (!id) return
    void run(() => request(`/browser/${id}/${name}`, { method: "POST", json: {} }))
  }

  const clickPreview = (event: MouseEvent & { currentTarget: HTMLImageElement }) => {
    const id = sessionID()
    if (!id || !state().initialized || store.busy) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * state().viewport.width
    const y = ((event.clientY - rect.top) / rect.height) * state().viewport.height
    void run(() => request<BrowserState>(`/browser/${id}/click`, { method: "POST", json: { x, y } }))
  }

  createEffect(() => {
    const activeMarker = marker()
    if (wasOpened && !opened()) setStore("userClosedMarker", activeMarker)
    wasOpened = opened()
  })

  createEffect(() => {
    if (!sessionID()) return
    const delay = opened() ? (loading() ? 300 : 700) : 1500
    const tick = async () => {
      const next = await refreshState()
      if (!next || !opened() || !next.initialized || store.busy) return
      if (Date.now() - lastPreviewCapture < 1200) return
      if (next.activity) return
      lastPreviewCapture = Date.now()
      await request<BrowserScreenshot>(`/browser/${next.sessionID}/screenshot`, { method: "POST", json: {} }).catch(
        () => undefined,
      )
    }
    void tick().catch((error) => setStore("error", error instanceof Error ? error.message : String(error)))
    const interval = setInterval(() => {
      void tick().catch(() => undefined)
    }, delay)
    onCleanup(() => clearInterval(interval))
  })

  onCleanup(() => {
    if (screenshotUrl) URL.revokeObjectURL(screenshotUrl)
  })

  return (
    <aside
      id="browser-panel"
      aria-label="Integrated browser"
      aria-hidden={!opened()}
      inert={!opened()}
      class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
      classList={{
        "pointer-events-none": !opened(),
        "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
          !sizing.active(),
      }}
      style={{ width: opened() ? `${width()}px` : "0px" }}
    >
      <div class="hidden md:block" onPointerDown={() => sizing.start()}>
        <ResizeHandle
          direction="horizontal"
          size={width()}
          min={420}
          max={typeof window === "undefined" ? 900 : window.innerWidth * 0.6}
          onResize={(next) => {
            sizing.touch()
            layout.browser.resize(next)
          }}
          onCollapse={() => view().browser.close()}
        />
      </div>
      <div class="size-full min-w-0 flex flex-col border-l border-border-weaker-base bg-background-base">
        <div class="h-10 shrink-0 flex items-center gap-1 px-2 border-b border-border-weaker-base bg-background-stronger">
          <Tooltip value="Back">
            <IconButton
              icon="chevron-left"
              variant="ghost"
              class="size-7"
              disabled={!state().initialized || store.busy}
              onClick={() => action("back")}
            />
          </Tooltip>
          <Tooltip value="Forward">
            <IconButton
              icon="chevron-right"
              variant="ghost"
              class="size-7"
              disabled={!state().initialized || store.busy}
              onClick={() => action("forward")}
            />
          </Tooltip>
          <Tooltip value="Reload">
            <IconButton
              icon="reset"
              variant="ghost"
              class="size-7"
              disabled={!state().initialized || store.busy}
              onClick={() => action("reload")}
            />
          </Tooltip>
          <form
            class="min-w-0 flex-1 flex items-center"
            onSubmit={(event) => {
              event.preventDefault()
              open()
            }}
          >
            <input
              class="w-full h-7 rounded-md border border-border-weak-base bg-surface-panel px-2 text-12-regular text-text-base outline-none focus:border-border-strong-base"
              value={store.url}
              placeholder="http://localhost:5173"
              onInput={(event) => setStore("url", event.currentTarget.value)}
            />
          </form>
          <Tooltip value="Capture screenshot">
            <IconButton
              icon="photo"
              variant="ghost"
              class="size-7"
              disabled={!state().initialized || store.busy}
              onClick={() => action("screenshot")}
            />
          </Tooltip>
          <Tooltip value="Close browser">
            <IconButton
              icon="close"
              variant="ghost"
              class="size-7"
              disabled={store.busy}
              onClick={() => action("close")}
            />
          </Tooltip>
        </div>

        <div class="min-h-0 flex-1 flex flex-col">
          <div class="shrink-0 px-3 py-2 border-b border-border-weaker-base flex items-center gap-2">
            <Show when={loading()}>
              <Spinner class="size-3.5 text-icon-weak" />
            </Show>
            <div class="min-w-0 flex-1">
              <div class="text-12-regular text-text-base truncate">{state().title || state().url || "Browser"}</div>
              <div class="text-11-regular text-text-weak truncate">
                {state().url || "Open a page manually or ask the agent to use browser_open."}
              </div>
            </div>
            <div class="hidden lg:flex items-center gap-2 shrink-0">
              <Show when={state().activity}>
                {(activity) => (
                  <div class="max-w-40 truncate rounded-[6px] border border-border-weaker-base bg-surface-panel px-2 py-1 text-11-regular text-text-weak">
                    {activity().type}: {activity().label ?? "working"}
                  </div>
                )}
              </Show>
              <div class="text-11-regular text-text-weak">
                {state().viewport.width}x{state().viewport.height}
              </div>
            </div>
          </div>

          <div class="relative min-h-0 flex-1 overflow-auto bg-background-stronger">
            <Show
              when={store.screenshot}
              fallback={
                <div class="h-full flex items-center justify-center px-8 text-center">
                  <div class="max-w-[340px] flex flex-col gap-2">
                    <div class="text-13-medium text-text-base">Browser panel ready</div>
                    <div class="text-12-regular text-text-weak">
                      Open a local app URL here or ask the agent to use browser_open. The live preview will appear here
                      and stay synced with browser tools.
                    </div>
                  </div>
                </div>
              }
            >
              {(src) => (
                <div class="min-h-full p-3 flex items-start justify-center">
                  <div class="relative w-full overflow-hidden rounded-[6px] border border-border-weaker-base bg-background-base shadow-xs-border">
                    <img
                      src={src()}
                      alt="Integrated browser live preview"
                      class="block w-full h-auto cursor-crosshair select-none bg-background-base"
                      draggable={false}
                      onClick={clickPreview}
                    />
                    <Show when={loading()}>
                      <div class="absolute left-2 top-2 flex items-center gap-1.5 rounded-[6px] border border-border-weaker-base bg-background-base/90 px-2 py-1 text-11-regular text-text-weak backdrop-blur-sm">
                        <Spinner class="size-3 text-icon-weak" />
                        {state().activity?.label ?? "Updating browser"}
                      </div>
                    </Show>
                  </div>
                </div>
              )}
            </Show>
          </div>

          <Show when={store.error || state().error || errors().length > 0 || network().length > 0}>
            <div class="max-h-36 overflow-auto border-t border-border-weaker-base bg-background-base px-3 py-2">
              <Show when={store.error || state().error}>
                <div class="text-12-regular text-text-error break-words">{store.error || state().error}</div>
              </Show>
              <For each={errors()}>
                {(entry) => <div class="text-11-regular text-text-error break-words">{entry.text}</div>}
              </For>
              <For each={network()}>
                {(entry) => (
                  <div class="text-11-regular text-text-weak break-all">
                    <Icon name="warning" size="small" class="inline text-icon-warning" /> {entry.status ?? "failed"}{" "}
                    {entry.url}
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </aside>
  )
}
