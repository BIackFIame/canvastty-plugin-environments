# CanvasTTY Environments

> **Status: preview.** This plugin needs CanvasTTY plugin API v2 (plugin services, launch contributors, session environments, decision hooks, plugin tools and card actions). Those extension points are proposed upstream and are not in a released CanvasTTY yet, so installing it on a current release fails the manifest check.

A CanvasTTY plugin (manifest apiVersion 2) that decides **where a card runs** and brings the work home.
[Русская версия](README.ru.md).

| Module | What it does |
|:--|:--|
| `worktree` | **Where → Git worktree**: the card runs in its own `git worktree` (a new branch `canvastty/<card>` or one you name) under the plugin's data folder. Your project folder is not touched. Closing the card asks "Keep environment data?"; *Remove* deletes the worktree and the branch it created. |
| `ssh-host` | **Where → SSH server**: the card runs on a server from the plugin's **Settings** page (label, ssh alias or host, user, port, and which local folder maps to which server folder). The launch becomes `ssh -tt <host> 'cd <server folder> && exec <shell or agent>'`; CanvasTTY keeps the terminal, scrollback and status. Before starting and on restore the plugin checks (within 8 s) that the server answers and the folder exists; otherwise the card stays stopped with the reason and never runs locally instead. Nothing is installed or deleted on the server. |
| `container` | **Where → Container**: the card runs in a Docker or Podman container on this computer (Docker first, then Podman; only an engine that already runs is used). The image comes from **Settings** (or the launcher's *Image* field), must already exist (it is never pulled) and must contain `python3`. `/workspace` is an owned copy (a git worktree in the plugin's data folder, collected with *Collect changes*) or, if you choose, the project folder itself. No network unless *Allow network* is ticked; read-only root, no capabilities, `no-new-privileges`, CPU/memory/process limits, a `noexec` `/tmp`, one non-recursive mount. What the engine created is compared with this recipe, and a fixed Python bootstrap checks the same from inside before anything runs. Each start of the card is `docker exec -it`; restore restarts the same container; closing removes it (and the copy unless you keep the data). |
| `remote-container` | **Where → Container on a server**: the same container on a server from **Settings** (the servers of `ssh-host`; Podman by default), in a copy of the mapped folder (a git worktree next to it, in `.canvastty-work/`) or the mapped folder itself. Each step is one ssh call; the card's shell is `ssh -tt <server> 'podman exec -it …'`. Nothing from this computer (variables, keys) is passed into the container. |
| `results` | **Collect changes** in the card menu of worktree, server and container cards, and the orchestrator tool `canvastty-environments__collect`: the card's work becomes a new local branch `canvastty/<id8>-<title>` in your repository (over ssh as a `git bundle` for servers). Credential files (`.env`, keys, `.npmrc`, …) are left out; nothing is merged; your current branch and working tree are never touched; nothing is left on the server except the repository's own objects. **Capsule checks** (worktree and container cards; tool `canvastty-environments__capsule`): *Run checks in a capsule* snapshots the card's working tree (credential files left out, a ref `refs/canvastty/capsules/<id>` keeps it), unpacks it into a fresh container without network and runs the check command from **Settings** once; the toast and the card badge show pass/fail and the last lines. *Show check result* shows it again; *Apply checked snapshot* turns a passed snapshot into a new branch `canvastty/<id8>-<title>-checked`. |

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
- The permissions shown at install: `storage` (the settings page: servers and container settings), `environment:provide`
  (worktree, ssh-host, container, remote-container), `tools:agents`, `cards:decorate`, `sessions:events` (results;
  events carry card metadata, never screen text).
- `container`, `remote-container` and capsule checks run the Docker/Podman CLI as you, with the plugin's own empty
  Docker config folder (no credential helpers or contexts from `~/.docker`). They never pull images or start Docker
  Desktop or a Podman machine.

## Limits of this first version

- Agent cards on a server run the same CLI by name from the server's login shell, without CanvasTTY's local bridges
  (status hooks, browser and orchestration tools): arguments that point at files on this computer are left out.
- Collecting must finish within CanvasTTY's 15 s budget for a tool call or card action. A capsule check keeps running
  after that; its badge shows the result and *Show check result* the log.
- Agent cards in a container need the agent's CLI in the image and *Allow network*; on a server, keys are not forwarded.
- Capsule checks run on this computer only (worktree and local container cards); collect a server card first.
- No server provisioning, metrics, placement across servers, or agents launched on selected files only.

## Develop

```sh
ESBUILD=/path/to/esbuild npm run build   # bundles services/ and settings/hosts.js, stamps the manifest
npm test                                 # node:test: quoting, validation, collect, containers and capsules (fake engine)
CTTY_TEST_IMAGE=<image with python3> npm test   # also one run against the real local Docker/Podman
```
