import type { FetchResult } from 'vite/module-runner'
import type { FSWatcher } from 'dep-types/chokidar'
import colors from 'picocolors'
import { BaseEnvironment } from '../baseEnvironment'
import { ERR_OUTDATED_OPTIMIZED_DEP } from '../plugins/optimizedDeps'
import type {
  EnvironmentOptions,
  ResolvedConfig,
  ResolvedEnvironmentOptions,
} from '../config'
import { getDefaultResolvedEnvironmentOptions } from '../config'
import { mergeConfig, promiseWithResolvers } from '../utils'
import type { FetchModuleOptions } from '../ssr/fetchModule'
import { fetchModule } from '../ssr/fetchModule'
import {
  createDepsOptimizer,
  createExplicitDepsOptimizer,
} from '../optimizer/optimizer'
import { resolveEnvironmentPlugins } from '../plugin'
import type { DepsOptimizer } from '../optimizer'
import { EnvironmentModuleGraph } from './moduleGraph'
import type { HotChannel } from './hmr'
import { createNoopHMRChannel, getShortName, updateModules } from './hmr'
import type { TransformResult } from './transformRequest'
import { transformRequest } from './transformRequest'
import type { EnvironmentPluginContainer } from './pluginContainer'
import {
  ERR_CLOSED_SERVER,
  createEnvironmentPluginContainer,
} from './pluginContainer'
import type { RemoteEnvironmentTransport } from './environmentTransport'

export interface DevEnvironmentSetup {
  hot: false | HotChannel
  watcher?: FSWatcher
  options?: EnvironmentOptions
  runner?: FetchModuleOptions & {
    transport?: RemoteEnvironmentTransport
  }
  depsOptimizer?: DepsOptimizer
}

export class DevEnvironment extends BaseEnvironment {
  mode = 'dev' as const // TODO: should this be 'serve'?
  moduleGraph: EnvironmentModuleGraph

  watcher?: FSWatcher
  depsOptimizer?: DepsOptimizer
  /**
   * @internal
   */
  _ssrRunnerOptions: FetchModuleOptions | undefined

  get pluginContainer(): EnvironmentPluginContainer {
    if (!this._pluginContainer)
      throw new Error(
        `${this.name} environment.pluginContainer called before initialized`,
      )
    return this._pluginContainer
  }
  /**
   * @internal
   */
  _pluginContainer: EnvironmentPluginContainer | undefined

  /**
   * TODO: should this be public?
   * @internal
   */
  _closing: boolean = false
  /**
   * @internal
   */
  _pendingRequests: Map<
    string,
    {
      request: Promise<TransformResult | null>
      timestamp: number
      abort: () => void
    }
  >
  /**
   * @internal
   */
  _onCrawlEndCallbacks: (() => void)[]
  /**
   * @internal
   */
  _crawlEndFinder: CrawlEndFinder

  /**
   * Hot channel for this environment. If not provided or disabled,
   * it will be a noop channel that does nothing.
   *
   * @example
   * environment.hot.send({ type: 'full-reload' })
   */
  hot: HotChannel
  constructor(
    name: string,
    config: ResolvedConfig,
    setup: DevEnvironmentSetup,
  ) {
    let options =
      config.environments[name] ?? getDefaultResolvedEnvironmentOptions(config)
    if (setup?.options) {
      options = mergeConfig(
        options,
        setup?.options,
      ) as ResolvedEnvironmentOptions
    }
    super(name, config, options)

    this._pendingRequests = new Map()

    this.moduleGraph = new EnvironmentModuleGraph(name, (url: string) =>
      this.pluginContainer!.resolveId(url, undefined),
    )

    this.hot = setup?.hot || createNoopHMRChannel()
    this.watcher = setup?.watcher

    this._onCrawlEndCallbacks = []
    this._crawlEndFinder = setupOnCrawlEnd(() => {
      this._onCrawlEndCallbacks.forEach((cb) => cb())
    })

    this._ssrRunnerOptions = setup?.runner || {}
    setup?.runner?.transport?.register(this)

    this.hot.on('vite:invalidate', async ({ path, message }) => {
      invalidateModule(this, {
        path,
        message,
      })
    })

    const { optimizeDeps } = this.options.dev
    if (setup?.depsOptimizer) {
      this.depsOptimizer = setup?.depsOptimizer
    } else if (
      optimizeDeps?.noDiscovery &&
      optimizeDeps?.include?.length === 0
    ) {
      this.depsOptimizer = undefined
    } else {
      // We only support auto-discovery for the client environment, for all other
      // environments `noDiscovery` has no effect and a simpler explicit deps
      // optimizer is used that only optimizes explicitly included dependencies
      // so it doesn't need to reload the environment. Now that we have proper HMR
      // and full reload for general environments, we can enable autodiscovery for
      // them in the future
      this.depsOptimizer = (
        optimizeDeps.noDiscovery || name !== 'client'
          ? createExplicitDepsOptimizer
          : createDepsOptimizer
      )(this)
    }
  }

  async init(): Promise<void> {
    if (this._initiated) {
      return
    }
    this._initiated = true
    this._plugins = await resolveEnvironmentPlugins(this)
    this._pluginContainer = await createEnvironmentPluginContainer(
      this,
      this._plugins,
    )

    // TODO: Should buildStart be called here? It break backward compatibility if we do,
    // and it may be better to delay it for performance

    // The deps optimizer init is delayed. TODO: add internal option?

    // TODO: move warmup here
  }

