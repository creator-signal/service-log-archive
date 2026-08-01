import { loadConfig } from "./config.mjs";
import { StateStore } from "./state.mjs";
import { Authenticator } from "./auth.mjs";
import { RotationEngine } from "./rotation.mjs";
import { createLogArchiveServer } from "./server.mjs";

const config = await loadConfig();
const store = new StateStore(config);
await store.load();
const auth = new Authenticator(config);
await auth.load();
const engine = new RotationEngine(config, store);
await engine.start();
const server = createLogArchiveServer({ config, store, auth, engine });

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ level: "info", event: "service.ready", host: config.host, port: config.port }));
});

const shutdown = () => {
  engine.stop();
  server.close((error) => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

