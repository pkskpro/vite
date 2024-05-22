/**
 * This file is refactored into TypeScript based on
 * https://github.com/preactjs/wmr/blob/main/packages/wmr/src/lib/rollup-plugin-container.js
 */

/**
https://github.com/preactjs/wmr/blob/master/LICENSE

MIT License

Copyright (c) 2020 The Preact Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import fs from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseAst as rollupParseAst } from 'rollup/parseAst'
import type {
  AsyncPluginHooks,
  CustomPluginOptions,
  EmittedFile,
  FunctionPluginHooks,
  InputOptions,
  LoadResult,
  MinimalPluginContext,
  ModuleInfo,
  ModuleOptions,
  NormalizedInputOptions,
  OutputOptions,
  ParallelPluginHooks,
  PartialNull,
  PartialResolvedId,
  ResolvedId,
  RollupError,
  RollupLog,
  PluginContext as RollupPluginContext,
  SourceDescription,
  SourceMap,
  TransformResult,
} from 'rollup'
import type { RawSourceMap } from '@ampproject/remapping'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import MagicString from 'magic-string'
import type { FSWatcher } from 'chokidar'
import colors from 'picocolors'
import type { EnvironmentPlugin, Plugin } from '../plugin'
import {
  combineSourcemaps,
  createDebugger,
  ensureWatchedFile,
  generateCodeFrame,
  isExternalUrl,
  isObject,
  normalizePath,
  numberToPos,
  prettifyUrl,
  rollupVersion,
  timeFrom,
} from '../utils'
import { FS_PREFIX } from '../constants'
import { createPluginHookUtils, getHookHandler } from '../plugins'
import { cleanUrl, unwrapId } from '../../shared/utils'
import type { Environment } from '../environment'
import type { DevEnvironment } from './environment'
import { buildErrorMessage } from './middlewares/error'
import type { EnvironmentModuleNode } from './moduleGraph'

const noop = () => {}

export const ERR_CLOSED_SERVER = 'ERR_CLOSED_SERVER'

export function throwClosedServerError(): never {
  const err: any = new Error(
    'The server is being restarted or closed. Request is outdated',
  )
  err.code = ERR_CLOSED_SERVER
  // This error will be caught by the transform middleware that will
  // send a 504 status code request timeout
  throw err
}

export interface PluginContainerOptions {
  cwd?: string
  output?: OutputOptions
  modules?: Map<string, { info: ModuleInfo }>
  writeFile?: (name: string, source: string | Uint8Array) => void
}

export interface EnvironmentPluginContainer {
  options: InputOptions
  buildStart(options: InputOptions): Promise<void>
  resolveId(
    id: string,
    importer: string | undefined,
    options?: {
      attributes?: Record<string, string>
      custom?: CustomPluginOptions
      skip?: Set<Plugin>
      /**
       * @internal
       */
      scan?: boolean
      isEntry?: boolean
    },
  ): Promise<PartialResolvedId | null>
  transform(
    code: string,
    id: string,
    options?: {
      inMap?: SourceDescription['map']
    },
  ): Promise<{ code: string; map: SourceMap | { mappings: '' } | null }>
  load(id: string, options?: {}): Promise<LoadResult | null>
  watchChange(
    id: string,
    change: { event: 'create' | 'update' | 'delete' },
  ): Promise<void>
  close(): Promise<void>
}

type PluginContext = Omit<
  RollupPluginContext,
  // not documented
  'cache'
>

/**
 * Create a plugin container with a set of plugins. We pass them as a parameter
 * instead of using environment.plugins to allow the creation of different
 * pipelines working with the same environment (used for createIdResolver).
 */
