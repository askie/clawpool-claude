import process from "node:process";

function usage() {
  return `用法:
  grix-claude worker

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

  print("不要手动运行 worker。Claude 会话会在 daemon 调度下自动加载它。");
  return 1;
}

export async function main(argv = process.argv.slice(2)) {
  process.exitCode = await run(argv);
}
