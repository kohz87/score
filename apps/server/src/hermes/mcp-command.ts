// The command the owner runs by hand to give a profile Score's MCP entry. Score only shows it: `hermes mcp add` writes
// the profile's Hermes config, which needs the owner's OK. The CLI asks for the bearer token on its own prompt and keeps
// it in the profile's environment file, so the token is not in the command (nor in shell history).
export const MCP_SERVER_NAME = 'score'

const SAFE_PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function mcpAddCommand(profile: string, url: string): string | null {
  if (!SAFE_PROFILE.test(profile)) return null
  return `hermes --profile ${profile} mcp add ${MCP_SERVER_NAME} --url ${url} --auth header`
}
