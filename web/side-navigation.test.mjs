// Run after npm run build: node side-navigation.test.mjs
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const executablePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find(existsSync);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 360 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("gimel-token", "test-token");
    localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role: "admin" }));
  });
  await page.route("**/*", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/")) return route.fulfill({ json: path === "/api/invoicing/config" ? { configured: true }
      : path === "/api/products/matrix/view" ? { rows: [], standard_sheets: [] } : [] });
    const file = path === "/app/" ? "index.html" : path.slice(5);
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" };
    await route.fulfill({ body: await readFile(resolve("../gimel/webapp/dist", file)), contentType: mime[extname(file)] || "application/octet-stream" });
  });
  await page.goto("http://internal.test/app/#/werkstoffe");
  const sidebar = page.locator(".app-sidebar");
  const current = page.locator('.sidebar-link[aria-current="page"]');
  await current.waitFor();
  const visible = () => current.evaluate(el => {
    const a = el.getBoundingClientRect(), b = el.closest("aside").getBoundingClientRect();
    return a.top >= b.top - 1 && a.bottom <= b.bottom + 1 && a.left >= b.left - 1 && a.right <= b.right + 1;
  });
  assert.equal(await visible(), true, "Deep link reveals active item");
  const before = await sidebar.evaluate(el => el.scrollTop);
  assert.ok(before > 0);
  await current.click();
  assert.equal(await sidebar.evaluate(el => el.scrollTop), before, "Clicking current item retains position");
  await page.evaluate(() => { location.hash = "/werkstoffe/detail"; });
  await page.waitForURL("**/#/werkstoffe/detail");
  assert.equal(await sidebar.evaluate(el => el.scrollTop), before, "Child page retains sidebar position");
  assert.equal(await current.innerText(), "Werkstoffe");
  await page.getByRole("link", { name: "Formen", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForURL("**/#/formen");
  // The hash changes before React re-renders the navigation.
  await page.waitForFunction(() => document.querySelector('[aria-current="page"]')?.textContent === "Formen");
  assert.equal(await current.innerText(), "Formen");
  assert.equal(await current.evaluate(el => el === document.activeElement), true, "Keyboard focus stays on chosen link");
  await page.goBack();
  await page.waitForURL("**/#/werkstoffe/detail");
  await page.waitForFunction(() => document.querySelector('[aria-current="page"]')?.textContent === "Werkstoffe");
  assert.equal(await visible(), true);
  await page.setViewportSize({ width: 600, height: 700 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".app-body")).flexDirection === "column");
  // The sidebar scrolls after the layout flips, so give it a moment; a real failure still times out.
  await page.waitForFunction(() => {
    const a = document.querySelector('.sidebar-link[aria-current="page"]').getBoundingClientRect();
    const b = document.querySelector('.sidebar-link[aria-current="page"]').closest("aside").getBoundingClientRect();
    return a.top >= b.top - 1 && a.bottom <= b.bottom + 1 && a.left >= b.left - 1 && a.right <= b.right + 1;
  }, null, { timeout: 2000 });
  await page.getByRole("link", { name: "Auftragserfassung", exact: true }).click();
  await page.waitForURL("**/#/auftragserfassung");
  const top = (await sidebar.boundingBox()).y;
  await page.getByRole("link", { name: "Kunden", exact: true }).click();
  await page.waitForURL("**/#/kunden");
  assert.equal((await sidebar.boundingBox()).y, top, "Mobile navigation stays anchored between pages");
  await page.locator(".sidebar-skip").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement.id), "page-content");
  assert.deepEqual(errors, []);
  console.log("Sidebar checks passed: scroll retention, child routes, keyboard focus, history, resize, mobile anchor, skip link.");
} finally {
  await browser.close();
}
