export class BrowserUnavailableError extends Error {
  constructor(message = "The integrated browser is not available in this runtime.") {
    super(message)
    this.name = "BrowserUnavailableError"
  }
}

export class BrowserNotInitializedError extends Error {
  constructor(message = "No browser page is open for this session. Open a URL first with browser_open.") {
    super(message)
    this.name = "BrowserNotInitializedError"
  }
}

export class BrowserDependencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BrowserDependencyError"
  }
}

export class BrowserNavigationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BrowserNavigationError"
  }
}
