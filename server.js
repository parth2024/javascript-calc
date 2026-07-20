const crypto = require("crypto");
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// still serve the calculator at /
app.use(express.static(__dirname));

// ONE endpoint: hit it once, it keeps eating RAM in a loop and prints the count.
// The count keeps climbing until the container runs out of RAM and dies, OR
// until MAX_CHUNKS is hit (hard safety stop — see below).
// The last count printed in `docker logs` = how far this architecture got.
//
// Each chunk MUST be random, not the same repeated byte — identical pages can
// get silently merged by the host (same-page merging), which would make RAM
// look like it's not growing even though it really is. Random bytes guarantee
// every chunk is unique, so nothing can be merged and the numbers are honest.
//
// Safety stop: this is meant to test the health-agent's host-memory guard
// (restarts the container once host-available memory drops critical), not
// to actually take an EC2 host down if the guard is broken or slow. Capped
// at 45 chunks (~450MB — comfortably past a 216M app cap and the ~65M guard
// threshold on a 512M-plan host) and 60s wall-clock, whichever comes first.
// If the guard fires first, the container gets killed/restarted before this
// cap is ever reached — that's the expected, desired outcome. If the guard
// DOESN'T fire, this stops on its own instead of pushing the host into a
// genuine OOM/thrash spiral.
const MAX_CHUNKS = 45;
const MAX_MS = 60 * 1000;
let eatInProgress = false;

app.get("/eat", (req, res) => {
  if (eatInProgress) {
    return res.status(409).json({ ok: false, note: "An /eat run is already in progress on this instance." });
  }
  eatInProgress = true;
  const store = [];        // keep every chunk forever so RAM only grows
  let count = 0;
  const startedAt = Date.now();
  const interval = setInterval(() => {
    store.push(crypto.randomBytes(10 * 1024 * 1024)); // +10 MB each tick, unique bytes
    count++;
    const rssMB = Math.round(process.memoryUsage().rss / (1024 * 1024));
    console.log(`count: ${count}   (~${count * 10} MB allocated, process RSS ${rssMB} MB)`);
    if (count >= MAX_CHUNKS || Date.now() - startedAt >= MAX_MS) {
      clearInterval(interval);
      store.length = 0;    // release it — safety stop reached without the guard firing
      eatInProgress = false;
      console.log(`SAFETY STOP: reached ${count} chunks (~${count * 10} MB) after ${Date.now() - startedAt}ms — releasing memory. The host-memory guard did not restart this container before the safety cap.`);
    }
  }, 100);
  res.json({ ok: true, note: `Eating 10MB every 100ms, capped at ${MAX_CHUNKS} chunks (~${MAX_CHUNKS * 10}MB) / ${MAX_MS / 1000}s. Watch \`docker logs -f <container>\` for the count. Expected: the health-agent's host-memory guard restarts this container before the cap is hit.` });
});

app.listen(PORT, "0.0.0.0", () => console.log(`listening on ${PORT}`));
