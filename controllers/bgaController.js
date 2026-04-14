const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeTable(tableId) {
  // Prepare user data directory if it exists, otherwise use default
  let userDataDir = undefined;
  const SCRAPPER_PROFILE = path.join(__dirname, '../../scrapper/automation-profile');
  if (fs.existsSync(SCRAPPER_PROFILE)) {
    userDataDir = SCRAPPER_PROFILE;
  }

  const launchOptions = {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',  // Required for most deployment environments
      '--disable-setuid-sandbox',
    ],
  };

  // Add userDataDir if available
  if (userDataDir) {
    launchOptions.userDataDir = userDataDir;
  }


  // Optional: use system Chrome if environment variable is set
  // Otherwise puppeteer uses its bundled Chromium automatically
  if (process.env.CHROME_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.CHROME_EXECUTABLE_PATH;
  }

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1366, height: 768 });
  
  // Set longer default timeout for deployed environments
  page.setDefaultTimeout(60000);

  try {
    const url = `https://boardgamearena.com/table?table=${tableId}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Board size
    let boardSize = '7 columns, 6 rows';
    try {
      boardSize = await page.$eval('#mob_gameoption_100_displayed_value', el => el.textContent.trim());
    } catch (_) {}

    // Click "Review game"
    await page.waitForSelector('#reviewgame', { visible: true, timeout: 15000 });
    await page.click('#reviewgame');
    await delay(3000);

    // Choose first available player
    const chooseLinks = await page.$$('.choosePlayerLink');
    let clicked = false;
    for (const link of chooseLinks) {
      const text = await page.evaluate(el => el.textContent, link);
      if (text.includes('Choose this player')) {
        await link.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) throw new Error('Player selection link not found — are you logged in to BGA?');

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);

    // Wait for replay log data
    await page.waitForFunction(
      () => typeof g_gamelogs !== 'undefined' && g_gamelogs.length > 0,
      { timeout: 30000 }
    );

    // Extract moves from g_gamelogs
    const gameData = await page.evaluate(() => {
      const moveMap = new Map();
      let startingPlayer = null;
      let winningPlayer = null;
      let status = 'ongoing';
      let winningLine = [];

      for (const packet of g_gamelogs) {
        if (!packet.data) continue;
        for (const evt of packet.data) {
          if (evt.type === 'playDisc') {
            moveMap.set(packet.move_id, evt.args.x);
            if (packet.move_id === '2') startingPlayer = evt.args.player_id;
          }
          if (evt.type === 'won' && evt.args) {
            status = 'finished';
            winningPlayer = evt.args.player_id;
            winningLine = [];
            for (let i = 1; i <= 4; i++) {
              const key = `win${i}`;
              if (evt.args[key] != null) winningLine.push(evt.args[key]);
            }
          }
        }
      }

      return {
        signature: [...moveMap.entries()]
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([, col]) => col)
          .join(''),
        status,
        starting_player: startingPlayer,
        winning_player: winningPlayer,
        winning_line: winningLine,
      };
    });

    gameData.board_size = boardSize;
    return gameData;
  } finally {
    await browser.close();
  }
}

module.exports = {
  scrape: async (req, res) => {
    const { tableId } = req.params;
    if (!tableId || !/^\d+$/.test(tableId)) {
      return res.status(400).json({ error: 'Table ID invalide — doit être un nombre.' });
    }
    try {
      const result = await scrapeTable(tableId);
      res.json(result);
    } catch (err) {
      console.error('[BGA scrape error]', err.message);
      
      // Provide helpful error messages for common deployment issues
      if (err.message.includes('Failed to launch') || err.message.includes('executablePath')) {
        return res.status(500).json({
          error: 'Browser not available on this server. Set CHROME_EXECUTABLE_PATH environment variable.',
          details: err.message,
        });
      }
      
      res.status(500).json({ error: err.message });
    }
  },
};
