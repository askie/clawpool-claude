import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveLinuxUserUnitPath,
  resolveMacOSLaunchAgentPath,
} from "./service-paths.js";

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

function windowsQuote(value) {
  const text = String(value ?? "");
  if (!text || /[\s"]/u.test(text)) {
    return `"${text.replace(/"/g, '\\"')}"`;
  }
  return text;
}

function buildProgramArgs({ nodePath, cliPath, dataDir }) {
  return [
    nodePath,
    cliPath,
    "daemon",
    "--data-dir",
    dataDir,
  ];
}

function buildMacOSLaunchAgentPlist({
  serviceID,
  nodePath,
  cliPath,
  dataDir,
  stdoutPath,
  stderrPath,
  environmentPath = "",
}) {
  const args = buildProgramArgs({ nodePath, cliPath, dataDir });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(serviceID)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((item) => `    <string>${xmlEscape(item)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(path.dirname(cliPath))}</string>
${environmentPath ? `  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(environmentPath)}</string>
  </dict>
` : ""}  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

function buildLinuxUserUnit({
  serviceID,
  nodePath,
  cliPath,
  dataDir,
  stdoutPath,
  stderrPath,
}) {
  const execStart = buildProgramArgs({ nodePath, cliPath, dataDir })
    .map((item) => shellQuote(item))
    .join(" ");
  return `[Unit]
Description=clawpool-claude daemon (${serviceID})
After=default.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${path.dirname(cliPath)}
Restart=always
RestartSec=2
StandardOutput=append:${stdoutPath}
StandardError=append:${stderrPath}

[Install]
WantedBy=default.target
`;
}

function buildWindowsTaskAction({
  nodePath,
  cliPath,
  dataDir,
}) {
  return buildProgramArgs({ nodePath, cliPath, dataDir })
    .map((item) => windowsQuote(item))
    .join(" ");
}

function getLaunchdDomain(uid = process.getuid?.() ?? 0) {
  return `gui/${uid}`;
}

export function getPlatformServiceAdapter(platform = process.platform) {
  if (platform === "darwin") {
    return {
      platform,
      kind: "launchd",
      async install({
        serviceID,
        nodePath,
        cliPath,
        dataDir,
        stdoutPath,
        stderrPath,
        environmentPath = "",
        homeDir = os.homedir(),
      }) {
        const definitionPath = resolveMacOSLaunchAgentPath(serviceID, homeDir);
        await mkdir(path.dirname(definitionPath), { recursive: true, mode: 0o700 });
        await writeFile(definitionPath, buildMacOSLaunchAgentPlist({
          serviceID,
          nodePath,
          cliPath,
          dataDir,
          stdoutPath,
          stderrPath,
          environmentPath,
        }), {
          encoding: "utf8",
          mode: 0o600,
        });
        return { definitionPath };
      },
      async start({ serviceID, definitionPath, runCommand, uid = process.getuid?.() ?? 0 }) {
        const domain = getLaunchdDomain(uid);
        await runCommand("launchctl", [
          "bootstrap",
          domain,
          definitionPath,
        ], {
          allowFailure: true,
        });
        await runCommand("launchctl", [
          "kickstart",
          "-k",
          `${domain}/${serviceID}`,
        ], {
          allowFailure: true,
        });
      },
      async stop({ serviceID, runCommand, uid = process.getuid?.() ?? 0 }) {
        const domain = getLaunchdDomain(uid);
        await runCommand("launchctl", [
          "bootout",
          `${domain}/${serviceID}`,
        ], {
          allowFailure: true,
        });
      },
      async restart({ serviceID, definitionPath, runCommand, uid = process.getuid?.() ?? 0 }) {
        const domain = getLaunchdDomain(uid);
        await runCommand("launchctl", [
          "bootout",
          `${domain}/${serviceID}`,
        ], {
          allowFailure: true,
        });
        await runCommand("launchctl", [
          "bootstrap",
          domain,
          definitionPath,
        ], {
          allowFailure: true,
        });
        await runCommand("launchctl", [
          "kickstart",
          "-k",
          `${domain}/${serviceID}`,
        ], {
          allowFailure: true,
        });
      },
      async uninstall({ serviceID, definitionPath, runCommand, uid = process.getuid?.() ?? 0 }) {
        const domain = getLaunchdDomain(uid);
        await runCommand("launchctl", [
          "bootout",
          `${domain}/${serviceID}`,
        ], {
          allowFailure: true,
        });
        await rm(definitionPath, { force: true });
      },
    };
  }

  if (platform === "win32") {
    return {
      platform,
      kind: "task-scheduler",
      async install({
        serviceID,
        nodePath,
        cliPath,
        dataDir,
        runCommand,
      }) {
        await runCommand("schtasks", [
          "/Create",
          "/TN",
          serviceID,
          "/SC",
          "ONLOGON",
          "/RL",
          "LIMITED",
          "/F",
          "/TR",
          buildWindowsTaskAction({
            nodePath,
            cliPath,
            dataDir,
          }),
        ]);
        return {
          definitionPath: `task:${serviceID}`,
        };
      },
      async start({ serviceID, runCommand }) {
        await runCommand("schtasks", [
          "/Run",
          "/TN",
          serviceID,
        ]);
      },
      async stop({ serviceID, runCommand }) {
        await runCommand("schtasks", [
          "/End",
          "/TN",
          serviceID,
        ], {
          allowFailure: true,
        });
      },
      async restart({ serviceID, runCommand }) {
        await runCommand("schtasks", [
          "/End",
          "/TN",
          serviceID,
        ], {
          allowFailure: true,
        });
        await runCommand("schtasks", [
          "/Run",
          "/TN",
          serviceID,
        ]);
      },
      async uninstall({ serviceID, runCommand }) {
        await runCommand("schtasks", [
          "/Delete",
          "/TN",
          serviceID,
          "/F",
        ], {
          allowFailure: true,
        });
      },
    };
  }

  return {
    platform,
    kind: "systemd-user",
    async install({
      serviceID,
      nodePath,
      cliPath,
      dataDir,
      stdoutPath,
      stderrPath,
      homeDir = os.homedir(),
      runCommand,
    }) {
      const definitionPath = resolveLinuxUserUnitPath(serviceID, homeDir);
      await mkdir(path.dirname(definitionPath), { recursive: true, mode: 0o700 });
      await writeFile(definitionPath, buildLinuxUserUnit({
        serviceID,
        nodePath,
        cliPath,
        dataDir,
        stdoutPath,
        stderrPath,
      }), {
        encoding: "utf8",
        mode: 0o600,
      });
      await runCommand("systemctl", [
        "--user",
        "daemon-reload",
      ]);
      await runCommand("systemctl", [
        "--user",
        "enable",
        `${serviceID}.service`,
      ]);
      return { definitionPath };
    },
    async start({ serviceID, runCommand }) {
      await runCommand("systemctl", [
        "--user",
        "start",
        `${serviceID}.service`,
      ]);
    },
    async stop({ serviceID, runCommand }) {
      await runCommand("systemctl", [
        "--user",
        "stop",
        `${serviceID}.service`,
      ], {
        allowFailure: true,
      });
    },
    async restart({ serviceID, runCommand }) {
      await runCommand("systemctl", [
        "--user",
        "restart",
        `${serviceID}.service`,
      ]);
    },
    async uninstall({ serviceID, definitionPath, runCommand }) {
      await runCommand("systemctl", [
        "--user",
        "stop",
        `${serviceID}.service`,
      ], {
        allowFailure: true,
      });
      await runCommand("systemctl", [
        "--user",
        "disable",
        `${serviceID}.service`,
      ], {
        allowFailure: true,
      });
      await rm(definitionPath, { force: true });
      await runCommand("systemctl", [
        "--user",
        "daemon-reload",
      ]);
    },
  };
}
