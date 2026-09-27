// Service entry of the `worktree` module (bundled to services/worktree.mjs).
import { serve } from "../rpc.mjs";
import { createWorktreeEnvironment } from "../worktree.mjs";

let environment = null;
const ready = () => {
  if (!environment) throw new Error("The worktree service is starting; try again.");
  return environment;
};

serve({
  onInitialize: ({ dataDir }) => {
    environment = createWorktreeEnvironment({ dataDir });
  },
  methods: {
    "canvastty.environment.prepare": (params) => ready().prepare(params),
    "canvastty.environment.resume": (params) => ready().resume(params),
    "canvastty.environment.wrap": (params) => ready().wrap(params),
    "canvastty.environment.release": (params) => ready().release(params),
    "canvastty.environment.describe": (params) => ready().describe(params)
  }
});
