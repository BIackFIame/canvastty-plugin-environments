// Service entry of the `remote-container` module (bundled to services/remote-container.mjs).
import { serve } from "../rpc.mjs";
import { CONTAINER_SETTINGS_KEY } from "../containerSettings.mjs";
import { createRemoteContainerEnvironment } from "../remoteContainer.mjs";
import { HOSTS_KEY } from "../sshHost.mjs";

let environment = null;
const ready = () => {
  if (!environment) throw new Error("The remote-container service is starting; try again.");
  return environment;
};

serve({
  onInitialize: ({ dataDir }, host) => {
    const read = (key) => async () => (await host.callHost("storage.get", { key })) ?? null;
    environment = createRemoteContainerEnvironment({ dataDir, readSettings: read(CONTAINER_SETTINGS_KEY), readHosts: async () => (await read(HOSTS_KEY)()) ?? [] });
  },
  methods: {
    "canvastty.environment.prepare": (params) => ready().prepare(params),
    "canvastty.environment.resume": (params) => ready().resume(params),
    "canvastty.environment.wrap": (params) => ready().wrap(params),
    "canvastty.environment.release": (params) => ready().release(params),
    "canvastty.environment.describe": (params) => ready().describe(params)
  }
});