  fetchModule(id: string, importer?: string): Promise<FetchResult> {
    return fetchModule(this, id, importer, this._ssrRunnerOptions)
  }

  transformRequest(url: string): Promise<TransformResult | null> {
    return transformRequest(this, url)
  }

  async warmupRequest(url: string): Promise<void> {
    await transformRequest(this, url).catch((e) => {
      if (
        e?.code === ERR_OUTDATED_OPTIMIZED_DEP ||
        e?.code === ERR_CLOSED_SERVER
      ) {
        // these are expected errors
        return
      }
      // Unexpected error, log the issue but avoid an unhandled exception
      this.logger.error(`Pre-transform error: ${e.message}`, {
        error: e,
        timestamp: true,
      })
    })
  }

  async close(): Promise<void> {
    this._closing = true

    this.hot.close()
    this._crawlEndFinder?.cancel()
    await Promise.allSettled([
      this.pluginContainer.close(),
      this.depsOptimizer?.close(),
      (async () => {
        while (this._pendingRequests.size > 0) {
          await Promise.allSettled(
            [...this._pendingRequests.values()].map(
              (pending) => pending.request,
            ),
          )
        }
      })(),
    ])
  }

  /**
   * Calling `await environment.waitForRequestsIdle(id)` will wait until all static imports
   * are processed after the first transformRequest call. If called from a load or transform
   * plugin hook, the id needs to be passed as a parameter to avoid deadlocks.
   * Calling this function after the first static imports section of the module graph has been
   * processed will resolve immediately.
   * @experimental
   */
  waitForRequestsIdle(ignoredId?: string): Promise<void> {
    return this._crawlEndFinder.waitForRequestsIdle(ignoredId)
  }

  /**
   * @internal
   */
  _registerRequestProcessing(id: string, done: () => Promise<unknown>): void {
    this._crawlEndFinder.registerRequestProcessing(id, done)
  }
  /**
   * @internal
   * TODO: use waitForRequestsIdle in the optimizer instead of this function
   */
  _onCrawlEnd(cb: () => void): void {
    this._onCrawlEndCallbacks.push(cb)
  }
}

function invalidateModule(
  environment: DevEnvironment,
  m: {
    path: string
    message?: string
  },
) {
  const mod = environment.moduleGraph.urlToModuleMap.get(m.path)
  if (
    mod &&
    mod.isSelfAccepting &&
    mod.lastHMRTimestamp > 0 &&
    !mod.lastHMRInvalidationReceived
  ) {
    mod.lastHMRInvalidationReceived = true
    environment.logger.info(
      colors.yellow(`hmr invalidate `) +
        colors.dim(m.path) +
        (m.message ? ` ${m.message}` : ''),
      { timestamp: true },
    )
    const file = getShortName(mod.file!, environment.config.root)
    updateModules(
      environment,
      file,
      [...mod.importers],
      mod.lastHMRTimestamp,
      true,
    )
  }
}

const callCrawlEndIfIdleAfterMs = 50

interface CrawlEndFinder {
  registerRequestProcessing: (id: string, done: () => Promise<any>) => void
  waitForRequestsIdle: (ignoredId?: string) => Promise<void>
  cancel: () => void
}

function setupOnCrawlEnd(onCrawlEnd: () => void): CrawlEndFinder {
  const registeredIds = new Set<string>()
  const seenIds = new Set<string>()
  const onCrawlEndPromiseWithResolvers = promiseWithResolvers<void>()

  let timeoutHandle: NodeJS.Timeout | undefined

  let cancelled = false
  function cancel() {
    cancelled = true
  }

  let crawlEndCalled = false
  function callOnCrawlEnd() {
    if (!cancelled && !crawlEndCalled) {
      crawlEndCalled = true
      onCrawlEnd()
    }
    onCrawlEndPromiseWithResolvers.resolve()
  }

  function registerRequestProcessing(
    id: string,
    done: () => Promise<any>,
  ): void {
    if (!seenIds.has(id)) {
      seenIds.add(id)
      registeredIds.add(id)
      done()
        .catch(() => {})
        .finally(() => markIdAsDone(id))
    }
  }

  function waitForRequestsIdle(ignoredId?: string): Promise<void> {
    if (ignoredId) {
      seenIds.add(ignoredId)
      markIdAsDone(ignoredId)
    }
    return onCrawlEndPromiseWithResolvers.promise
  }

  function markIdAsDone(id: string): void {
    if (registeredIds.has(id)) {
      registeredIds.delete(id)
      checkIfCrawlEndAfterTimeout()
    }
  }

  function checkIfCrawlEndAfterTimeout() {
    if (cancelled || registeredIds.size > 0) return

    if (timeoutHandle) clearTimeout(timeoutHandle)
    timeoutHandle = setTimeout(
      callOnCrawlEndWhenIdle,
      callCrawlEndIfIdleAfterMs,
    )
  }
  async function callOnCrawlEndWhenIdle() {
    if (cancelled || registeredIds.size > 0) return
    callOnCrawlEnd()
  }

  return {
    registerRequestProcessing,
    waitForRequestsIdle,
    cancel,
  }
}
