/**
 * Hub-issued installation agent-bot credential names. Unlike PLATFORM_ENV_NAMES
 * these arrive inside `envVars` on a Hub-signed deploy/reconfigure, because the
 * Hub mints the credential and the app declares the keys like ordinary config.
 * They are the ONLY PRIVOS_ names an envVars map may carry; the rest of the
 * namespace stays refused so a value can never impersonate a platform injection.
 *
 * Kept free of imports on purpose: both the master protocol schemas and the
 * agent request schemas consume this, and the master process must not drag the
 * agent's environment validation in through a schema import.
 */
export const RESERVED_AGENT_BOT_ENV_NAMES = ['PRIVOS_AGENT_BOT_CREDENTIAL', 'PRIVOS_AGENT_BOT_USER_ID'] as const;

const reservedAgentBotEnvNames: ReadonlySet<string> = new Set(RESERVED_AGENT_BOT_ENV_NAMES);

export const isAllowedReservedEnvName = (name: string): boolean => reservedAgentBotEnvNames.has(name);
