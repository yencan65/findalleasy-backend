import zlib from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse";

const feedUrl = process.env.ADMITAD_FEED_URL;
if (!feedUrl) throw new Error("ADMITAD_FEED_URL missing");

const delimiter = process.env.ADMITAD_CSV_DELIMITER || ";";

const r = await fetch(feedUrl, { method: "GET", redirect: "follow" });
if (!r.ok) throw new Error(`Feed download failed: ${r.status}`);

const enc = (r.headers.get("content-encoding") || "").toLowerCase();
const isGzip = enc.includes("gzip") || feedUrl.toLowerCase().includes(".gz");

const src = Readable.fromWeb(r.body);
const gunzip = isGzip ? zlib.createGunzip() : null;

let shown = 0;
let total = 0;

const parser = parse({
  columns: true,
  bom: true,
  delimiter,
  relax_column_count: true,
  relax_quotes: true,
  skip_empty_lines: true,
  trim: true,
});

parser.on("data", (row) => {
  total++;
  if (shown < 5) {
    shown++;
    console.log({
      id: row.id,
      name: row.name,
      price: row.price,
      oldprice: row.oldprice,
      url: row.url,
      picture: row.picture,
      currencyId: row.currencyId,
    });
  }
  if (total >= 2000) parser.end(); // fazla uzamasın
});

await pipeline(gunzip ? src.pipe(gunzip) : src, parser);

console.log("done", { total, shown, delimiter, isGzip });
