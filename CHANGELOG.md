# Changelog

## Unreleased

Requires the CanvasTTY core with plugin API v2 and the environment `keeps` declaration: the upcoming release after 1.7.0.

### What you'll notice

- Closing a card can only remove what this plugin created for it: a worktree release deletes only the branch git lists in that worktree, and a server container's release only the derived `.canvastty-work` copy and its `canvastty/<id>` branch (the server script refuses any other branch).
- Each card says what it keeps of CanvasTTY's protection. A worktree card runs every profile inside CanvasTTY's isolation layer; server and container cards run the normal profile only, and their tooltip leads with what does not apply there (hooks and base protection).
- Closing a card while its container is still being prepared waits for that prepare, so the containers under the card's label are only ever its own attempt's; a second capsule run waits for the first instead of starting its own.
- A file whose name is not valid UTF-8 stops Collect changes with a clear reason instead of being collected (and credential-checked) under the wrong name.
- The hosts page refuses a 17th server instead of saving one the services never read, and removing a server removes the one you clicked.
- A switch right before a left-out local argument is kept on server launches.

### Environments and ownership

- Each environment declares `keeps`: worktree `launch`; ssh-host `isolated`; container and remote-container `isolated` and `confines`.
- A card's container prepare and release run one at a time (local and remote); a second prepare is refused before its first await, and a release waits for the prepare in flight.
- A capsule run takes the card's place before its first await, and only the run's own entry is removed.
- Worktree folders are owned by real path: a direct child of the plugin's worktrees folder, not a link or reached through one, and released, collected or checked only if git lists it as a worktree of the ref's repository.
- remote-container copies must match the triple prepare derives (workspace `<parent of top>/.canvastty-work/<top name>-<id>`, branch `canvastty/<id>`, id from the card's session); the server script deletes only `canvastty/*` branches.
- A worktree release deletes a branch only when git lists it as checked out in that worktree (also when the folder is gone); the local container's copy release takes the same path.

### Results and hosts

- The results service waits for the first card list before deciding a session is not the caller's subagent, and a card closed meanwhile is not brought back.
- Non-UTF-8 changed file names are refused.
- A left-out local argument takes only a known value flag with it.
- The hosts page removes by label, not row position, and updates its list only after storage accepted the change.

### Service transport

- Host calls fail after 30 s and past 64 in flight; all pending calls fail when the host closes the connection.
- Incoming frames are cut from raw bytes at the host's 1 MiB limit; an oversized frame is skipped to its newline. Requests beyond 64 running handlers are answered busy.
- A frame over 1 MiB is never written (an answer becomes an error, a host call fails). While the host is not reading, frames wait for `drain` and waiting logs are capped at 8 MiB, oldest first; answers and host calls are never dropped.
- On shutdown or end of input the services take no new work and let running handlers answer during a short drain.
