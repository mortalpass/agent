import type { RepoProfile } from "../investigate/contracts.js";

export const COMMAND_KINDS = ["install", "build", "test", "lint"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/**
 * Tokens come from an LLM; anything shell-reactive is rejected outright so no
 * quoting/escaping decision is ever needed. Commands are composed as argv and
 * split back into tokens for the provider, never rendered into a shell line.
 */
const UNSAFE_TOKEN = /[;&|`$><^(){}\[\]'"\\\n\r\s]/;

function isSafeToken(token: string): boolean {
  return token.length > 0 && !UNSAFE_TOKEN.test(token);
}

export type AllowedCommands = Partial<Record<CommandKind, string[]>>;

export function commandString(tokens: string[]): string {
  return tokens.join(" ");
}

function tokenize(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * Whitelist derived from the repo profile: package-manager install plus the
 * build/test/lint scripts from package.json. Empty arrays are kept distinct
 * from undefined so "declared but empty" is surfaced, not silently skipped.
 */
export function deriveAllowedCommands(profile: RepoProfile): AllowedCommands {
  const result: AllowedCommands = {};
  const installByManager: Record<string, string> = {
    npm: "npm install",
    pnpm: "pnpm install",
    yarn: "yarn install",
    bun: "bun install",
  };
  const install = installByManager[profile.packageManager ?? ""];
  if (install) result.install = tokenize(install);
  for (const kind of ["build", "test", "lint"] as const) {
    const command = profile.commands[kind];
    if (command) result[kind] = tokenize(command);
  }
  return result;
}

/**
 * Compose the final argv for a whitelisted kind:
 *   <base tokens from the profile> + <validated extra tokens>.
 * Extras equal to the kind name are dropped: models routinely send
 * `{kind: "build", args: ["build"]}`, and repeating it corrupts the argv
 * (`tsc -p . build` fails with TS5042, `npm install install` is not a no-op).
 * The returned string is for display/audit only; execution uses the tokens.
 */
export function composeCommand(
  kind: CommandKind,
  extraTokens: string[],
  allowed: AllowedCommands,
): { tokens: string[]; display: string; availableKinds: CommandKind[] } {
  const availableKinds = COMMAND_KINDS.filter((k) => Boolean(allowed[k]));
  const base = allowed[kind];
  if (!base) {
    const known = availableKinds.length
      ? availableKinds.join(", ")
      : "(none: the repo profile declares no install/build/test/lint command)";
    throw new Error(
      `Command kind "${kind}" is not whitelisted for this sandbox. Available kinds: ${known}`,
    );
  }
  const extras = extraTokens.filter((token) => token !== kind);
  if (extras.length > 64) {
    throw new Error(
      `Too many extra tokens for "${kind}" (${extras.length} > 64)`,
    );
  }
  const tokens = [...base, ...extras];
  for (const token of extras) {
    if (!isSafeToken(token)) {
      throw new Error(`Unsafe token rejected in "${kind}" command: ${token}`);
    }
  }
  return { tokens, display: commandString(tokens), availableKinds };
}
