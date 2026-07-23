/**
 * Shared lifecycle context for request tracking and readiness state.
 * Services use this to implement /healthz (liveness) and /readyz (readiness) endpoints.
 */

export interface LifecycleContext {
  /** True if the server is ready to accept requests */
  readonly isReady: boolean;
  /** Count of active in-flight requests */
  readonly activeRequests: number;
  /** Set readiness state */
  setReady: (ready: boolean) => void;
  /** Track a request (call at start of request) */
  trackRequest: () => void;
  /** Untrack a request (call at end of request) */
  untrackRequest: () => void;
}

/**
 * Create a lifecycle context for tracking active requests and readiness.
 */
export function createLifecycleContext(): LifecycleContext {
  let activeRequests = 0;
  let isReady = false;

  return {
    get isReady() { return isReady; },
    get activeRequests() { return activeRequests; },
    setReady(v: boolean) { isReady = v; },
    trackRequest() { activeRequests++; },
    untrackRequest() { if (activeRequests > 0) activeRequests--; },
  };
}
