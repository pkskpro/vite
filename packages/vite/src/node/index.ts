import type * as Rollup from 'rollup'

export type { Rollup }
export { parseAst, parseAstAsync } from 'rollup/parseAst'
export {
  defineConfig,
  loadConfigFromFile,
  resolveConfig,
  sortUserPlugins,
} from './config'
export { createServer } from './server'
export { preview } from './preview'
export { build, createBuilder } from './build'

// TODO: Can we remove this?
// export { optimizeDeps } from './optimizer'

export { formatPostcssSourceMap, preprocessCSS } from './plugins/css'
export { transformWithEsbuild } from './plugins/esbuild'
export { buildErrorMessage } from './server/middlewares/error'

export { RemoteEnvironmentTransport } from './server/environmentTransport'
export { createNodeDevEnvironment } from './server/environments/nodeEnvironment'
export { DevEnvironment, type DevEnvironmentSetup } from './server/environment'
export { BuildEnvironment } from './build'

export { fetchModule, type FetchModuleOptions } from './ssr/fetchModule'
export { createServerModuleRunner } from './ssr/runtime/serverModuleRunner'
export { ServerHMRConnector } from './ssr/runtime/serverHmrConnector'
export { ssrTransform as moduleRunnerTransform } from './ssr/ssrTransform'
export type { ModuleRunnerTransformOptions } from './ssr/ssrTransform'

export * from './publicUtils'

// additional types
export type {
  AppType,
  ConfigEnv,
  ExperimentalOptions,
  HTMLOptions,
  InlineConfig,
  LegacyOptions,
  PluginHookUtils,
  ResolveFn,
  ResolvedWorkerOptions,
  ResolvedConfig,
  UserConfig,
  UserConfigExport,
  UserConfigFn,
  UserConfigFnObject,
  UserConfigFnPromise,
  DevEnvironmentOptions,
  ResolvedDevEnvironmentOptions,
} from './config'
export type {
  EnvironmentPlugin,
  Plugin,
  EnvironmentPluginOptionArray,
  PluginOption,
  HookHandler,
} from './plugin'
export type { FilterPattern } from './utils'
export type { CorsOptions, CorsOrigin, CommonServerOptions } from './http'
export type {
  ViteDevServer,
  ServerOptions,
  FileSystemServeOptions,
  ServerHook,
  ResolvedServerOptions,
  ResolvedServerUrls,
} from './server'
export type {
  ViteBuilder,
  BuilderOptions,
  BuildOptions,
  BuildEnvironmentOptions,
  LibraryOptions,
  LibraryFormats,
  RenderBuiltAssetUrl,
  ResolvedBuildOptions,
  ResolvedBuildEnvironmentOptions,
  ModulePreloadOptions,
  ResolvedModulePreloadOptions,
  ResolveModulePreloadDependenciesFn,
} from './build'
export type {
  PreviewOptions,
  PreviewServer,
  PreviewServerHook,
  ResolvedPreviewOptions,
} from './preview'
export type {
  DepOptimizationMetadata,
  DepOptimizationOptions,
  DepOptimizationConfig,
  OptimizedDepInfo,
  ExportsData,
} from './optimizer'
export type {
  ResolvedSSROptions,
  SsrDepOptimizationOptions,
  SSROptions,
  SSRTarget,
} from './ssr'
export type {
  Logger,
  LogOptions,
  LogErrorOptions,
  LogLevel,
  LogType,
  LoggerOptions,
} from './logger'
export type {
  IndexHtmlTransform,
  IndexHtmlTransformHook,
  IndexHtmlTransformContext,
  IndexHtmlTransformResult,
  HtmlTagDescriptor,
} from './plugins/html'
export type {
  CSSOptions,
  CSSModulesOptions,
  PreprocessCSSResult,
  ResolvedCSSOptions,
} from './plugins/css'
export type { JsonOptions } from './plugins/json'
export type { TransformOptions as EsbuildTransformOptions } from 'esbuild'
export type { ESBuildOptions, ESBuildTransformResult } from './plugins/esbuild'
export type { Manifest, ManifestChunk } from './plugins/manifest'
export type { ResolveOptions, InternalResolveOptions } from './plugins/resolve'
export type { SplitVendorChunkCache } from './plugins/splitVendorChunk'
export type { TerserOptions } from './plugins/terser'

export type {
  WebSocketServer,
  WebSocketClient,
  WebSocketCustomListener,
} from './server/ws'
export type { PluginContainer } from './server/pluginContainer'
export type {
  EnvironmentModuleGraph,
  EnvironmentModuleNode,
  ResolvedUrl,
} from './server/moduleGraph'
export type { SendOptions } from './server/send'
export type { ProxyOptions } from './server/middlewares/proxy'
export type {
  TransformOptions,
  TransformResult,
} from './server/transformRequest'
export type { HmrOptions, HmrContext, HotUpdateContext } from './server/hmr'

export type {
  HotChannel,
  ServerHMRChannel,
  HMRBroadcasterClient,
} from './server/hmr'

export type { FetchFunction, FetchResult } from 'vite/module-runner'
export type { ServerModuleRunnerOptions } from './ssr/runtime/serverModuleRunner'

export type { BindCLIShortcutsOptions, CLIShortcut } from './shortcuts'

export type {
  HMRPayload,
  ConnectedPayload,
  UpdatePayload,
  Update,
  FullReloadPayload,
  CustomPayload,
  PrunePayload,
  ErrorPayload,
} from 'types/hmrPayload'
export type {
  CustomEventMap,
  InferCustomEventPayload,
  InvalidatePayload,
} from 'types/customEvent'
export type {
  ImportGlobFunction,
  ImportGlobOptions,
  GeneralImportGlobOptions,
  KnownAsTypeMap,
} from 'types/importGlob'
export type { ChunkMetadata } from 'types/metadata'

// dep types
export type {
  AliasOptions,
  MapToFunction,
  ResolverFunction,
  ResolverObject,
  Alias,
} from 'dep-types/alias'
export type { Connect } from 'dep-types/connect'
export type { WebSocket, WebSocketAlias } from 'dep-types/ws'
export type { HttpProxy } from 'dep-types/http-proxy'
export type {
  FSWatcher,
  WatchOptions,
  AwaitWriteFinishOptions,
} from 'dep-types/chokidar'
export type { Terser } from 'dep-types/terser'
export type { RollupCommonJSOptions } from 'dep-types/commonjs'
export type { RollupDynamicImportVarsOptions } from 'dep-types/dynamicImportVars'
export type { Matcher, AnymatchPattern, AnymatchFn } from 'dep-types/anymatch'
export type { LightningCSSOptions } from 'dep-types/lightningcss'

// Backward compatibility
export type { ModuleGraph, ModuleNode } from './server/mixedModuleGraph'
