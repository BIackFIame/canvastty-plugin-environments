// Service entry of the `ssh-host` module (bundled to services/ssh-host.mjs).
import { serve } from "../rpc.mjs";
import { HOSTS_KEY, checkRemoteFolder, createSshHostEnvironment } from "../sshHost.mjs";
import { chooseHost, normalizeHosts, remoteFolderFor } from "../hosts.mjs";

let environment = null;
let host = null;
const ready = () => {
  if (!environment) throw new Error("The ssh-host service is starting; try again.");
  return environment;
};
const readHosts = async () => (await host.callHost("storage.get", { key: HOSTS_KEY })) ?? [];

serve({
  onInitialize: ({ dataDir }, connection) => {
    host = connection;
    environment = createSshHostEnvironment({ dataDir, readHosts });
  },
  methods: {
    "canvastty.environment.prepare": (params) => ready().prepare(params),
    "canvastty.environment.resume": (params) => ready().resume(params),
    "canvastty.environment.wrap": (params) => ready().wrap(params),
    "canvastty.environment.release": (params) => ready().release(params),
    "canvastty.environment.describe": (params) => ready().describe(params),
    // From the settings page: is this server reachable, and (optionally) is a folder mapped and present there?
    async check({ label, folder }) {
      const hosts = normalizeHosts(await readHosts());
      const chosen = chooseHost(hosts, label);
      if (!chosen) return { ok: false, message: "No such server in the saved settings." };
      const remote = folder ? remoteFolderFor(chosen, folder) : chosen.workspaces[0]?.remotePath ?? "/";
      if (!remote) return { ok: false, message: `${folder} is not mapped on ${chosen.label}.` };
      const problem = await checkRemoteFolder(chosen, remote, { timeoutMs: 8_000 });
      return problem ? { ok: false, message: problem } : { ok: true, message: `${chosen.label} answers; ${remote} exists.` };
    }
  }
});
