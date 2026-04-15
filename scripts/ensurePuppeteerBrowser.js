#!/usr/bin/env node
const { spawnSync } = require("child_process");

function hasManagedBrowser() {
  try {
    const puppeteer = require("puppeteer");
    const executable = puppeteer.executablePath?.();
    return Boolean(executable);
  } catch (_) {
    return false;
  }
}

if (hasManagedBrowser()) {
  console.log("[puppeteer] managed browser already available");
  process.exit(0);
}

console.log("[puppeteer] installing managed Chrome (first run / deployment)");
const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["puppeteer", "browsers", "install", "chrome"],
  { stdio: "inherit" }
);

if (result.status !== 0) {
  console.error("[puppeteer] browser install failed. Set CHROME_EXECUTABLE_PATH if using system Chrome.");
  process.exit(result.status || 1);
}

console.log("[puppeteer] managed Chrome installed successfully");