export async function createEnvironmentPluginContainer(
  environment: Environment,
  plugins: EnvironmentPlugin[],
  watcher?: FSWatcher,
): Promise<EnvironmentPluginContainer> {
  const {
    config,
    logger,
    options: {
      build: { rollupOptions },
    },
  } = environment
  const { root } = config

  // Backward compatibility
  const ssr = environment.name !== 'client'

  const moduleGraph =
    environment.mode === 'dev' ? environment.moduleGraph : undefined

  const { getSortedPluginHooks, getSortedPlugins } =
    createPluginHookUtils(plugins)

  const seenResolves: Record<string, true | undefined> = {}
  const debugResolve = createDebugger('vite:resolve')
  const debugPluginResolve = createDebugger('vite:plugin-resolve', {
    onlyWhenFocused: 'vite:plugin',
  })
  const debugPluginTransform = createDebugger('vite:plugin-transform', {
    onlyWhenFocused: 'vite:plugin',
  })
  const debugSourcemapCombineFilter =
    process.env.DEBUG_VITE_SOURCEMAP_COMBINE_FILTER
  const debugSourcemapCombine = createDebugger('vite:sourcemap-combine', {
    onlyWhenFocused: true,
  })

  // ---------------------------------------------------------------------------

  const watchFiles = new Set<string>()
  // _addedFiles from the `load()` hook gets saved here so it can be reused in the `transform()` hook
  const moduleNodeToLoadAddedImports = new WeakMap<
    EnvironmentModuleNode,
    Set<string> | null
  >()

  const minimalContext: MinimalPluginContext = {
    meta: {
      rollupVersion,
      watchMode: true,
    },
    debug: noop,
    info: noop,
    warn: noop,
    // @ts-expect-error noop
    error: noop,
  }

  function warnIncompatibleMethod(method: string, plugin: string) {
    logger.warn(
      colors.cyan(`[plugin:${plugin}] `) +
        colors.yellow(
          `context method ${colors.bold(
            `${method}()`,
          )} is not supported in serve mode. This plugin is likely not vite-compatible.`,
        ),
    )
  }

  // parallel, ignores returns
  async function hookParallel<H extends AsyncPluginHooks & ParallelPluginHooks>(
    hookName: H,
    context: (plugin: Plugin) => ThisType<FunctionPluginHooks[H]>,
    args: (plugin: Plugin) => Parameters<FunctionPluginHooks[H]>,
  ): Promise<void> {
    const parallelPromises: Promise<unknown>[] = []
    for (const plugin of getSortedPlugins(hookName)) {
      // Don't throw here if closed, so buildEnd and closeBundle hooks can finish running
      const hook = plugin[hookName]
      if (!hook) continue

      const handler: Function = getHookHandler(hook)
      if ((hook as { sequential?: boolean }).sequential) {
        await Promise.all(parallelPromises)
        parallelPromises.length = 0
        await handler.apply(context(plugin), args(plugin))
      } else {
        parallelPromises.push(handler.apply(context(plugin), args(plugin)))
      }
    }
    await Promise.all(parallelPromises)
  }

  // throw when an unsupported ModuleInfo property is accessed,
  // so that incompatible plugins fail in a non-cryptic way.
  const ModuleInfoProxy: ProxyHandler<ModuleInfo> = {
    get(info: any, key: string) {
      if (key in info) {
        return info[key]
      }
      // Don't throw an error when returning from an async function
      if (key === 'then') {
        return undefined
      }
      throw Error(
        `[vite] The "${key}" property of ModuleInfo is not supported.`,
      )
    },
  }

  // same default value of "moduleInfo.meta" as in Rollup
  const EMPTY_OBJECT = Object.freeze({})

  // we should create a new context for each async hook pipeline so that the
  // active plugin in that pipeline can be tracked in a concurrency-safe manner.
  // using a class to make creating new contexts more efficient
  class Context implements PluginContext {
    environment: Environment // TODO: | ScanEnvironment
    meta = minimalContext.meta
    ssr = false
    _scan = false
    _activePlugin: Plugin | null
    _activeId: string | null = null
    _activeCode: string | null = null
    _resolveSkips?: Set<Plugin>
    _addedImports: Set<string> | null = null

    constructor(initialPlugin?: Plugin) {
      this.environment = environment
      this._activePlugin = initialPlugin || null
    }

    parse(code: string, opts: any) {
      return rollupParseAst(code, opts)
    }

    async resolve(
      id: string,
      importer?: string,
      options?: {
        attributes?: Record<string, string>
        custom?: CustomPluginOptions
        isEntry?: boolean
        skipSelf?: boolean
      },
    ) {
      let skip: Set<Plugin> | undefined
      if (options?.skipSelf !== false && this._activePlugin) {
        skip = new Set(this._resolveSkips)
        skip.add(this._activePlugin)
      }
      let out = await container.resolveId(id, importer, {
        attributes: options?.attributes,
        custom: options?.custom,
        isEntry: !!options?.isEntry,
        skip,
        scan: this._scan,
      })
      if (typeof out === 'string') out = { id: out }
      return out as ResolvedId | null
    }

    async load(
      options: {
        id: string
        resolveDependencies?: boolean
      } & Partial<PartialNull<ModuleOptions>>,
    ): Promise<ModuleInfo> {
      // We may not have added this to our module graph yet, so ensure it exists
      await moduleGraph?.ensureEntryFromUrl(unwrapId(options.id))
      // Not all options passed to this function make sense in the context of loading individual files,
      // but we can at least update the module info properties we support
      this._updateModuleInfo(options.id, options)

      const loadResult = await container.load(options.id)
      const code =
        typeof loadResult === 'object' ? loadResult?.code : loadResult
      if (code != null) {
        await container.transform(code, options.id)
      }

      const moduleInfo = this.getModuleInfo(options.id)
      // This shouldn't happen due to calling ensureEntryFromUrl, but 1) our types can't ensure that
      // and 2) moduleGraph may not have been provided (though in the situations where that happens,
      // we should never have plugins calling this.load)
      if (!moduleInfo)
        throw Error(`Failed to load module with id ${options.id}`)
      return moduleInfo
    }

    getModuleInfo(id: string) {
      const module = moduleGraph?.getModuleById(id)
      if (!module) {
        return null
      }
      if (!module.info) {
        module.info = new Proxy(
          { id, meta: module.meta || EMPTY_OBJECT } as ModuleInfo,
          ModuleInfoProxy,
        )
      }
      return module.info
    }

    _updateModuleInfo(id: string, { meta }: { meta?: object | null }) {
      if (meta) {
        const moduleInfo = this.getModuleInfo(id)
        if (moduleInfo) {
          moduleInfo.meta = { ...moduleInfo.meta, ...meta }
        }
      }
    }

    _updateModuleLoadAddedImports(id: string) {
      const module = moduleGraph?.getModuleById(id)
      if (module) {
        moduleNodeToLoadAddedImports.set(module, this._addedImports)
      }
    }

    getModuleIds() {
      return (
        moduleGraph?.idToModuleMap.keys() ?? Array.prototype[Symbol.iterator]()
      )
    }

    addWatchFile(id: string) {
      watchFiles.add(id)
      ;(this._addedImports || (this._addedImports = new Set())).add(id)
      if (watcher) ensureWatchedFile(watcher, id, root)
    }

    getWatchFiles() {
      return [...watchFiles]
    }

    emitFile(assetOrFile: EmittedFile) {
      warnIncompatibleMethod(`emitFile`, this._activePlugin!.name)
      return ''
    }

    setAssetSource() {
      warnIncompatibleMethod(`setAssetSource`, this._activePlugin!.name)
    }

    getFileName() {
      warnIncompatibleMethod(`getFileName`, this._activePlugin!.name)
      return ''
    }

    warn(
      e: string | RollupLog | (() => string | RollupLog),
      position?: number | { column: number; line: number },
    ) {
      const err = formatError(typeof e === 'function' ? e() : e, position, this)
      const msg = buildErrorMessage(
        err,
        [colors.yellow(`warning: ${err.message}`)],
        false,
      )
      logger.warn(msg, {
        clear: true,
        timestamp: true,
      })
    }

    error(
      e: string | RollupError,
      position?: number | { column: number; line: number },
    ): never {
      // error thrown here is caught by the transform middleware and passed on
      // the the error middleware.
      throw formatError(e, position, this)
    }

    debug = noop
    info = noop
  }

  function formatError(
    e: string | RollupError,
    position: number | { column: number; line: number } | undefined,
    ctx: Context,
  ) {
    const err = (typeof e === 'string' ? new Error(e) : e) as RollupError
    if (err.pluginCode) {
      return err // The plugin likely called `this.error`
    }
    if (ctx._activePlugin) err.plugin = ctx._activePlugin.name
    if (ctx._activeId && !err.id) err.id = ctx._activeId
    if (ctx._activeCode) {
      err.pluginCode = ctx._activeCode

      // some rollup plugins, e.g. json, sets err.position instead of err.pos
      const pos = position ?? err.pos ?? (err as any).position

      if (pos != null) {
        let errLocation
        try {
          errLocation = numberToPos(ctx._activeCode, pos)
        } catch (err2) {
          logger.error(
            colors.red(
              `Error in error handler:\n${err2.stack || err2.message}\n`,
            ),
            // print extra newline to separate the two errors
            { error: err2 },
          )
          throw err
        }
        err.loc = err.loc || {
          file: err.id,
          ...errLocation,
        }
        err.frame = err.frame || generateCodeFrame(ctx._activeCode, pos)
      } else if (err.loc) {
        // css preprocessors may report errors in an included file
        if (!err.frame) {
          let code = ctx._activeCode
          if (err.loc.file) {
            err.id = normalizePath(err.loc.file)
            try {
              code = fs.readFileSync(err.loc.file, 'utf-8')
            } catch {}
          }
          err.frame = generateCodeFrame(code, err.loc)
        }
      } else if ((err as any).line && (err as any).column) {
        err.loc = {
          file: err.id,
          line: (err as any).line,
          column: (err as any).column,
        }
        err.frame = err.frame || generateCodeFrame(ctx._activeCode, err.loc)
      }

      if (
        ctx instanceof TransformContext &&
        typeof err.loc?.line === 'number' &&
        typeof err.loc?.column === 'number'
      ) {
        const rawSourceMap = ctx._getCombinedSourcemap()
        if (rawSourceMap && 'version' in rawSourceMap) {
          const traced = new TraceMap(rawSourceMap as any)
          const { source, line, column } = originalPositionFor(traced, {
            line: Number(err.loc.line),
            column: Number(err.loc.column),
          })
          if (source && line != null && column != null) {
            err.loc = { file: source, line, column }
          }
        }
      }
    } else if (err.loc) {
      if (!err.frame) {
        let code = err.pluginCode
        if (err.loc.file) {
          err.id = normalizePath(err.loc.file)
          if (!code) {
            try {
              code = fs.readFileSync(err.loc.file, 'utf-8')
            } catch {}
          }
        }
        if (code) {
          err.frame = generateCodeFrame(`${code}`, err.loc)
        }
      }
    }

    if (
      typeof err.loc?.column !== 'number' &&
      typeof err.loc?.line !== 'number' &&
      !err.loc?.file
    ) {
      delete err.loc
    }

    return err
  }

  class TransformContext extends Context {
    filename: string
    originalCode: string
    originalSourcemap: SourceMap | null = null
    sourcemapChain: NonNullable<SourceDescription['map']>[] = []
    combinedMap: SourceMap | { mappings: '' } | null = null

    constructor(id: string, code: string, inMap?: SourceMap | string) {
      super()
      this.filename = id
      this.originalCode = code
      if (inMap) {
        if (debugSourcemapCombine) {
          // @ts-expect-error inject name for debug purpose
          inMap.name = '$inMap'
        }
        this.sourcemapChain.push(inMap)
      }
      // Inherit `_addedImports` from the `load()` hook
      const node = moduleGraph?.getModuleById(id)
      if (node) {
        this._addedImports = moduleNodeToLoadAddedImports.get(node) ?? null
      }
    }

    _getCombinedSourcemap() {
      if (
        debugSourcemapCombine &&
        debugSourcemapCombineFilter &&
        this.filename.includes(debugSourcemapCombineFilter)
      ) {
        debugSourcemapCombine('----------', this.filename)
        debugSourcemapCombine(this.combinedMap)
        debugSourcemapCombine(this.sourcemapChain)
        debugSourcemapCombine('----------')
      }

      let combinedMap = this.combinedMap
      // { mappings: '' }
      if (
        combinedMap &&
        !('version' in combinedMap) &&
        combinedMap.mappings === ''
      ) {
        this.sourcemapChain.length = 0
        return combinedMap
      }

      for (let m of this.sourcemapChain) {
        if (typeof m === 'string') m = JSON.parse(m)
        if (!('version' in (m as SourceMap))) {
          // { mappings: '' }
          if ((m as SourceMap).mappings === '') {
            combinedMap = { mappings: '' }
            break
          }
          // empty, nullified source map
          combinedMap = null
          break
        }
        if (!combinedMap) {
          const sm = m as SourceMap
          // sourcemap should not include `sources: [null]` (because `sources` should be string) nor
          // `sources: ['']` (because `''` means the path of sourcemap)
          // but MagicString generates this when `filename` option is not set.
          // Rollup supports these and therefore we support this as well
          if (sm.sources.length === 1 && !sm.sources[0]) {
            combinedMap = {
              ...sm,
              sources: [this.filename],
              sourcesContent: [this.originalCode],
            }
          } else {
            combinedMap = sm
          }
        } else {
          combinedMap = combineSourcemaps(cleanUrl(this.filename), [
            m as RawSourceMap,
            combinedMap as RawSourceMap,
          ]) as SourceMap
        }
      }
      if (combinedMap !== this.combinedMap) {
        this.combinedMap = combinedMap
        this.sourcemapChain.length = 0
      }
      return this.combinedMap
    }

    getCombinedSourcemap() {
      const map = this._getCombinedSourcemap()
      if (!map || (!('version' in map) && map.mappings === '')) {
        return new MagicString(this.originalCode).generateMap({
          includeContent: true,
          hires: 'boundary',
          source: cleanUrl(this.filename),
        })
      }
      return map
    }
  }

  let closed = false
  const processesing = new Set<Promise<any>>()
  // keeps track of hook promises so that we can wait for them all to finish upon closing the server
  function handleHookPromise<T>(maybePromise: undefined | T | Promise<T>) {
    if (!(maybePromise as any)?.then) {
      return maybePromise
    }
    const promise = maybePromise as Promise<T>
    processesing.add(promise)
    return promise.finally(() => processesing.delete(promise))
  }

  const container: PluginContainer = {
    options: await (async () => {
      let options = rollupOptions
      for (const optionsHook of getSortedPluginHooks('options')) {
        if (closed) throwClosedServerError()
        options =
          (await handleHookPromise(
            optionsHook.call(minimalContext, options),
          )) || options
      }
      return options
    })(),

    async buildStart() {
      await handleHookPromise(
        hookParallel(
          'buildStart',
          (plugin) => new Context(plugin),
          () => [container.options as NormalizedInputOptions],
        ),
      )
    },

    async resolveId(rawId, importer = join(root, 'index.html'), options) {
      const skip = options?.skip
      const scan = !!options?.scan

      const ctx = new Context()
      ctx._resolveSkips = skip
      ctx._scan = scan

      const resolveStart = debugResolve ? performance.now() : 0
      let id: string | null = null
      const partial: Partial<PartialResolvedId> = {}
      for (const plugin of getSortedPlugins('resolveId')) {
        if (closed && environment?.options.dev.recoverable)
          throwClosedServerError()
        if (!plugin.resolveId) continue
        if (skip?.has(plugin)) continue

        ctx._activePlugin = plugin

        const pluginResolveStart = debugPluginResolve ? performance.now() : 0
        const handler = getHookHandler(plugin.resolveId)
        const result = await handleHookPromise(
          handler.call(ctx as any, rawId, importer, {
            attributes: options?.attributes ?? {},
            custom: options?.custom,
            isEntry: !!options?.isEntry,
            ssr,
            scan,
          }),
        )
        if (!result) continue

        if (typeof result === 'string') {
          id = result
        } else {
          id = result.id
          Object.assign(partial, result)
        }

        debugPluginResolve?.(
          timeFrom(pluginResolveStart),
          plugin.name,
          prettifyUrl(id, root),
        )

        // resolveId() is hookFirst - first non-null result is returned.
        break
      }

      if (debugResolve && rawId !== id && !rawId.startsWith(FS_PREFIX)) {
        const key = rawId + id
        // avoid spamming
        if (!seenResolves[key]) {
          seenResolves[key] = true
          debugResolve(
            `${timeFrom(resolveStart)} ${colors.cyan(rawId)} -> ${colors.dim(
              id,
            )}`,
          )
        }
      }

      if (id) {
        partial.id = isExternalUrl(id) ? id : normalizePath(id)
        return partial as PartialResolvedId
      } else {
        return null
      }
    },

    async load(id, options) {
      options = options ? { ...options, ssr } : { ssr }
      const ctx = new Context()
      for (const plugin of getSortedPlugins('load')) {
        if (closed && environment?.options.dev.recoverable)
          throwClosedServerError()
        if (!plugin.load) continue
        ctx._activePlugin = plugin
        const handler = getHookHandler(plugin.load)
        const result = await handleHookPromise(
          handler.call(ctx as any, id, options),
        )
        if (result != null) {
          if (isObject(result)) {
            ctx._updateModuleInfo(id, result)
          }
          ctx._updateModuleLoadAddedImports(id)
          return result
        }
      }
      ctx._updateModuleLoadAddedImports(id)
      return null
    },

    async transform(code, id, options) {
      options = options ? { ...options, ssr } : { ssr }
      const inMap = options?.inMap
      const ctx = new TransformContext(id, code, inMap as SourceMap)
      for (const plugin of getSortedPlugins('transform')) {
        if (closed && environment?.options.dev.recoverable)
          throwClosedServerError()
        if (!plugin.transform) continue
        ctx._activePlugin = plugin
        ctx._activeId = id
        ctx._activeCode = code
        const start = debugPluginTransform ? performance.now() : 0
        let result: TransformResult | string | undefined
        const handler = getHookHandler(plugin.transform)
        try {
          result = await handleHookPromise(
            handler.call(ctx as any, code, id, options),
          )
        } catch (e) {
          ctx.error(e)
        }
        if (!result) continue
        debugPluginTransform?.(
          timeFrom(start),
          plugin.name,
          prettifyUrl(id, root),
        )
        if (isObject(result)) {
          if (result.code !== undefined) {
            code = result.code
            if (result.map) {
              if (debugSourcemapCombine) {
                // @ts-expect-error inject plugin name for debug purpose
                result.map.name = plugin.name
              }
              ctx.sourcemapChain.push(result.map)
            }
          }
          ctx._updateModuleInfo(id, result)
        } else {
          code = result
        }
      }
      return {
        code,
        map: ctx._getCombinedSourcemap(),
      }
    },

    async watchChange(id, change) {
      const ctx = new Context()
      await hookParallel(
        'watchChange',
        () => ctx,
        () => [id, change],
      )
    },

    async close() {
      if (closed) return
      closed = true
      await Promise.allSettled(Array.from(processesing))
      const ctx = new Context()
      await hookParallel(
        'buildEnd',
        () => ctx,
        () => [],
      )
      await hookParallel(
        'closeBundle',
        () => ctx,
        () => [],
      )
    },
  }

  return container
}

