// The ssh-host settings page (bundled to settings/hosts.js). Hosts live in the plugin's own storage; the service
// validates them again before every use, so this page only helps the person get them right.
import { hostInvalidReason, normalizeHosts } from "../hosts.mjs";

const host = window.CanvasTTYPlugin;
const list = document.querySelector("#list");
const form = document.querySelector("#form");
const status = document.querySelector("#status");
let hosts = [];

const say = (text) => { status.textContent = text; };

async function load() {
  hosts = normalizeHosts(await host.storage.get("hosts"));
  render();
}

function render() {
  list.replaceChildren(...hosts.map((entry, index) => {
    const item = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = entry.label;
    const where = document.createElement("code");
    where.className = "grow";
    const destination = `${entry.sshUser ? `${entry.sshUser}@` : ""}${entry.sshHost}${entry.sshPort ? `:${entry.sshPort}` : ""}`;
    where.textContent = `${destination}  ${entry.workspaces.map((w) => `${w.localPath} → ${w.remotePath}`).join(", ")}`;
    const check = document.createElement("button");
    check.type = "button";
    check.textContent = "Check";
    check.addEventListener("click", async () => {
      say(`Checking ${entry.label}…`);
      try {
        const answer = await host.service.request("ssh-host", "check", { label: entry.label });
        say(answer.message);
      } catch (error) {
        say(`Check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      hosts = hosts.filter((_, other) => other !== index);
      await host.storage.set("hosts", hosts);
      render();
      say(`Removed ${entry.label}.`);
    });
    item.append(name, where, check, remove);
    return item;
  }));
  if (hosts.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No servers yet.";
    list.append(empty);
  }
}

// The page runs in a sandboxed frame without allow-forms, so the form is never submitted: the button saves.
async function save() {
  const data = Object.fromEntries(new FormData(form));
  const label = String(data.label).trim();
  const existing = hosts.find((entry) => entry.label.toLowerCase() === label.toLowerCase());
  const mapping = { localPath: String(data.localPath).trim(), remotePath: String(data.remotePath).trim() };
  const workspaces = [...(existing?.workspaces ?? []).filter((w) => w.localPath !== mapping.localPath), mapping];
  const candidate = {
    label,
    sshHost: String(data.sshHost).trim(),
    ...(String(data.sshUser).trim() ? { sshUser: String(data.sshUser).trim() } : {}),
    ...(String(data.sshPort).trim() ? { sshPort: Number(String(data.sshPort).trim()) } : {}),
    workspaces
  };
  const problem = hostInvalidReason(candidate);
  if (problem) return say(`Not saved: ${problem}.`);
  hosts = [...hosts.filter((entry) => entry !== existing), candidate];
  await host.storage.set("hosts", hosts);
  render();
  say(`Saved ${label}.`);
}

form.addEventListener("submit", (event) => event.preventDefault());
document.querySelector("#save").addEventListener("click", () => {
  save().catch((error) => say(`Not saved: ${error.message}`));
});

load().catch((error) => say(`Could not load servers: ${error.message}`));
