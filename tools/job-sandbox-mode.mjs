export const SANDBOX_LEGACY = "legacy";
export const SANDBOX_ISOLATED = "isolated";

export function isolatedEnabled(projectConfig) {
  if (!projectConfig || typeof projectConfig !== "object") return false;
  return projectConfig.isolated === true;
}

export function resolveSandboxMode(projectConfig) {
  return isolatedEnabled(projectConfig) ? SANDBOX_ISOLATED : SANDBOX_LEGACY;
}
