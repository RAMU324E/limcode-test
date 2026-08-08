export const SETTINGS_REVISION_CONFLICT_NAME = 'SettingsRevisionConflictError';

/** 旧窗口试图覆盖较新设置时抛出的可识别错误。 */
export class SettingsRevisionConflictError extends Error {
  public readonly settingsRevisionConflict = true;

  public constructor(
    public readonly section: string,
    public readonly expectedRevision: string,
    public readonly actualRevision: string
  ) {
    super(`设置「${section}」已在其他窗口修改，本次保存已被拒绝以避免覆盖。已重新读取最新值，请确认后再保存。`);
    this.name = SETTINGS_REVISION_CONFLICT_NAME;
  }
}

export function isSettingsRevisionConflictError(error: unknown): error is SettingsRevisionConflictError {
  if (error instanceof SettingsRevisionConflictError) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { settingsRevisionConflict?: unknown; name?: unknown };
  return candidate.settingsRevisionConflict === true || candidate.name === SETTINGS_REVISION_CONFLICT_NAME;
}
