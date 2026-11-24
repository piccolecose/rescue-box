const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

process.env.GIST_ID = "gist123";
process.env.GH_TOKEN = "gh-token";
process.env.RESCUETIME_API_KEY = "secret-rescuetime-key";

const { main, updateGist, generateBarChart } = require("../index.js");

const stats = {
  date: "2024-03-05",
  productivity_pulse: 72.4,
  total_duration_formatted: "6h 12m",
  all_productive_percentage: 60.2,
  all_productive_duration_formatted: "3h 44m",
  all_distracting_percentage: 15.5,
  all_distracting_duration_formatted: "58m",
  neutral_percentage: 24.3,
  neutral_duration_formatted: "1h 30m",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let requests;
let routes;
let errors;
const realFetch = globalThis.fetch;
const realConsoleError = console.error;

beforeEach(() => {
  requests = [];
  errors = [];
  routes = {
    rescuetime: () => json([stats]),
    gistGet: () => json({ files: { "old.md": { filename: "old.md" } } }),
    gistPatch: () => json({}),
  };
  console.error = (...args) => errors.push(args.join(" "));
  globalThis.fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.body ? await request.text() : undefined;
    requests.push({ method: request.method, url, body });
    if (url.hostname === "www.rescuetime.com") return routes.rescuetime();
    if (
      url.hostname === "api.github.com" &&
      url.pathname === "/gists/gist123"
    ) {
      return request.method === "PATCH" ? routes.gistPatch() : routes.gistGet();
    }
    throw new Error(`Unexpected request ${request.method} ${url}`);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

const patchRequest = () => requests.find((r) => r.method === "PATCH");

test("generateBarChart renders an empty bar at 0%", () => {
  assert.strictEqual(generateBarChart(0, 10), "░".repeat(10));
});

test("generateBarChart fills half the bar at 50%", () => {
  assert.strictEqual(generateBarChart(50, 10), "█".repeat(5) + "░".repeat(5));
});

test("generateBarChart starts with full blocks at 100%", () => {
  assert.ok(generateBarChart(100, 10).startsWith("█".repeat(10)));
});

test("generateBarChart keeps its length for fractional values", () => {
  for (const percent of [1, 12.5, 33.3, 66.6, 72.4, 99.9]) {
    assert.strictEqual(
      [...generateBarChart(percent, 10)].length,
      10,
      `${percent}%`,
    );
  }
});

test("generateBarChart uses a partial block for the remainder", () => {
  assert.strictEqual(generateBarChart(33.3, 10), "███▎░░░░░░");
});

test("main sends the RescueTime key as the key query param", async () => {
  await main();
  const request = requests.find((r) => r.url.hostname === "www.rescuetime.com");
  assert.strictEqual(request.url.pathname, "/anapi/daily_summary_feed");
  assert.strictEqual(
    request.url.searchParams.get("key"),
    "secret-rescuetime-key",
  );
});

test("main throws without leaking the API key when RescueTime fails", async () => {
  routes.rescuetime = () => json({}, 403);
  await assert.rejects(main(), (error) => {
    assert.match(error.message, /403/);
    assert.ok(!error.message.includes("secret-rescuetime-key"));
    return true;
  });
  assert.strictEqual(patchRequest(), undefined);
});

test("main patches the gist with the formatted stats", async () => {
  await main();
  const patch = patchRequest();
  const { files } = JSON.parse(patch.body);
  assert.deepStrictEqual(Object.keys(files), ["old.md"]);
  assert.strictEqual(
    files["old.md"].filename,
    "⏰ Daily Productivity Stats - 2024-03-05",
  );

  const lines = files["old.md"].content.split("\n");
  assert.strictEqual(lines.length, 5);
  assert.strictEqual(lines[0], "⏰ Stats for March 5th 2024");
  assert.match(lines[1], /^Productivity Pulse\s+6h 12m\s+\S{10}\s+72%$/);
  assert.match(lines[2], /^All Productive\s+3h 44m\s+\S{10}\s+60%$/);
  assert.match(lines[3], /^All Distracting\s+58m\s+\S{10}\s+16%$/);
  assert.match(lines[4], /^Neutral\s+1h 30m\s+\S{10}\s+24%$/);
});

test("updateGist logs and does not throw when the gist GET fails", async () => {
  routes.gistGet = () => json({ message: "Not Found" }, 404);
  await updateGist(stats);
  assert.ok(errors.some((e) => e.startsWith("Unable to get gist")));
  assert.strictEqual(patchRequest(), undefined);
});

test("updateGist logs and does not throw when the gist PATCH fails", async () => {
  routes.gistPatch = () => json({ message: "Server Error" }, 500);
  await updateGist(stats);
  assert.ok(errors.some((e) => e.startsWith("Unable to update gist")));
});