// Backward compatiblity

export interface PluginContainer {
  options: InputOptions
  buildStart(options: InputOptions): Promise<void>
  resolveId(
    id: string,
    importer?: string,
    options?: {
      attributes?: Record<string, string>
      custom?: CustomPluginOptions
      skip?: Set<Plugin>
      ssr?: boolean
      environment?: Environment
      /**
       * @internal
       */
      scan?: boolean
      isEntry?: boolean
    },
  ): Promise<PartialResolvedId | null>
  transform(
    code: string,
    id: string,
    options?: {
      inMap?: SourceDescription['map']
      ssr?: boolean
      environment?: Environment
    },
  ): Promise<{ code: string; map: SourceMap | { mappings: '' } | null }>
  load(
    id: string,
    options?: {
      ssr?: boolean
      environment?: Environment
    },
  ): Promise<LoadResult | null>
  watchChange(
    id: string,
    change: { event: 'create' | 'update' | 'delete' },
  ): Promise<void>
  close(): Promise<void>
}

/**
 * server.pluginContainer compatibility
 *
 * The default environment is in buildStart, buildEnd, watchChange, and closeBundle hooks,
 * wich are called once for all environments, or when no environment is passed in other hooks.
 * The ssrEnvironment is needed for backward compatibility when the ssr flag is passed without
 * an environment. The defaultEnvironment in the main pluginContainer in the server should be
 * the client environment for backward compatibility.
 **/

export function createPluginContainer(
  environments: Record<string, Environment>,
): PluginContainer {
  // Backward compatibility
  // Users should call pluginContainer.resolveId (and load/transform) passing the environment they want to work with
  // But there is code that is going to call it without passing an environment, or with the ssr flag to get the ssr environment
  function getEnvironment(options?: { ssr?: boolean }) {
    return environments?.[options?.ssr ? 'ssr' : 'client']
  }
  function getPluginContainer(options?: { ssr?: boolean }) {
    return (getEnvironment(options) as DevEnvironment).pluginContainer!
  }

  const container: PluginContainer = {
    get options() {
      return (environments.client as DevEnvironment).pluginContainer!.options
    },

    async buildStart() {
      ;(environments.client as DevEnvironment).pluginContainer!.buildStart({})
    },

    async resolveId(rawId, importer, options) {
      return getPluginContainer(options).resolveId(rawId, importer, options)
    },

    async load(id, options) {
      return getPluginContainer(options).load(id, options)
    },

    async transform(code, id, options) {
      return getPluginContainer(options).transform(code, id, options)
    },

    async watchChange(id, change) {
      // noop, watchChange is already called for each environment
    },

    async close() {
      // noop, close will be called for each environment
    },
  }

  return container
}
