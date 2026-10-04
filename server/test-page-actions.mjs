import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { resolveDestination } from '../extension/destination.mjs';

const pageActionsSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'page-actions.js'),
  'utf8'
);

const fixture = `<!doctype html>
<html>
  <body>
    <form id="signup" onsubmit="event.preventDefault(); window.__submitted = true;">
      <label>Email <input name="email" /></label>
      <label>Password <input type="password" name="password" /></label>
      <label>Message <textarea name="message"></textarea></label>
      <label>Country
        <select name="country">
          <option value="">Choose</option>
          <option value="ca">Canada</option>
          <option value="in">India</option>
        </select>
      </label>
      <label><input type="checkbox" name="agree" /> Agree</label>
      <input type="search" placeholder="Search mail" />
      <div id="notes" contenteditable="true" aria-label="Notes" style="border:1px solid #ccc; min-height:30px;"></div>
      <button type="submit">Create account</button>
      <button type="button">Save</button>
      <button type="button">Save</button>
      <a href="#docs">Docs</a>
      <div role="button" id="signin" onclick="window.__clicked='signin'">Sign in</div>
      <button type="button" hidden>Secret Hidden</button>
    </form>
    <div style="height:2400px"></div>
  </body>
</html>`;

function assertDestination(input, expected) {
  assert.equal(resolveDestination(input), expected);
}

async function pageCall(page, operation, payload) {
  const session = await page.context().newCDPSession(page);
  await session.send('Runtime.evaluate', { expression: pageActionsSource });
  const response = await session.send('Runtime.evaluate', {
    expression: `globalThis.gptLiveActions[${JSON.stringify(operation)}](${JSON.stringify(payload ?? {})})`,
    returnByValue: true,
    awaitPromise: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result.value;
}

async function main() {
  assertDestination('gmail', 'https://mail.google.com/');
  assertDestination('github.com/openai', 'https://github.com/openai');
  assertDestination('https://example.com/docs', 'https://example.com/docs');
  assertDestination('playwright browser automation', 'https://www.google.com/search?q=playwright%20browser%20automation');
  assert.throws(() => resolveDestination('javascript:alert(1)'), /HTTP and HTTPS/);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.setContent(fixture);

  const described = await pageCall(page, 'describe', { limit: 40 });
  const names = described.elements.map(element => element.name);
  assert.ok(names.includes('Email'), `describe missed Email: ${names.join(', ')}`);
  assert.ok(names.includes('Country'), `describe missed Country: ${names.join(', ')}`);
  assert.ok(names.includes('Agree'), `describe missed Agree: ${names.join(', ')}`);
  assert.ok(names.includes('Sign in'), `describe missed Sign in: ${names.join(', ')}`);
  assert.equal(names.includes('Secret Hidden'), false);

  const email = await pageCall(page, 'setValue', { target: 'Email', value: 'yash@example.com' });
  assert.equal(email.ok, true);
  assert.equal(await page.locator('input[name="email"]').inputValue(), 'yash@example.com');

  const password = await pageCall(page, 'setValue', { target: 'Password', value: 'secret-pass' });
  assert.equal(password.entered, '[hidden]');
  assert.equal(await page.locator('input[name="password"]').inputValue(), 'secret-pass');

  const country = await pageCall(page, 'setValue', { target: 'Country', value: 'Canada' });
  assert.equal(country.ok, true, country.error);
  assert.equal(await page.locator('select[name="country"]').inputValue(), 'ca');

  const agree = await pageCall(page, 'setValue', { target: 'Agree', checked: true });
  assert.equal(agree.checked, true);
  assert.equal(await page.locator('input[name="agree"]').isChecked(), true);

  const notes = await pageCall(page, 'setValue', { target: 'Notes', value: 'Ship Friday' });
  assert.equal(notes.ok, true, notes.error);
  assert.match(await page.locator('#notes').innerText(), /Ship Friday/);

  const message = await pageCall(page, 'setValue', { target: 'Message', value: 'Hello from voice' });
  assert.equal(await page.locator('textarea[name="message"]').inputValue(), 'Hello from voice');

  const search = await pageCall(page, 'resolve', { label: 'search', preferEditable: true, prefer: 'search' });
  assert.equal(search.ok, true, search.error);
  assert.match(search.name, /Search mail/);

  const signIn = await pageCall(page, 'resolve', { label: 'Sign in' });
  assert.equal(signIn.role, 'button');
  const byRef = await pageCall(page, 'resolve', { label: `0:${signIn.ref}` });
  assert.equal(byRef.ref, signIn.ref);

  await page.mouse.click(signIn.rect.x + signIn.rect.width / 2, signIn.rect.y + signIn.rect.height / 2);
  assert.equal(await page.evaluate(() => window.__clicked), 'signin');

  const ambiguous = await pageCall(page, 'resolve', { label: 'Save' });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.ambiguous, true);

  const missing = await pageCall(page, 'resolve', { label: 'Definitely missing control' });
  assert.equal(missing.ok, false);

  const docs = await pageCall(page, 'resolve', { label: 'Docs' });
  assert.equal(docs.role, 'link');

  const submit = await pageCall(page, 'submitTarget', {});
  assert.equal(submit.name, 'Create account');
  await page.mouse.click(submit.rect.x + submit.rect.width / 2, submit.rect.y + submit.rect.height / 2);
  assert.equal(await page.evaluate(() => window.__submitted), true);

  const scrolled = await pageCall(page, 'scrollPage', { direction: 'bottom' });
  assert.equal(scrolled.ok, true);
  assert.ok(await page.evaluate(() => window.scrollY) > 500);

  await page.setContent(`<!doctype html>
    <div id="rso">
      <a href="https://www.google.com/url?q=https%3A%2F%2Fwww.cibil.com%2F"><h3>Check CIBIL Score</h3></a>
      <a href="https://www.cibil.com/free"><h3>Free CIBIL</h3></a>
      <a href="https://example.com/report"><h3>Other Report</h3></a>
    </div>`);
  const firstLink = await pageCall(page, 'resolve', { label: 'first link' });
  assert.equal(firstLink.ok, true, firstLink.error);
  assert.equal(firstLink.href, 'https://www.cibil.com/');
  const byDomain = await pageCall(page, 'resolve', { label: 'cibil.com' });
  assert.equal(byDomain.href, 'https://www.cibil.com/');
  const secondLink = await pageCall(page, 'resolve', { label: 'second result' });
  assert.equal(secondLink.href, 'https://www.cibil.com/free');
  const thirdLink = await pageCall(page, 'resolve', { label: 'third link' });
  assert.equal(thirdLink.href, 'https://example.com/report');

  await browser.close();
  console.log('page action checks passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
