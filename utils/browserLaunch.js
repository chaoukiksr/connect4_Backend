const fs = require("fs");

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
