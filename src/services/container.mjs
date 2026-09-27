// Service entry of the `container` module (bundled to services/container.mjs).
import { serve } from "../rpc.mjs";
import { CONTAINER_SETTINGS_KEY, createContainerEnvironment } from "../container.mjs";
import { detectLocalEngine, parseImage, runEngine } from "../engine.mjs";
import { normalizeContainerSettings } from "../containerSettings.mjs";

let environment = null;
let host = null;
let dataDir = null;
const ready = () => {
  if (!environment) throw new Error("The container service is starting; try again.");
  return environment;
};
const readSettings = async () => (await host.callHost("storage.get", { key: CONTAINER_SETTINGS_KEY })) ?? null;

serve({
  onInitialize: ({ dataDir: folder }, connection) => {
    host = connection;
    dataDir = folder;
    environment = createContainerEnvironment({ dataDir, readSettings });
  },
  methods: {
    "canvastty.environment.prepare": (params) => ready().prepare(params),
    "canvastty.environment.resume": (params) => ready().resume(params),
    "canvastty.environment.wrap": (params) => ready().wrap(params),
    "canvastty.environment.release": (params) => ready().release(params),
    "canvastty.environment.describe": (params) => ready().describe(params),
    // From the settings page: which engine runs here, and is the image there?
    async check() {
      ready();
      const settings = normalizeContainerSettings(await readSettings());
      try {
        const engine = await detectLocalEngine({ preferred: settings.engine, dataDir });
        const where = `${engine.kind === "docker" ? "Docker" : "Podman"}${engine.rootless ? " (rootless)" : ""} runs on this computer`;
        if (!settings.image) return { ok: false, message: `${where}; no image is set yet.` };
        try {
          parseImage(await runEngine(engine, ["image", "inspect", settings.image], { timeoutMs: 6_000 }));
          return { ok: true, message: `${where}; the image ${settings.image} is there.` };
        } catch (error) {
          return { ok: false, message: `${where}, but the image ${settings.image} cannot be used: ${error.message}` };
        }
      } catch (error) {
        return { ok: false, message: error.message };
      }
    }
  }
});
