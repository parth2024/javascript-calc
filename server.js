const crypto = require("crypto");
const https = require("https");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const START_TIME = Date.now();

// ---------------------------------------------------------------------------
// BOOT-TIME MEMORY (simulates a real app's cold-start footprint: loading a
// product catalog into memory and building an in-memory index over it, like
// a real e-commerce/marketplace backend does at boot — e.g. Sharetribe's own
// server loads its 404/500 HTML templates via fs.readFileSync at startup
// (server/index.js), and most catalog-backed apps load/cache their product
// list once at boot instead of hitting the DB on every request. This is NOT
// a leak — it's allocated once at boot and kept for the life of the process.
// ---------------------------------------------------------------------------
const BOOT_DATASET_MB = parseInt(process.env.BOOT_DATASET_MB || "48", 10);

const CATEGORIES = ["Electronics", "Home & Kitchen", "Books", "Clothing", "Sports", "Toys", "Beauty", "Automotive"];
const ADJECTIVES = ["Premium", "Compact", "Wireless", "Portable", "Deluxe", "Classic", "Eco", "Pro", "Smart", "Rugged"];
const NOUNS = ["Blender", "Backpack", "Headphones", "Lamp", "Chair", "Bottle", "Charger", "Speaker", "Notebook", "Jacket"];

// Builds a realistic product-catalog record — same shape you'd get back from
// a real "SELECT * FROM products" query — instead of opaque random bytes.
function buildProductRecord(id) {
  const category = CATEGORIES[id % CATEGORIES.length];
  const name = `${ADJECTIVES[id % ADJECTIVES.length]} ${NOUNS[(id * 7) % NOUNS.length]}`;
  return {
    id,
    sku: `SKU-${id.toString(36).toUpperCase()}`,
    name,
    category,
    price: Math.round((5 + (id % 500) + Math.random() * 20) * 100) / 100,
    currency: "USD",
    inStock: id % 11 !== 0,
    stockCount: id % 11 !== 0 ? (id * 3) % 250 : 0,
    rating: Math.round((3 + (id % 20) / 10) * 10) / 10,
    reviewCount: id % 3000,
    description:
      `${name} in the ${category} range. Durable build, ships within 2-3 business days. ` +
      `Includes standard 1-year warranty and free returns within 30 days of delivery. ` +
      `Customer favorite with consistent reorder rate across regions.`,
    tags: [category.toLowerCase(), ADJECTIVES[id % ADJECTIVES.length].toLowerCase(), "bestseller"].slice(0, 1 + (id % 3)),
  };
}

function buildBootDataset(totalMb) {
  // Each product record serializes to roughly ~450-500 bytes of JSON —
  // measure the real size instead of assuming, so BOOT_DATASET_MB is honest.
  const sampleSize = Buffer.byteLength(JSON.stringify(buildProductRecord(0)));
  const recordCount = Math.floor((totalMb * 1024 * 1024) / sampleSize);
  const dataset = new Array(recordCount);
  for (let i = 0; i < recordCount; i++) {
    dataset[i] = buildProductRecord(i);
  }
  return dataset;
}

console.log(`Booting: loading ~${BOOT_DATASET_MB}MB product catalog into memory...`);
const bootDataset = buildBootDataset(BOOT_DATASET_MB);
console.log(`Boot dataset ready: ${bootDataset.length} products loaded.`);

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
    catalogProductCount: bootDataset.length,
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

// Real query processing over the in-memory catalog: filter by category,
// sort by rating, then hash+sign each result — the same shape of work a
// real "GET /products?category=X&sort=rating" endpoint does over rows it
// already has cached, instead of allocating an opaque random buffer.
function searchAndProcessCatalog(category, resultLimit, cpuPasses) {
  const matches = bootDataset.filter(p => p.category === category);
  const sorted = matches.sort((a, b) => b.rating - a.rating).slice(0, resultLimit);

  // Build the actual response payload a client would receive — this is the
  // per-request memory: a real, JSON-shaped result set, not random bytes.
  const responsePayload = sorted.map(p => ({
    ...p,
    // Simulate a per-request price computation (e.g. tax/discount applied
    // at request time rather than pre-computed), real CPU work per item.
    finalPrice: Math.round(p.price * (1 - (p.rating > 4 ? 0.1 : 0)) * 100) / 100,
  }));

  // CPU-bound step: sign/hash the payload `cpuPasses` times, like a real
  // request doing repeated validation/transform passes (e.g. computing an
  // ETag, re-serializing for a cache layer, checksumming for integrity).
  let digest = Buffer.from(JSON.stringify(responsePayload));
  for (let i = 0; i < cpuPasses; i++) {
    digest = crypto.createHash("sha256").update(digest).digest();
  }

  return { responsePayload, digestHex: digest.toString("hex") };
}

// ---------------------------------------------------------------------------
// /work — simulates one realistic "GET /products?category=X" request:
//   1. outbound network call (like hitting a 3rd-party API, e.g. a pricing
//      or fraud-check service most real product endpoints also call)
//   2. filters + sorts the in-memory catalog and builds a real response
//      payload (per-request memory — sized by how many results match, not
//      an arbitrary random buffer)
//   3. CPU-bound hashing/re-serialization of that payload (like computing
//      an ETag or checksumming the response)
//   4. holds the response briefly (like real downstream I/O latency), then
//      returns — the payload falls out of scope after response (GC-eligible,
//      this is NOT a leak). Point load at this with rising concurrency to
//      see whether the 512MB box swap-thrashes under realistic traffic.
// ---------------------------------------------------------------------------
app.get("/work", async (req, res) => {
  const category = CATEGORIES.includes(req.query.category) ? req.query.category : CATEGORIES[0];
  const resultLimit = Math.max(1, parseInt(req.query.limit || "200", 10));
  const holdMs = Math.max(0, parseInt(req.query.hold || "200", 10));
  const cpuPasses = Math.max(1, parseInt(req.query.cpu || "5", 10));

  const networkResult = await makeNetworkCall();
  const { responsePayload, digestHex } = searchAndProcessCatalog(category, resultLimit, cpuPasses);

  await new Promise(resolve => setTimeout(resolve, holdMs));

  const rssMB = trackPeakRss();
  res.json({
    ok: true,
    category,
    resultCount: responsePayload.length,
    cpuPasses,
    heldMs: holdMs,
    networkBytes: networkResult.length,
    digestPreview: digestHex.slice(0, 16),
    rssMB,
    peakRssMB,
    sampleProduct: responsePayload[0] || null,
  });
  // `responsePayload` falls out of scope here — normal per-request memory,
  // expected to be reclaimed by GC, unlike /eat's permanent store.
});

app.listen(PORT, "0.0.0.0", () => {
  const bootRssMB = trackPeakRss();
  console.log(`listening on ${PORT} — boot RSS ~${bootRssMB}MB (baseline dataset ${BOOT_DATASET_MB}MB)`);
});
