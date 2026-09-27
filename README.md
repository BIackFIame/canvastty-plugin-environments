# CanvasTTY Environments

A CanvasTTY plugin (manifest apiVersion 2) that decides **where a card runs** and brings the work home.
[Русская версия](README.ru.md).

| Module | What it does |
|:--|:--|
| `worktree` | **Where → Git worktree**: the card runs in its own `git worktree` (a new branch `canvastty/<card>` or one you name) under the plugin's data folder. Your project folder is not touched. Closing the card asks "Keep environment data?"; *Remove* deletes the worktree and the branch it created. |
| `ssh-host` | **Where → SSH server**: the card runs on a server from the plugin's **Settings** page (label, ssh alias or host, user, port, and which local folder maps to which server folder). The launch becomes `ssh -tt <host> 'cd <server folder> && exec <shell or agent>'`; CanvasTTY keeps the terminal, scrollback and status. Before starting and on restore the plugin checks (within 8 s) that the server answers and the folder exists; otherwise the card stays stopped with the reason and never runs locally instead. Nothing is installed or deleted on the server. |
| `results` | **Collect changes** in the card menu of worktree and server cards, and the orchestrator tool `canvastty-environments__collect`: the card's work becomes a new local branch `canvastty/<id8>-<title>` in your repository (over ssh as a `git bundle` for servers). Credential files (`.env`, keys, `.npmrc`, …) are left out; nothing is merged; your current branch and working tree are never touched; nothing is left on the server except the repository's own objects. |

## Install

In CanvasTTY: **Extensions → Install from GitHub**, paste this repository's URL, pick the modules, install.
The package is ready to install as is: the services are bundled single files (`services/*.mjs`) and the manifest
carries the size and SHA-256 of every file.

## Trust prompts

- Installing only copies files. The services start after you confirm **Extension native code** for this plugin in
  **Settings → Agents** (it runs as you, like any program you start). Updating the plugin or changing modules revokes
  that confirmation.
- `ssh-host` stores only host names, users, ports and folder paths in the plugin's storage. No passwords or keys:
  ssh uses your own `~/.ssh/config` and agent. Use hosts you trust with the code you open there.
- The permissions shown at install: `environment:provide` (worktree, ssh-host), `storage` (ssh-host),
  `tools:agents`, `cards:decorate`, `sessions:events` (results; events carry card metadata, never screen text).

## Limits of this first version

- Agent cards on a server run the same CLI by name from the server's login shell, without CanvasTTY's local bridges
  (status hooks, browser and orchestration tools): arguments that point at files on this computer are left out.
- Collecting must finish within CanvasTTY's 15 s budget for a tool call or card action.
- No server provisioning, metrics, placement or containers yet.

## Develop

```sh
ESBUILD=/path/to/esbuild npm run build   # bundles services/ and settings/hosts.js, stamps the manifest
npm test                                 # node:test: quoting, validation, collect with temp repos and a fake ssh
```
