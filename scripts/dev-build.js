import { rm } from "node:fs/promises";
import process from "node:process";
import * as esbuild from "esbuild";

const sharedOptions = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "info",
};

const buildTargets = [
  {
    entryPoints: ["server/main.js"],
    outfile: "dist/index.js",
  },
  {
    entryPoints: ["bin/clawpool-claude.js"],
    outfile: "dist/daemon.js",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  },
];

async function startWatch() {
  await rm("dist", { recursive: true, force: true });
  const contexts = await Promise.all(
    buildTargets.map((target) => esbuild.context({
      ...sharedOptions,
      ...target,
    })),
  );
  await Promise.all(contexts.map((current) => current.watch()));
  process.stdout.write("watching dist/index.js and dist/daemon.js\n");

  const stop = async (signal) => {
    process.stdout.write(`stopping dev build (${signal})\n`);
    await Promise.all(contexts.map((current) => current.dispose()));
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    void stop("SIGTERM");
  });
}

await startWatch();
