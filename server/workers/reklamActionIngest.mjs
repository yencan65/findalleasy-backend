// server/workers/reklamActionIngest.mjs
// Thin wrapper over generic feedIngest.mjs
// Purpose: run ReklamAction XML/CSV/JSON feed -> Mongo catalog_items
//
// Minimum ENV:
//   MONGO_URI or MONGODB_URI
//   REKLAMACTION_FEED_URL   (or FEED_URL)
//
// Optional:
//   FEED_FORMAT (csv|xml|json)
//   FEED_ITEM_PATH (xml/json dot-path)
//   FEED_DEFAULT_CURRENCY (default TRY)
//   FEED_MAX_ITEMS (default 20000)
//   FEED_HEADERS_JSON (for auth headers)

import "dotenv/config";

// Allow both names for convenience
if (!process.env.FEED_URL && process.env.REKLAMACTION_FEED_URL) {
  process.env.FEED_URL = process.env.REKLAMACTION_FEED_URL;
}

// Defaults (do not override if explicitly set)
process.env.FEED_PROVIDER_KEY = process.env.FEED_PROVIDER_KEY || "reklamaction";
process.env.FEED_PROVIDER_NAME = process.env.FEED_PROVIDER_NAME || "ReklamAction Feed";
process.env.FEED_DEFAULT_CURRENCY = process.env.FEED_DEFAULT_CURRENCY || "TRY";
process.env.FEED_CAMPAIGN_ID = process.env.FEED_CAMPAIGN_ID || "0";

// Runs immediately on import
await import("./feedIngest.mjs");
