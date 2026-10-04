// 700 AI ships with 40+ built-in skills/commands.
// `kind: 'prompt'` skills steer the model; `kind: 'action'` skills run local code.
// Extra skills can be added by plugins via the plugin loader.
export const SKILLS = [
  // ── Core actions ─────────────────────────────────────────────
  { name: 'setup', kind: 'action', group: 'core', desc: 'Guided setup — pick provider, model, search' },
  { name: 'wallet', kind: 'action', group: 'core', desc: 'Open your private earnings wallet' },
  { name: 'skills', kind: 'action', group: 'core', desc: 'List all skills/commands' },
  { name: 'model', kind: 'action', group: 'core', desc: 'Switch the model for this session (all providers)' },
  { name: 'models', kind: 'action', group: 'core', desc: 'Add a custom model (name, model ID, API key)' },
  { name: 'provider', kind: 'action', group: 'core', desc: 'Add/remove providers or re-key (runs setup)' },
  { name: 'plugins', kind: 'action', group: 'core', desc: 'Browse / install plugins from the 700 AI store' },
  { name: 'agents', kind: 'action', group: 'core', desc: 'Create and manage custom AI agents' },
  { name: 'new', kind: 'action', group: 'core', desc: 'Start a new session' },
  { name: 'session', kind: 'action', group: 'core', desc: 'Switch between saved sessions' },
  { name: 'image', kind: 'action', group: 'create', desc: 'Generate an image from a prompt' },
  { name: 'build', kind: 'action', group: 'create', desc: 'Build an app/site with a live visual work window' },
  { name: 'stage', kind: 'action', group: 'create', desc: 'Stage a file (audio/video/doc/code) as multimodal context' },
  { name: 'staged', kind: 'action', group: 'create', desc: 'List files staged into the session' },
  { name: 'unstage', kind: 'action', group: 'create', desc: 'Remove a staged file (index, name, or all)' },
  { name: 'deploy', kind: 'action', group: 'core', desc: 'Commit & push the workspace to GitHub (classic token)' },
  { name: 'route', kind: 'action', group: 'core', desc: 'Configure speculative routing (fast model for simple asks)' },
  { name: 'states', kind: 'action', group: 'core', desc: 'Preview the five agent-state animations' },

  // ── Music ───────────────────────────────────────────────────
  { name: 'music', kind: 'action', group: 'music', desc: 'Connect Spotify or Apple Music' },
  { name: 'play', kind: 'action', group: 'music', desc: 'Play a song or playlist' },
  { name: 'playlists', kind: 'action', group: 'music', desc: 'List and switch playlists' },
  { name: 'pause', kind: 'action', group: 'music', desc: 'Pause playback' },
  { name: 'next', kind: 'action', group: 'music', desc: 'Skip to the next track' },
  { name: 'prev', kind: 'action', group: 'music', desc: 'Back to the previous track' },
  { name: 'nowplaying', kind: 'action', group: 'music', desc: 'Show what is playing now' },

  { name: 'clear', kind: 'action', group: 'core', desc: 'Clear the conversation' },
  { name: 'help', kind: 'action', group: 'core', desc: 'Show help' },
  { name: 'exit', kind: 'action', group: 'core', desc: 'Quit 700 AI' },

  // ── Prompt/coding skills ────────────────────────────────────
  { name: 'code', kind: 'prompt', group: 'code', desc: 'Write code to spec',
    system: 'You are a senior engineer. Write clean, correct, runnable code. Explain briefly, then give the full file.' },
  { name: 'review', kind: 'prompt', group: 'code', desc: 'Review code for bugs & style',
    system: 'Review the code the user pastes. List bugs, security issues, and concrete fixes.' },
  { name: 'debug', kind: 'prompt', group: 'code', desc: 'Diagnose an error',
    system: 'Act as a debugger. Given an error/stack trace, find root cause and give a minimal fix.' },
  { name: 'explain', kind: 'prompt', group: 'code', desc: 'Explain code or a concept',
    system: 'Explain clearly and concisely, from first principles, with a small example.' },
  { name: 'refactor', kind: 'prompt', group: 'code', desc: 'Refactor for clarity',
    system: 'Refactor the given code for readability and reuse without changing behavior. Show a diff-style before/after.' },
  { name: 'test', kind: 'prompt', group: 'code', desc: 'Write tests',
    system: 'Write thorough unit tests for the given code, covering edge cases.' },
  { name: 'regex', kind: 'prompt', group: 'code', desc: 'Build & explain a regex',
    system: 'Produce a correct regex for the request and explain each token.' },
  { name: 'sql', kind: 'prompt', group: 'code', desc: 'Write/optimize SQL',
    system: 'Write correct, optimized SQL and explain the query plan considerations.' },
  { name: 'shell', kind: 'prompt', group: 'code', desc: 'Craft a shell/one-liner',
    system: 'Produce a safe shell command for the task. Warn about anything destructive.' },
  { name: 'docs', kind: 'prompt', group: 'code', desc: 'Generate documentation',
    system: 'Write clear docs/README content for the given code or project.' },
  { name: 'commit', kind: 'prompt', group: 'code', desc: 'Write a commit message',
    system: 'Write a conventional-commits message for the described change.' },

  // ── Writing & knowledge skills ──────────────────────────────
  { name: 'write', kind: 'prompt', group: 'write', desc: 'Draft prose / long-form',
    system: 'You are a sharp writer. Draft clear, engaging prose in the requested voice.' },
  { name: 'summarize', kind: 'prompt', group: 'write', desc: 'Summarize text',
    system: 'Summarize the input faithfully. Lead with a one-line TL;DR, then key points.' },
  { name: 'translate', kind: 'prompt', group: 'write', desc: 'Translate between languages',
    system: 'Translate accurately, preserving tone. Note idioms that do not map cleanly.' },
  { name: 'rewrite', kind: 'prompt', group: 'write', desc: 'Rewrite / change tone',
    system: 'Rewrite the text in the requested tone while keeping the meaning.' },
  { name: 'brainstorm', kind: 'prompt', group: 'write', desc: 'Generate ideas',
    system: 'Brainstorm a diverse, non-obvious list of ideas, then recommend the top 3.' },
  { name: 'email', kind: 'prompt', group: 'write', desc: 'Draft an email',
    system: 'Draft a concise, professional email for the described situation.' },
  { name: 'search', kind: 'prompt', group: 'know', desc: 'Web-search-augmented answer',
    system: 'Answer using the configured search provider results when available; cite sources.' },
  { name: 'plan', kind: 'prompt', group: 'know', desc: 'Break a goal into a plan',
    system: 'Turn the goal into a concrete, ordered, step-by-step plan with milestones.' },
  { name: 'math', kind: 'prompt', group: 'know', desc: 'Solve math step by step',
    system: 'Solve the problem step by step, showing work, then box the final answer.' },
  { name: 'json', kind: 'prompt', group: 'code', desc: 'Return structured JSON',
    system: 'Respond ONLY with valid JSON matching the user request. No prose.' },
  // Note: /voice is provided by the ElevenLabs plugin (see plugins/elevenlabs),
  // so it is intentionally NOT listed here to avoid a duplicate entry.
];

export function getSkill(name) {
  return SKILLS.find((s) => s.name === name.toLowerCase());
}
