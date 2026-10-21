// How Gyro launches claude: the executable, and an environment free of the launching session's markers.

export const CLAUDE = process.platform === 'win32' ? 'claude.exe' : 'claude';

/** Variables a running Claude session sets for its children (besides the CLAUDE_CODE_SESSION_/MESSAGING_ families). */
const SESSION_MARKERS = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
]);

export function childEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  // If Gyro was launched from inside a Claude session, that session's markers are in our env. Passed on,
  // they make each dock claude think it's a child of that session (no transcript saving, wrong messaging
  // socket). Drop them; user settings like CLAUDE_CODE_USE_BEDROCK pass through untouched.
  for (const key of Object.keys(env)) {
    if (SESSION_MARKERS.has(key) || /^CLAUDE_CODE_(SESSION|MESSAGING)_/.test(key)) delete env[key];
  }
  return env;
}
