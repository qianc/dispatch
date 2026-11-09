// The steps that set up a worker on a new machine (DISP-68), in two forms: a prompt for an LLM on that
// machine, and plain text for a person. Both come from the same step list, so they cannot drift apart.
// Nothing here is secret: the server address, the build, and the name and description the owner typed.
// The token is never filled in; the steps say where the owner pastes it.

/** The repository's address as the README writes it; the owner's own address is typed on the page. */
export const REPO_PLACEHOLDER = 'https://github.com/<you>/dispatch';

export interface WorkerSetupInput {
  /** the app's address, from location.origin */
  server: string;
  /** the build the server runs, as Settings shows it ("2026-11-09 12:34", UTC) */
  build: string;
  /** the public repository with the code (remembered on the device); empty: the LLM asks the owner */
  repo: string;
  /** the worker's name (lowercase letters, digits and dashes); empty: the owner picks one */
  name: string;
  /** what the machine has and when to use it; the planner reads it */
  description: string;
}

/** `SERVER_WS_URL` for a server at this web address. */
export const workerSocketUrl = (server: string) => `${server.replace(/^http/, 'ws').replace(/\/$/, '')}/worker`;

/** Is this a build stamp like "2026-11-09 12:34"? (the test render has "test") */
const isBuildStamp = (build: string) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(build);

export interface SetupStep { title: string; lines: string[] }

const ENV_FILE = '~/.config/dispatch/worker.env';

/**
 * The steps, in order. Written as instructions, so they read the same to a person and to an LLM
 * that walks the person through them. "The owner" is the person who runs Dispatch.
 */
export function workerSetupSteps({ server, build, repo, name, description }: WorkerSetupInput): SetupStep[] {
  const worker = name.trim() || '<a name: lowercase letters, digits and dashes>';
  const about = description.trim() || '<what this machine has and when to use it>';
  const code = repo.trim().replace(/\/$/, '') || REPO_PLACEHOLDER;
  const checkout = isBuildStamp(build)
    ? [`The server runs the build from ${build} UTC. Check out the commit of \`main\` from just before that time, so the worker matches the server:`,
      `    git checkout --detach "$(git rev-list -1 --before='${build} +0000' origin/main)"`,
      'If the owner would rather run the latest code, stay on `main` instead.']
    : ['Stay on `main`: it is the version the server runs.'];
  return [
    {
      title: 'Check the machine',
      lines: [
        'The worker needs `git` and Node 24 or newer (`node --version`), or Docker with Compose.',
        'On Windows, do all of this inside WSL. Agents can then also run Windows programs (PowerPoint, PowerShell).',
        'Installing Node, git or Docker changes the machine: ask the owner first and let them choose how.',
      ],
    },
    {
      title: 'Get the code',
      lines: [
        ...(repo.trim() ? [] : ['Ask the owner for the address of the Dispatch repository (the public repository the server was built from): it is public, so no login is needed to clone it.']),
        `Clone it into the home folder and install only what the worker runs:`,
        `    git clone ${code} ~/dispatch && cd ~/dispatch && npm ci --omit=dev`,
        ...checkout,
        'With Docker, the clone is enough: the image is built in the next steps.',
      ],
    },
    {
      title: 'Create the worker in Dispatch and get its token',
      lines: [
        `The owner does this in the Dispatch app at ${server}, signed in as themselves: Settings → Workers → New worker.`,
        `Name: ${worker}`,
        `Description: ${about}`,
        'Create worker shows the token once (it starts with `dsw_`). The owner copies it. Nobody else needs to see it, and it must not go into a chat that is logged or shared.',
        'If the token is lost, revoke the worker in Settings and make a new one.',
      ],
    },
    {
      title: 'Write the worker config',
      lines: [
        `Make the config file from the example and keep it private:`,
        `    mkdir -p ~/.config/dispatch && cp ~/dispatch/docker/worker.env.example ${ENV_FILE} && chmod 600 ${ENV_FILE}`,
        `Set these lines in ${ENV_FILE}:`,
        `    SERVER_WS_URL=${workerSocketUrl(server)}`,
        '    WORKER_TOKEN=   ← the owner pastes the dsw_ token here, in the editor, themselves',
        'Set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` and the `GIT_COMMITTER_` pair to the name and email the commits should carry.',
        'Leave `CLAUDE_CODE_OAUTH_TOKEN` empty to use this machine\'s own Claude Code login (next step).',
        `With Docker, the file is \`worker.env\` next to \`compose.worker.yml\` in the clone instead of ${ENV_FILE}.`,
      ],
    },
    {
      title: 'Sign in to Claude on this machine',
      lines: [
        'Install Claude Code if it is missing (ask the owner first), then run `claude` and type `/login`; the owner finishes the sign-in in the browser. The worker uses this login.',
        `Or the owner runs \`claude setup-token\` in a terminal of their own and pastes the token it prints after \`CLAUDE_CODE_OAUTH_TOKEN=\` in ${ENV_FILE}, as with the worker token. This is the way with Docker.`,
        'Check it: `claude -p "Reply with the word ok"` should answer without asking to sign in.',
      ],
    },
    {
      title: 'Give the worker GitHub access',
      lines: [
        'The worker clones, pushes and opens pull requests with its own GitHub token. The owner makes one on GitHub: fine-grained, on the repositories the agents work on, with Contents read and write, Pull requests read and write and Actions read (a classic token with `repo` also works).',
        `The owner pastes it after \`GITHUB_TOKEN=\` in ${ENV_FILE}.`,
        'Check it without showing the token: `set -a; . ~/.config/dispatch/worker.env; set +a; curl -s -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user | grep \'"login"\'`',
        'People who connected their own GitHub account in Settings → Your GitHub run their sessions with that account; the worker token is for everything else.',
      ],
    },
    {
      title: 'Start the worker as a service',
      lines: [
        'Without Docker (Linux, or WSL with systemd on), as a user service that starts on boot:',
        '    mkdir -p ~/.config/systemd/user && cp ~/dispatch/docs/examples/dispatch-worker.service ~/.config/systemd/user/',
        '    systemctl --user daemon-reload && systemctl --user enable --now dispatch-worker',
        '    loginctl enable-linger "$USER"',
        'Check the unit\'s two paths first: the clone (`WorkingDirectory=%h/dispatch`) and the node binary (`ExecStart=/usr/bin/node`, see `which node`).',
        'Logs: `journalctl --user -u dispatch-worker -f`. They may show the server address, never the token.',
        'With Docker: `cd ~/dispatch && docker compose -f compose.worker.yml up -d --build`, and `docker compose -f compose.worker.yml logs -f` for the logs.',
      ],
    },
    {
      title: 'Check it is online',
      lines: [
        `In Dispatch at ${server}, Settings → Workers shows ${worker} with a green dot and "online", its system, and its Claude and GitHub accounts. Press Check on the Claude row if it is not marked logged in.`,
        'On each project, Settings → Where work runs picks the default worker and tells the planner when to use this one.',
      ],
    },
  ];
}

