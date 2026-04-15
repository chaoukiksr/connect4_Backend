const fs = require("fs");

function pickFromPathCommands() {
  if (process.platform !== "win32") return null;

  const { spawnSync } = require("child_process");
  const commands = ["chrome", "chrome.exe", "msedge", "msedge.exe"];

  for (const cmd of commands) {
    const out = spawnSync("where", [cmd], { encoding: "utf8" });
    if (out.status === 0 && out.stdout) {
      const candidate = out.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && fs.existsSync(line));
      if (candidate) return candidate;
    }
  }

  return null;
}

function pickExistingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveBrowserExecutable() {
  const fromEnv = pickExistingPath([
    process.env.CHROME_EXECUTABLE_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.GOOGLE_CHROME_BIN,
  ]);
  if (fromEnv) return fromEnv;

  const commonCandidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.LOCALAPPDATA || ""}\\Chromium\\Application\\chrome.exe`,
        `${process.env.LOCALAPPDATA || ""}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/snap/bin/chromium",
      ];

  const commonPath = pickExistingPath(commonCandidates);
  if (commonPath) return commonPath;

  const fromPath = pickFromPathCommands();
  if (fromPath) return fromPath;

  // Try Puppeteer's managed browser (if installed during build/runtime).
  try {
    const puppeteer = require("puppeteer");
    const managed = puppeteer.executablePath?.();
    if (managed && fs.existsSync(managed)) return managed;
  } catch (_) {
    // Ignore and return null below.
  }

  return null;
}

module.exports = {
  resolveBrowserExecutable,
};
