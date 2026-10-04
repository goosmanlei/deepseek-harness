/**
 * Shared profile boot for every `dsh` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
 * tree over the profile's empty root config, and wire fail-loud plus bounded shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  profileDebug,
  readProfilePatches,
  createRuntimeResolution,
  initProfile,
  installFailLoud,
  loadOverlayPatches,
  loadProfile,
  reportSkippedBundles,
  PluginPackages,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  resolveProfileDir,
  type ProfileContext,
  type Profile,
  type RuntimeResolution,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline, type AppReady } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'

const NAME = 'dsh'

/** Launcher-owned readiness signal committed only after boot and host setup succeed. */
function createAppReady(): { service: AppReady; commit(): void } {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$DSH_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * Initialize a missing profile from one shipped template. This copies only
 * the template's bundle list; local state from the
 * same-named shipped profile is not read, and no inheritance metadata is
 * persisted. Shipped profile names are reserved, and the target directory is
 * claimed exclusively so existing or concurrent state is never reused.
 * @param name - the new profile name.
 * @param fromDefaultProfile - shipped profile template to copy.
 * @param home - Harness home containing the profile directory.
 * @throws when the template is unknown, the target name is shipped, or the target directory exists.
 */
export function initializeProfileFromDefault(
  name: string,
  fromDefaultProfile: string,
  home: string = resolveDshHome(),
): void {
  const dir = resolveProfileDir(name, home)
  profileDebug('initializeProfileFromDefault', '从内置模板创建自定义 Profile', { name, fromDefaultProfile, home, dir })
  const template = Object.hasOwn(PROFILE_TEMPLATES, fromDefaultProfile)
    ? PROFILE_TEMPLATES[fromDefaultProfile]
    : undefined
  if (template === undefined) {
    const expected = Object.keys(PROFILE_TEMPLATES).sort().map(value => JSON.stringify(value)).join(', ')
    throw new Error(
      `${NAME}: unknown default profile ${JSON.stringify(fromDefaultProfile)}; expected one of ${expected}`,
    )
  }
  if (Object.hasOwn(PROFILE_TEMPLATES, name)) {
    throw new Error(
      `${NAME}: profile ${JSON.stringify(name)} is shipped and cannot be a custom profile target; `
      + 'omit --from-default-profile to use it',
    )
  }
  mkdirSync(dirname(dir), { recursive: true })
  try {
    mkdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      throw new Error(
        `${NAME}: profile ${JSON.stringify(name)} already exists at ${manifestPath}; `
        + 'omit --from-default-profile to use it',
      )
    }
    throw new Error(
      `${NAME}: profile directory ${dir} already exists; choose an unused profile name`,
    )
  }
  try {
    initProfile(dir, template.bundles)
    profileDebug('initializeProfileFromDefault', '初始化完成', { dir, bundles: template.bundles })
  } catch (error) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${NAME}: profile initialization failed and ${dir} could not be removed`,
      )
    }
    throw error
  }
}
/**
 * Load a resolved profile for `name` and (re)write the empty root config. The
 * root is always rewritten: the whole composition is patch layers, and the
 * vendored Loader's tree write-back (a plugin self-disposing persists the
 * current tree) can bake composed rows into this file — which would duplicate
 * every bundle insert on the next boot. The file exists on disk only because
 * the Loader needs a real include root to anchor `baseUrl` at the profile
 * directory (the config dump anchors on the same file, so both compose over
 * the identical base).
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @param fromDefaultProfile - shipped template used once to initialize a missing profile.
 * @returns the loaded profile.
 * @throws when explicit initialization names an unknown template or an existing profile.
 */
export function prepareProfile(name: string, userLayer = true, fromDefaultProfile?: string): Profile {
  profileDebug('prepareProfile', '读取命名 Profile：开始', { name, userLayer, fromDefaultProfile, installAnchor: INSTALL_ANCHOR })
  if (fromDefaultProfile !== undefined) initializeProfileFromDefault(name, fromDefaultProfile)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  reportSkippedBundles(NAME, profile)
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  profileDebug('prepareProfile', '空根配置已重写，实际插件来自 patch 层', { path: join(profile.dir, PROFILE_ROOT_FILENAME), content: PROFILE_ROOT_CONFIG })
  return profile
}

/** One profile's patch layers, in application order. */
interface ComposedProfile {
  profile: Profile
  /** Immutable runtime resolution computed before any plugin imports. */
  resolution: RuntimeResolution
  /** Command-line overlay contents, frozen for this invocation. */
  overlays: PatchOptions[]
}

/**
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order (a base-backed profile gets the base bundle's
 * platform-gated shell rows), the profile's user layer, the home-level user
 * layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply
 * to every profile, so it outranks the per-profile layer), `--patch` overlays,
 * then the telemetry switch.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @param fromDefaultProfile - shipped template for a missing named profile.
 * @param resolvedProfile - application-owned profile and installation.
 * @returns the profile and its patch layers.
 */
async function composeProfile(
  name: string,
  patchFiles: readonly string[],
  fromDefaultProfile?: string,
  resolvedProfile?: ResolvedProfileRuntime,
): Promise<ComposedProfile> {
  profileDebug('composeProfile', '开始装配：选择 Profile 来源', {
    name, patchFiles, fromDefaultProfile, source: resolvedProfile === undefined ? '按名称从 DSH_HOME 加载' : '应用传入已加载的 Profile', resolvedProfile,
  })
  const profile = resolvedProfile?.profile ?? prepareProfile(name, true, fromDefaultProfile)
  if (resolvedProfile !== undefined) writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  const resolutionOptions = { installAnchor: resolvedProfile?.installAnchor ?? INSTALL_ANCHOR, profile }
  const resolution = await createRuntimeResolution(resolutionOptions)
  profileDebug('composeProfile', '包解析表已构建，接着按命令行顺序读取 --patch', { patchFiles, cwd: process.cwd() })
  const overlays = patchFiles.flatMap((file) => {
    const absolutePath = resolve(file)
    profileDebug('composeProfile', '读取命令行覆盖层', { file, absolutePath })
    return loadOverlayPatches(NAME, absolutePath)
  })
  profileDebug('composeProfile', '命令行覆盖层读取完成', overlays)
  return { profile, resolution, overlays }
}

/** An application-owned profile and its independent installation fallback. */
export interface ResolvedProfileRuntime {
  /** Profile already loaded from the application's own directory. */
  profile: Profile
  /** Absolute package.json path of the application's dsh installation. */
  installAnchor: string
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** Loaded application profile; bypasses named profile initialization when supplied. */
  resolvedProfile?: ResolvedProfileRuntime | undefined
  /** Shipped template used once to initialize a missing profile. */
  fromDefaultProfile?: string | undefined
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
  /** Application-owned package runtime, scoped to plugin package operations. */
  packageManager?: ProfileContext['packageManager']
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 * @throws after disposing startup resources; cleanup failures retain the original error.
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  const debug = (stage: string, value?: unknown): void => { profileDebug('runProfile', stage, value) }
  debug('启动参数', options)
  // 插件可能在加载时发起网络请求，因此必须先安装代理。这里读取启动时的环境快照，
  // 包括 .env 层；Node 启动时采样的 NODE_USE_ENV_PROXY 无法覆盖这些后来加载的值。
  debug('安装 HTTP 代理：开始')
  const disposeProxy = await installProxyFromEnvironment(
    options.environment,
    (message) => { process.stderr.write(`${NAME}: ${message}\n`) },
  )
  debug('安装 HTTP 代理：完成')

  // boot 的回调会提前保存根 Context；即使插件树尚未启动成功，也能释放已创建的资源。
  const app: { current?: Context } = {}
  let disposal: Promise<void> | undefined
  // 复用同一个清理 Promise，避免退出与启动失败同时触发重复释放。
  // 先释放插件树，再恢复代理；第一项失败仍继续第二项，最后汇总错误。
  const dispose = (): Promise<void> => disposal ??= (async () => {
    debug('清理资源：开始', { hasContext: app.current !== undefined, fiberState: app.current?.fiber.state })
    const failures: unknown[] = []
    for (const release of [() => app.current?.fiber.dispose(), disposeProxy]) {
      try { await release() } catch (error) { failures.push(error) }
    }
    debug('清理资源：结束', { failures })
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'dsh: profile cleanup failed')
  })()
  try {
    // composeProfile 读取 Profile、bundle 配置和 --patch 覆盖层，并确定插件包的解析位置。
    // 此时得到的是配置与解析信息，尚未加载整棵应用插件树。
    const composed = await composeProfile(
      options.profile, options.patchFiles, options.fromDefaultProfile, options.resolvedProfile,
    )
    debug('Profile 装配结果', composed)
    // appReady 只负责通知应用已经就绪；shutdown 负责有超时限制的资源清理和退出。
    const appReady = createAppReady()
    const shutdown = createProcessShutdown(dispose)
    const signalShutdown = new AbortController()
    const interrupt = (code: number): void => {
      debug('收到退出信号', { code, alreadyAborted: signalShutdown.signal.aborted })
      signalShutdown.abort()
      shutdown.interrupt(code)
    }
    // 信号处理在 boot 前注册，因为启动期间某些插件已可对外提供服务。
    // SIGTERM 是进程管理器的正常停止请求（退出码 0）；Ctrl-C 的 SIGINT 使用退出码 130。
    process.on('SIGTERM', () => { interrupt(0) })
    process.on('SIGINT', () => { interrupt(130) })
    installFailLoud(NAME, process, async () => {
      debug('未处理异常触发插件树清理')
      await app.current?.fiber.dispose()
    })

    // cordis.yml 是空根配置，实际插件条目由 patch 层叠得到。
    // profileContext 是插件共享的启动信息；cwd 是用户发起命令的位置，dir 是 Profile 目录。
    const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
    const profileContext: ProfileContext = {
      name: options.profile,
      ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
      dir: composed.profile.dir, patchPath: composed.profile.patchPath,
      installAnchor: options.resolvedProfile?.installAnchor ?? INSTALL_ANCHOR,
      startedBundles: composed.profile.layers.map(layer => layer.packageName),
      cwd: process.cwd(), home: resolveDshHome(),
      overlays: composed.overlays, telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    }
    debug('插件共享的 profileContext', profileContext)
    // 配置层顺序：bundle → Profile 用户层 → home 用户层 → --patch → 遥测开关。
    // 这里打印的是依次应用的 patch 列表，还不是合成后的最终插件条目。
    const patches = readProfilePatches(NAME, profileContext, composed.profile)
    debug('即将交给 boot 的根配置与 patch 列表', { rootConfig, patches })
    const ctx = await boot(NAME, rootConfig, patches, async (hostCtx) => {
      // boot 先创建根 Context 并调用本回调，再加载配置树；以下服务必须在插件加载前注入。
      app.current = hostCtx
      hostCtx.provide('profileContext', profileContext)
      // 所有插件读取同一份不可变环境快照，避免各自读取到不同的启动配置。
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
      // PluginPackages 安装本次 Profile 的包解析服务，供后续插件加载与包管理操作使用。
      await hostCtx.plugin(PluginPackages, {
        resolution: composed.resolution,
      })
      debug('插件包解析服务已安装')
      // 应用插件通过 ctx.cmdlineArgs 读取内层参数；退出请求统一交给 shutdown，
      // ready 订阅者则等待启动成功通知。这里传入参数，不负责解析 Web 等应用自己的选项。
      provideCmdline(hostCtx, {
        args: options.args,
        exit: code => void shutdown.shutdown(code),
        ready: appReady.service,
      })
      debug('插件加载前的服务注入已完成', { args: options.args, fiberState: hostCtx.fiber.state })
    })
    app.current = ctx
    debug('boot 已返回', { aborted: signalShutdown.signal.aborted, fiberState: ctx.fiber.state })
    // boot 返回不一定表示应用可用：一次性插件可能已退出，或启动时已收到停止信号。
    // 仅在未中断、根 fiber 仍 ACTIVE 且 loader 存在时，才通知订阅者应用就绪。
    if (!signalShutdown.signal.aborted
      && ctx.fiber.state === FiberState.ACTIVE
      && ctx.get('loader') !== undefined) {
      appReady.commit()
      debug('已发送应用就绪通知')
    } else {
      debug('未发送应用就绪通知', {
        aborted: signalShutdown.signal.aborted,
        fiberState: ctx.fiber.state,
        hasLoader: ctx.get('loader') !== undefined,
      })
    }
    return { ctx, shutdown }
  } catch (error) {
    // 启动异常先清理资源，再抛回调用者；清理也失败时保留两份错误，不覆盖原始原因。
    debug('Profile 启动失败', error)
    try { await dispose() } catch (cleanupError) {
      debug('启动失败后的清理也失败', cleanupError)
      throw new AggregateError([error, cleanupError], 'dsh: profile startup and cleanup failed')
    }
    throw error
  }
}
