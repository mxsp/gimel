// Run after npm run build: node customers.test.mjs <build-directory>
// Playwright intercepts all requests; no application server or backend is started.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

assert.ok(process.argv[2], "Pass the internal Vite build directory");
const buildDir = resolve(process.argv[2]);
const browser = await chromium.launch({ headless: true });
const customer = { id: 1, email: "kunde@example.test", name: "Anna Test", company: "Test GmbH", active: true,
  price_group: "standard", discount_pct: 0, payment_terms: "30 Tage netto", customer_no: "K-1", credit_limit: 0,
  vat_id: "", created_at: "2026-01-01T00:00:00", n_orders: 30, total_net: 0, open_net: 0 };
const orders = Array.from({ length: 30 }, (_, i) => ({ no: `A-${1000 + i}`, created_at: "2026-02-01T00:00:00", gross: 119, paid: i % 2 === 0 }));
const addresses = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, label: `Werk ${i + 1}`, company: "", dept: "", contact: "",
  street: `Musterstraße ${i + 1}`, zip: "06366", city: "Köthen", country: "DE", vat_id: "", is_billing: i === 0, is_delivery: i === 1 }));

async function openPage(width) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("gimel-token", "test-token");
    localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role: "admin" }));
  });
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/")) {
      let json = [];
      if (path === "/api/invoicing/config") json = { configured: true };
      else if (path === "/api/customers") json = [customer];
      else if (path === `/api/customers/${customer.id}/orders`) json = orders;
      else if (path === `/api/customers/${customer.id}/addresses`) json = addresses;
      return route.fulfill({ json });
    }
    assert.ok(path.startsWith("/app/"), `Unexpected asset: ${path}`);
    const file = path === "/app/" ? "index.html" : path.slice(5);
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2" };
    await route.fulfill({ body: await readFile(resolve(buildDir, file)), contentType: mime[extname(file)] || "application/octet-stream" });
  });
  await page.goto("http://internal.test/app/#/kunden");
  return { page, errors };
}

const drawer = (page) => page.locator(".bp5-drawer.customer-drawer");
const body = (page) => page.locator(".customer-drawer-body");
const orderButton = (page, no) => page.getByRole("button", { name: `Auftrag ${no} öffnen`, exact: true });
const openDrawer = async (page) => {
  await page.getByRole("cell", { name: "Test GmbH" }).click();
  await orderButton(page, "A-1000").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector(".customer-drawer-body")?.scrollHeight > 0);
};

try {
  // Desktop: the drawer body scrolls on its own; the page behind does not move.
  {
    const { page, errors } = await openPage(1280);
    await openDrawer(page);
    const scrollInfo = () => body(page).evaluate((el) => ({ top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight }));
    const pageScroll = () => page.evaluate(() => ({
      doc: document.scrollingElement.scrollTop,
      main: document.querySelector(".app-main")?.scrollTop ?? 0,
    }));
    const before = await scrollInfo();
    assert.ok(before.sh > before.ch, `drawer body must overflow (scrollHeight ${before.sh} > clientHeight ${before.ch})`);
    const pageBefore = await pageScroll();
    const box = await body(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 600);
    await page.waitForFunction(() => document.querySelector(".customer-drawer-body").scrollTop > 0);
    assert.ok((await scrollInfo()).top > 0, "drawer body scrolls");
    assert.deepEqual(await pageScroll(), pageBefore, "page behind the drawer does not scroll");
    // The drawer header stays in place while the body moves.
    const headerTop = await drawer(page).locator(".bp5-drawer-header").evaluate((el) => el.getBoundingClientRect().top);
    assert.equal(headerTop, (await drawer(page).boundingBox()).y, "header stays at the top of the drawer");

    // Clicking an order number closes the drawer and opens the order.
    await orderButton(page, "A-1025").click();
    await page.waitForFunction(() => location.hash === "#/auftraege/A-1025");
    assert.equal(await drawer(page).count(), 0, "drawer closes before navigating");

    // Enter on a focused order number also navigates.
    await page.goto("http://internal.test/app/#/kunden");
    await openDrawer(page);
    await page.keyboard.press("Tab"); // keyboard input, so the next focus shows the focus ring
    await orderButton(page, "A-1003").focus();
    assert.equal(await orderButton(page, "A-1003").evaluate((el) => el.matches(":focus-visible")), true, "focus is visible");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.hash === "#/auftraege/A-1003");
    assert.deepEqual(errors, [], "no page errors on desktop");
    await page.close();
  }

  // Phone: the drawer fills the width and the page has no horizontal scroll.
  {
    const { page, errors } = await openPage(375);
    await openDrawer(page);
    const widths = await page.evaluate(() => ({
      drawer: document.querySelector(".bp5-drawer.customer-drawer").getBoundingClientRect().width,
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
    }));
    assert.equal(Math.round(widths.drawer), 375, "drawer is full width on a phone");
    assert.equal(widths.docW, widths.winW, "no horizontal page scroll at 375 px");
    assert.deepEqual(errors, [], "no page errors on phone");
    await page.close();
  }
} finally {
  await browser.close();
}
console.log("customers.test.mjs: ok");