/** Lines that `    ` indents are commands: the plain view shows them as code. */
export const isCommandLine = (line: string) => line.startsWith('    ');

/**
 * The prompt the owner pastes into an LLM on the new machine. It carries no token, login or secret:
 * the steps say where the owner pastes the token, and the LLM never needs to see it.
 */
export function workerSetupPrompt(input: WorkerSetupInput): string {
  const { server, build, name, description } = input;
  const worker = name.trim() || 'a worker (the owner picks the name: lowercase letters, digits and dashes)';
  const steps = workerSetupSteps(input);
  const head = [
    `You are helping me set up a Dispatch worker on this machine. Dispatch is a personal project tracker that runs Claude Code sessions on my repositories. The server (the app I open) is at ${server}${isBuildStamp(build) ? `, running the build from ${build} UTC` : ''}. A worker is the process on a machine that connects out to the server and runs the agent sessions, with its own Claude login and GitHub access. The server holds no Claude login and runs no agents.`,
    '',
    `We are setting up the worker ${worker}.${description.trim() ? ` It is for: ${description.trim()}` : ''}`,
    '',
    'How to work with me:',
    '- Go through the steps below in order. Before each step, say what it does and what it changes. Do the terminal steps yourself on this machine and show me each command before you run it. I do the steps that need the Dispatch app or a browser sign-in, and I tell you when they are done.',
    '- Stop and ask me before any step that changes the machine beyond the worker\'s own folders (~/dispatch, ~/.config/dispatch, ~/.config/systemd/user, ~/.claude): installing Node, git, Docker or Claude Code, changing PATH, enabling systemd or linger, or anything with sudo.',
    '- Never ask me to paste a token into this chat, and never print a token: not in the terminal, not in a log, not in your messages. When a file needs a token, write the file with the value empty, then tell me which line to fill in and let me do it in an editor. Read the file back only with the token line hidden, e.g. `grep -v TOKEN`.',
    '- You never need my Dispatch sign-in, my Claude password or my GitHub password. If something seems to need them, stop and ask.',
    '- When a check fails, show me the error and propose one fix; do not retry blindly.',
    '',
    'The steps:',
    '',
  ];
  const body = steps.flatMap((s, i) => [
    `## ${i + 1}. ${s.title}`,
    ...s.lines.map((l) => (isCommandLine(l) ? l : `- ${l}`)),
    '',
  ]);
  const tail = [
    `When the worker shows online in Settings → Workers at ${server}, say so, and list what you changed on this machine.`,
  ];
  return [...head, ...body, ...tail].join('\n');
}
