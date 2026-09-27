// The plugin's settings page (bundled to settings/hosts.js): servers for ssh-host and remote containers, and the
// container settings. Both live in the plugin's own storage; the services validate them again before every use, so
// this page only helps the person get them right.
import { CONTAINER_DEFAULTS, CONTAINER_SETTINGS_KEY, containerSettingsInvalidReason, normalizeContainerSettings } from "../containerSettings.mjs";
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

// Containers
const containers = document.querySelector("#containers");
const containerStatus = document.querySelector("#containers-status");
const sayContainers = (text) => { containerStatus.textContent = text; };

async function loadContainers() {
  const saved = normalizeContainerSettings(await host.storage.get(CONTAINER_SETTINGS_KEY));
  for (const [key, value] of Object.entries(saved)) {
    if (containers.elements[key]) containers.elements[key].value = String(value);
  }
}

async function saveContainers() {
  const data = Object.fromEntries(new FormData(containers));
  const candidate = {};
  for (const [key, fallback] of Object.entries(CONTAINER_DEFAULTS)) {
    const text = String(data[key] ?? "").trim();
    if (typeof fallback === "number") candidate[key] = text === "" ? fallback : Number(text);
    else candidate[key] = text;
  }
  const problem = containerSettingsInvalidReason(candidate);
  if (problem) return sayContainers(`Not saved: ${problem}.`);
  await host.storage.set(CONTAINER_SETTINGS_KEY, candidate);
  sayContainers("Saved containers.");
}

containers.addEventListener("submit", (event) => event.preventDefault());
document.querySelector("#save-containers").addEventListener("click", () => {
  saveContainers().catch((error) => sayContainers(`Not saved: ${error.message}`));
});
document.querySelector("#check-containers").addEventListener("click", async () => {
  sayContainers("Checking…");
  try {
    sayContainers((await host.service.request("container", "check", {})).message);
  } catch (error) {
    sayContainers(`Check failed: ${error instanceof Error ? error.message : String(error)} (is the Container module installed and its native code trusted?)`);
  }
});
loadContainers().catch((error) => sayContainers(`Could not load container settings: ${error.message}`));
