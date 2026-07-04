// Minimal server for the calculator + a load-test "work" endpoint.
//
// Why this exists: the calculator itself is 100% static (all math runs in the
// browser), so plain GETs never stress server RAM. The /work endpoint below
// does real per-request work — it allocates memory, touches it (so the pages
// are actually resident, not lazily reserved), does a little CPU over it, holds
// it briefly, then responds. Under concurrency the live allocations overlap, so
// RAM climbs and you can find the real breaking point of each architecture.

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// High-water mark of RSS (resident RAM) since the process started. Sampled both
// on every /work request and on a timer, so /stats can report the peak the app
// reached under load — observable entirely from the URL, no instance access.
const startedAt = Date.now();
let peakRssBytes = process.memoryUsage().rss;
function sampleRss() {
  const rss = process.memoryUsage().rss;
  if (rss > peakRssBytes) peakRssBytes = rss;
  return rss;
}
setInterval(sampleRss, 500);

// Serve the existing static calculator unchanged (index.html, code.js, assets/…)
app.use(express.static(path.join(__dirname)));

// Cheap liveness endpoint (no work) — useful as a control in the load test.
app.get("/ping", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// RAM / lifetime stats — hit this from the browser or Postman before, during,
// and after a load run.
//   rssMB      -> current resident RAM of the app process
//   peakRssMB  -> highest RAM the app reached since it (re)started
//   uptimeSec  -> seconds since the process started. If this suddenly DROPS to
//                 near 0 between checks, the container was killed and restarted
//                 (almost always an OOM under load) — that's your breaking point,
//                 visible without ever touching the instance.
app.get("/stats", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    rssMB: Math.round(sampleRss() / (1024 * 1024)),
    peakRssMB: Math.round(peakRssBytes / (1024 * 1024)),
    heapUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    startedAt: new Date(startedAt).toISOString(),
  });
});

// The load-test work endpoint.
//   ?mb=<N>    -> allocate N MB per request   (default 10)
//   ?hold=<N>  -> keep it in memory for N ms   (default 200)
//   ?cpu=<N>   -> extra CPU passes over the buffer (default 1)
//
// Live memory under load ≈ concurrency × mb  (while requests overlap during hold).
// Turn mb/hold up to raise pressure; the app container's RAM will climb until it
// hits its ceiling and the request starts failing / the container OOM-restarts.
app.get("/work", (req, res) => {
  const mb = Math.max(1, Math.min(parseInt(req.query.mb, 10) || 10, 512));
  const holdMs = Math.max(0, Math.min(parseInt(req.query.hold, 10) || 200, 10000));
  const cpuPasses = Math.max(1, Math.min(parseInt(req.query.cpu, 10) || 1, 50));

  const bytes = mb * 1024 * 1024;
  // Buffer.alloc zero-fills, which forces the OS to actually back every page —
  // so this shows up as real resident memory, not just a virtual reservation.
  const buf = Buffer.alloc(bytes, 1);

  // A little CPU work over the buffer so the allocation isn't optimised away and
  // each request also costs some CPU (closer to a real workload).
  let checksum = 0;
  for (let pass = 0; pass < cpuPasses; pass++) {
    for (let i = 0; i < buf.length; i += 4096) {
      checksum = (checksum + buf[i]) % 2147483647;
    }
  }

  // Hold the memory in-flight for holdMs so concurrent requests stack up, then
  // respond. `buf` becomes eligible for GC once this handler returns.
  setTimeout(() => {
    res.json({
      ok: true,
      allocatedMB: mb,
      heldMs: holdMs,
      cpuPasses,
      checksum,
      rssMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    });
  }, holdMs);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`calculator + load-test server listening on ${PORT}`);
});
