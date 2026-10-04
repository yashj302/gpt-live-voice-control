import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder, By, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';

const serverUrl = process.env.EXTENSION_SERVER_URL || 'http://localhost:3000';
const extensionPath = fileURLToPath(new URL('../extension', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
const extensionId = createHash('sha256')
  .update(Buffer.from(manifest.key, 'base64'))
  .digest()
  .subarray(0, 16)
  .toString('hex')
  .replace(/../g, byte => String.fromCharCode(97 + parseInt(byte[0], 16)) + String.fromCharCode(97 + parseInt(byte[1], 16)));
const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-live-extension-'));
await fs.mkdir(path.join(profilePath, 'Default'), { recursive: true });
await fs.writeFile(
  path.join(profilePath, 'Local State'),
  JSON.stringify({ extensions: { ui: { developer_mode: true } } })
);
await fs.writeFile(
  path.join(profilePath, 'Default', 'Preferences'),
  JSON.stringify({ extensions: { ui: { developer_mode: true } } })
);
let driver;

try {
  const healthResponse = await fetch(`${serverUrl}/health`);
  assert.equal(healthResponse.status, 200, 'Token server health check failed');
  assert.deepEqual(await healthResponse.json(), { ok: true });

  const options = new chrome.Options();
  options.addArguments(
    `--load-extension=${extensionPath}`,
    `--disable-extensions-except=${extensionPath}`,
    `--user-data-dir=${profilePath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--autoplay-policy=no-user-gesture-required'
  );
  options.setChromeBinaryPath(
    process.env.CHROME_BINARY || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  );

  driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  const deadline = Date.now() + 5000;
  let extensionTarget;
  while (!extensionTarget && Date.now() < deadline) {
    const targets = await driver.sendAndGetDevToolsCommand('Target.getTargets', {});
    extensionTarget = targets.targetInfos.find(target =>
      target.type === 'service_worker' && target.url.startsWith('chrome-extension://')
    );
    if (!extensionTarget) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(extensionTarget, 'Chrome did not load the extension service worker');
  const loadedExtensionId = new URL(extensionTarget.url).hostname;
  await driver.get(`chrome-extension://${loadedExtensionId}/popup.html`);

  const button = await driver.wait(until.elementLocated(By.id('startBtn')), 5000);
  const status = await driver.findElement(By.id('status'));
  assert.equal(await button.getText(), 'Connect Voice');
  assert.equal(await status.getText(), 'Disconnected');

  console.log(`Selenium smoke test passed (extension id: ${extensionId})`);
  if (process.env.RUN_LIVE_VOICE === '1') {
    await button.click();
    await driver.wait(async () => (await status.getText()).includes('listening'), 30000);
    console.log('Live voice connection passed');
  }
} finally {
  await driver?.quit();
  await fs.rm(profilePath, { recursive: true, force: true });
}
