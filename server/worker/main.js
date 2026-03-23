import process from "node:process";

function usage() {
  return `用法:
  clawpool-claude worker

说明:
  worker 由 daemon 管理，用于承载固定目录和固定 Claude 会话。
`;
}

function print(message) {
  process.stdout.write(`${message}\n`);
}

export async function run(argv = []) {
  if (argv.includes("--help") || argv.includes("-h")) {
    print(usage());
    return 0;
  }

  print("clawpool-claude worker 命令已就绪。");
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  process.exitCode = await run(argv);
}
