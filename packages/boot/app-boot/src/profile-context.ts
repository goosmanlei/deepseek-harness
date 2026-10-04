/** Launcher-owned profile locations and composition inputs. */
import { join } from 'node:path'
import { profileDebug } from './profile-debug.ts'
import { composeEntries, loadProfileDirectory, PROFILE_PATCH_FILENAME, type Profile } from './profile.ts'
import { loadOptionalPatches } from './index.ts'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** Application-owned package manager executable; environment applies only to package operations. */
export interface ProfilePnpmInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** Current profile facts; scheduling and mutation belong to their callers. */
export interface ProfileContext {
  readonly name: string
  /** Packaged applications supply their bundled runtime instead of a PATH executable. */
  readonly packageManager?: ProfilePnpmInvocation
  readonly dir: string
  readonly patchPath: string
  readonly installAnchor: string
  readonly cwd: string
  readonly home: string
  /** Bundle packages used to start this process, before any persisted edits. */
  readonly startedBundles: readonly string[]
  /** Parsed command-line overlays, applied above profile and home patches. */
  readonly overlays: readonly PatchOptions[]
  /** Launch-time DSH_TELEMETRY_DISABLED value; any non-empty value opts out. */
  readonly telemetryDisabledEnv: string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only in a profile launched by dsh. */
    profileContext: ProfileContext
  }
}

const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/** Read current bundle and user layers with the launch-time overlays.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Detached ordered patches; this function does not update the Loader.
 */
export function readProfilePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  profileDebug('readProfilePatches', '组装有序配置层', { context, reuseInitialProfile: initialProfile !== undefined })
  const profile = initialProfile ?? loadProfileDirectory(binName, context.dir, context.installAnchor, { userLayer: false })
  const userPatches = initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? []
  const homePath = join(context.home, PROFILE_PATCH_FILENAME)
  const homePatches = loadOptionalPatches(binName, homePath) ?? []
  profileDebug('readProfilePatches', '应用顺序：bundle → Profile 用户层 → home 用户层 → 命令行覆盖层', {
    layers: [
      ...profile.layers.map(layer => ({ source: layer.packageName, paths: layer.patchPaths, patches: layer.patches })),
      { source: 'Profile 用户层', path: context.patchPath, patches: userPatches },
      { source: 'home 用户层', path: homePath, patches: homePatches },
      { source: '命令行覆盖层', patches: context.overlays },
    ],
  })
  const patches = structuredClone([
    ...profile.layers.flatMap(layer => layer.patches),
    ...userPatches,
    ...homePatches,
    ...context.overlays,
  ])
  const telemetryPatch = resolveTelemetryPatch(context.telemetryDisabledEnv,
    composeEntries([patches]).some(row => row.id === TELEMETRY_ROW_ID))
  profileDebug('readProfilePatches', '最后应用遥测开关；非空环境值且条目存在才追加禁用 patch', {
    disabledEnv: context.telemetryDisabledEnv, telemetryPatch,
  })
  if (telemetryPatch !== undefined) patches.push(telemetryPatch)
  return patches
}
