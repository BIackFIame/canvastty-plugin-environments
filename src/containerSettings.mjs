// Container settings as the person saves them on the plugin's settings page (plugin storage key "containers").
// Pure: the page, the container services and the capsule checks all read them through normalizeContainerSettings.

export const CONTAINER_SETTINGS_KEY = "containers";

export const CONTAINER_DEFAULTS = Object.freeze({
  engine: "auto", // this computer: auto (Docker, then Podman), docker or podman
  remoteEngine: "podman", // on a server: podman or docker, by name on the server's PATH
  image: "", // an existing image with python3; never pulled
  cpus: 2,
  memoryMb: 2048,
  pids: 512,
  checkCommand: "", // capsule checks: run with /bin/sh -c in /workspace
  checkTimeoutSec: 600
});

const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/u;
const NUMBERS = { cpus: [0.1, 64], memoryMb: [64, 262_144], pids: [16, 65_536], checkTimeoutSec: [10, 3_600] };

/** Why a settings object cannot be saved, or null. Unknown fields are refused so typos do not pass silently. */
export function containerSettingsInvalidReason(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "settings must be an object";
  const unknown = Object.keys(value).find((key) => !(key in CONTAINER_DEFAULTS));
  if (unknown) return `unknown field ${unknown.slice(0, 40)}`;
  if (value.engine !== undefined && !["auto", "docker", "podman"].includes(value.engine)) return "engine must be auto, docker or podman";
  if (value.remoteEngine !== undefined && !["docker", "podman"].includes(value.remoteEngine)) return "server engine must be docker or podman";
  if (value.image !== undefined && value.image !== "" && !imageValid(value.image)) return "image must be a name like python:3.12-slim (letters, digits, . _ / : @ -)";
  for (const [key, [min, max]] of Object.entries(NUMBERS)) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < min || value[key] > max) return `${key} must be a number from ${min} to ${max}`;
    if (key !== "cpus" && !Number.isInteger(value[key])) return `${key} must be a whole number`;
  }
  if (value.checkCommand !== undefined && (typeof value.checkCommand !== "string" || value.checkCommand.length > 2_000 || value.checkCommand.includes("\0"))) {
    return "the check command is at most 2000 characters";
  }
  return null;
}

export function imageValid(image) {
  return typeof image === "string" && IMAGE.test(image) && !image.includes("..");
}

/** The saved settings merged over the defaults; anything invalid falls back to the defaults as a whole. */
export function normalizeContainerSettings(value) {
  if (value === undefined || value === null || containerSettingsInvalidReason(value) !== null) return { ...CONTAINER_DEFAULTS };
  return { ...CONTAINER_DEFAULTS, ...value };
}
