const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// still serve the calculator at /
app.use(express.static(__dirname));

// ONE endpoint: hit it once, it keeps eating RAM in a loop and prints the count.
// The count keeps climbing until the container runs out of RAM and dies.
// The last count printed in `docker logs` = how far this architecture got.
app.get("/eat", (req, res) => {
  const store = [];        // keep every chunk forever so RAM only grows
  let count = 0;
  setInterval(() => {
    store.push(Buffer.alloc(10 * 1024 * 1024, 1)); // +10 MB each tick, actually touched
    count++;
    const rssMB = Math.round(process.memoryUsage().rss / (1024 * 1024));
    console.log(`count: ${count}   (~${count * 10} MB allocated, process RSS ${rssMB} MB)`);
  }, 100);
  res.json({ ok: true, note: "Eating 10MB every 100ms. Watch `docker logs -f <container>` for the count. It stops when the container OOMs — that last count is your number." });
});

app.listen(PORT, "0.0.0.0", () => console.log(`listening on ${PORT}`));
