const crypto = require("crypto");
const https = require("https");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const START_TIME = Date.now();

// ---------------------------------------------------------------------------
// BOOT-TIME MEMORY (simulates a real app's cold-start footprint: loading a
// dataset into memory and building an in-memory index/cache, like a real
// Node service would with a product catalog, translations, template cache,
// etc.) This is NOT a leak — it's allocated once at boot and kept for the
// life of the process, same as any real app's warm caches.
// ---------------------------------------------------------------------------
const BOOT_DATASET_MB = parseInt(process.env.BOOT_DATASET_MB || "40", 10);

function buildBootDataset(totalMb) {
  const recordSize = 1024; // ~1KB per "record"
  const recordCount = Math.floor((totalMb * 1024 * 1024) / recordSize);
  const dataset = new Array(recordCount);
  for (let i = 0; i < recordCount; i++) {
    dataset[i] = {
      id: i,
      payload: crypto.randomBytes(recordSize - 64).toString("hex"),
    };
  }
  return dataset;
}

console.log(`Booting: loading ~${BOOT_DATASET_MB}MB baseline dataset into memory...`);
const bootDataset = buildBootDataset(BOOT_DATASET_MB);
// Simple in-memory index over the dataset, like a real app would build once at boot.
const bootIndex = new Map(bootDataset.map(r => [r.id, r.payload.slice(0, 16)]));
console.log(`Boot dataset ready: ${bootDataset.length} records indexed.`);

let peakRssMB = 0;
function trackPeakRss() {
  const rssMB = Math.round(process.memoryUsage().rss / (1024 * 1024));
  if (rssMB > peakRssMB) peakRssMB = rssMB;
  return rssMB;
}
setInterval(trackPeakRss, 1000).unref();

app.use(express.static(__dirname));

// ---------------------------------------------------------------------------
// /ping — plain liveness control. If /work fails but /ping stays fine, the
// failure is load-driven, not "server is down".
// ---------------------------------------------------------------------------
app.get("/ping", (req, res) => {
  res.json({ ok: true, uptimeSec: Math.round((Date.now() - START_TIME) / 1000) });
});

// ---------------------------------------------------------------------------
// /stats — current + peak RSS, uptime. Use this to watch memory over days.
// ---------------------------------------------------------------------------
app.get("/stats", (req, res) => {
  const rssMB = trackPeakRss();
  const mem = process.memoryUsage();
  res.json({
    rssMB,
    peakRssMB,
    heapUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
    externalMB: Math.round(mem.external / (1024 * 1024)),
    uptimeSec: Math.round((Date.now() - START_TIME) / 1000),
    bootDatasetRecords: bootDataset.length,
  });
});

// Outbound network call, same as a real app calling a 3rd-party API/webhook
// during request handling. Uses a small public endpoint so this works from
// any box without extra config. Falls back gracefully if offline.
function makeNetworkCall() {
  return new Promise(resolve => {
    const req = https.get("https://httpbin.org/bytes/2048", res => {
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", () => resolve(Buffer.alloc(0)));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(Buffer.alloc(0));
    });
  });
}

// CPU-bound work: hashing + JSON (de)serialization, similar to real request
// processing (e.g. rendering a response, validating a payload, hashing a
// password, transforming data).
function cpuBoundWork(buffer, passes) {
  let digest = buffer;
  for (let i = 0; i < passes; i++) {
    const hash = crypto.createHash("sha256").update(digest).digest();
    const asJson = JSON.stringify({ i, hash: hash.toString("hex"), sample: bootDataset[i % bootDataset.length] });
    digest = Buffer.from(JSON.parse(asJson).hash, "hex");
  }
  return digest;
}

// ---------------------------------------------------------------------------
// /work — simulates one realistic user request end-to-end:
//   1. outbound network call (like hitting a 3rd-party API)
//   2. per-request memory allocation (like building a response payload)
//   3. CPU-bound processing (like hashing/rendering/validation)
//   4. holds the response briefly (like real I/O latency) then returns,
//      and the per-request memory is released after response (GC-eligible) —
//      this is NOT a leak, it's what a normal request under concurrency looks
//      like. Point load at this with rising concurrency to see whether the
//      512MB box swap-thrashes under realistic traffic, not an artificial one.
// ---------------------------------------------------------------------------
app.get("/work", async (req, res) => {
  const mb = Math.max(1, parseInt(req.query.mb || "10", 10));
  const holdMs = Math.max(0, parseInt(req.query.hold || "200", 10));
  const cpuPasses = Math.max(1, parseInt(req.query.cpu || "5", 10));

  const networkResult = await makeNetworkCall();

  // Allocate this request's "working set" — unique bytes so nothing gets
  // silently merged by the host, same reasoning as the old /eat endpoint.
  const buffer = crypto.randomBytes(mb * 1024 * 1024);

  // Look up something from the boot-time index too, like a real request
  // that consults an in-memory cache before doing the heavier work.
  const cacheHit = bootIndex.get(Math.floor(Math.random() * bootDataset.length));
  const processed = cpuBoundWork(
    Buffer.concat([buffer.subarray(0, 4096), networkResult, Buffer.from(cacheHit || "", "hex")]),
    cpuPasses
  );

  await new Promise(resolve => setTimeout(resolve, holdMs));

  const rssMB = trackPeakRss();
  res.json({
    ok: true,
    allocatedMB: mb,
    cpuPasses,
    heldMs: holdMs,
    networkBytes: networkResult.length,
    processedHashPreview: processed.toString("hex").slice(0, 16),
    rssMB,
    peakRssMB,
  });
  // `buffer` and `processed` fall out of scope here — normal per-request
  // memory, expected to be reclaimed by GC, unlike /eat's permanent store.
});

app.listen(PORT, "0.0.0.0", () => {
  const bootRssMB = trackPeakRss();
  console.log(`listening on ${PORT} — boot RSS ~${bootRssMB}MB (baseline dataset ${BOOT_DATASET_MB}MB)`);
});
