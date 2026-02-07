/* eslint-disable no-console */
const { v4: uuidv4 } = require("uuid");
const { connectToDatabase, closeConnection } = require("./db");

const APPLY = process.argv.includes("--apply");
const DEDUPE = process.argv.includes("--dedupe"); // optional

const ENTRIES_COLLECTION = process.env.ENTRIES_COLLECTION || "entries";
const SCREENSHOTS_COLLECTION = process.env.SCREENSHOTS_COLLECTION || "screenshots";

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function printIndexes(col, label) {
  const idx = await col.indexes();
  console.log(`\n===== ${label} indexes =====`);
  idx.forEach((i) => console.log(JSON.stringify(i, null, 2)));
  return idx;
}

async function dropIndexByName(col, name) {
  const idx = await col.indexes();
  const exists = idx.some((i) => i.name === name);
  if (!exists) {
    console.log(`⚪ Index not found (skip): ${col.collectionName}.${name}`);
    return;
  }

  if (!APPLY) {
    console.log(`🟡 [DRY RUN] Would drop index: ${col.collectionName}.${name}`);
    return;
  }

  await col.dropIndex(name);
  console.log(`🗑️ Dropped index: ${col.collectionName}.${name}`);
}

async function ensureIndex(col, key, options) {
  if (!APPLY) {
    console.log(`🟡 [DRY RUN] Would create index on ${col.collectionName}:`, key, options);
    return;
  }
  const name = await col.createIndex(key, options);
  console.log(`🧱 Created/ensured index: ${col.collectionName}.${name}`);
}

async function backfillMissingUuidField(col, fieldName) {
  const q = {
    $or: [
      { [fieldName]: { $exists: false } },
      { [fieldName]: null },
      { [fieldName]: "" },
    ],
  };

  const docs = await col.find(q, { projection: { _id: 1 } }).toArray();
  if (!docs.length) {
    console.log(`✅ No missing/null ${fieldName} in ${col.collectionName}`);
    return;
  }

  console.log(`🔧 Found ${docs.length} docs missing/null ${fieldName} in ${col.collectionName}`);

  if (!APPLY) {
    console.log(`🟡 [DRY RUN] Would backfill ${fieldName} for ${docs.length} docs`);
    return;
  }

  for (const batch of chunk(docs, 500)) {
    const ops = batch.map((d) => ({
      updateOne: { filter: { _id: d._id }, update: { $set: { [fieldName]: uuidv4() } } },
    }));
    await col.bulkWrite(ops, { ordered: false });
  }

  console.log(`✅ Backfilled ${fieldName} for ${docs.length} docs`);
}

// OPTIONAL: if your DB already has duplicates for the new unique keys, this deletes older duplicates.
// Run with: node fix-indexes.js --apply --dedupe
async function dedupeByKeyKeepNewest(col, matchStage, keyFields) {
  const pipeline = [
    { $match: matchStage },
    {
      $group: {
        _id: keyFields.reduce((acc, f) => ((acc[f] = `$${f}`), acc), {}),
        ids: { $push: { _id: "$_id", createdAt: "$createdAt", verified: "$verified" } },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ];

  const dups = await col.aggregate(pipeline).toArray();
  if (!dups.length) {
    console.log(`✅ No duplicates in ${col.collectionName} for keys: ${keyFields.join(", ")}`);
    return;
  }

  console.log(`⚠️ Found ${dups.length} duplicate groups in ${col.collectionName} for keys: ${keyFields.join(", ")}`);

  if (!APPLY || !DEDUPE) {
    console.log(`🟡 ${!APPLY ? "[DRY RUN]" : ""}${!DEDUPE ? " (Run with --dedupe to auto-remove older duplicates)" : ""}`);
    // print a small sample
    console.log("Sample duplicate group:", JSON.stringify(dups[0], null, 2));
    return;
  }

  const deleteIds = [];
  for (const g of dups) {
    // keep best: prefer verified:true, then newest createdAt
    const sorted = g.ids.sort((a, b) => {
      const av = a.verified ? 1 : 0;
      const bv = b.verified ? 1 : 0;
      if (bv !== av) return bv - av;
      const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bt - at;
    });

    const keep = sorted[0];
    const toDelete = sorted.slice(1).map((x) => x._id);
    deleteIds.push(...toDelete);

    console.log(`🧹 Keeping ${keep._id} | deleting ${toDelete.length} duplicates`);
  }

  for (const batch of chunk(deleteIds, 500)) {
    await col.deleteMany({ _id: { $in: batch } });
  }

  console.log(`✅ Deleted ${deleteIds.length} duplicate docs from ${col.collectionName}`);
}

(async () => {
  try {
    console.log(`\n🔧 Fix Indexes Script (${APPLY ? "APPLY" : "DRY RUN"})`);
    const { db } = await connectToDatabase();

    const entries = db.collection(ENTRIES_COLLECTION);
    const screenshots = db.collection(SCREENSHOTS_COLLECTION);

    // 1) Print current indexes
    await printIndexes(entries, ENTRIES_COLLECTION);
    await printIndexes(screenshots, SCREENSHOTS_COLLECTION);

    // 2) Drop legacy/bad indexes (based on YOUR real output)
    console.log(`\n===== Dropping LEGACY/BAD indexes =====`);

    await dropIndexByName(entries, "linkId_1");
    await dropIndexByName(entries, "linkId_1_upiId_1");
    await dropIndexByName(entries, "linkId_1_upiId_1_type_1");

    await dropIndexByName(screenshots, "userId_1_bundleSig_1");
    await dropIndexByName(screenshots, "userId_1_linkId_1_bundleSig_1");
    await dropIndexByName(screenshots, "linkId_1_handle_1");

    // 3) BACKFILL missing IDs (this fixes your current E11000: entryId:null)
    console.log(`\n===== Backfilling missing IDs =====`);
    await backfillMissingUuidField(entries, "entryId");
    await backfillMissingUuidField(screenshots, "screenshotId"); // safe

    // 4) OPTIONAL: Dedupe if needed for new unique indexes
    if (DEDUPE) {
      console.log(`\n===== DEDUPE mode ON =====`);

      // Entries: type 0 unique should be (linkId, upiId)
      await dedupeByKeyKeepNewest(entries, { type: 0 }, ["linkId", "upiId"]);

      // Entries: type 1 unique should be (userId, linkId)
      await dedupeByKeyKeepNewest(entries, { type: 1 }, ["userId", "linkId"]);

      // Screenshots: unique should be (userId, linkId)
      await dedupeByKeyKeepNewest(screenshots, {}, ["userId", "linkId"]);
    }

    // 5) Ensure required indexes
    console.log(`\n===== Ensuring REQUIRED indexes =====`);

    await ensureIndex(entries, { entryId: 1 }, { unique: true });

// Employee: unique per (type=0, linkId, upiId)
await ensureIndex(
  entries,
  { linkId: 1, upiId: 1 },
  { unique: true, partialFilterExpression: { type: 0 } }
);

// User: unique per (type=1, userId, linkId)
await ensureIndex(
  entries,
  { userId: 1, linkId: 1 },
  { unique: true, partialFilterExpression: { type: 1 } }
);
    await ensureIndex(screenshots, { screenshotId: 1 }, { unique: true });

    await ensureIndex(screenshots, { userId: 1, linkId: 1 }, { unique: true });

    await ensureIndex(
      screenshots,
      { linkId: 1, commentIds: 1 },
      { unique: true, partialFilterExpression: { verified: true, commentIds: { $type: "array" } } }
    );

    await ensureIndex(
      screenshots,
      { linkId: 1, replyIds: 1 },
      { unique: true, partialFilterExpression: { verified: true, replyIds: { $type: "array" } } }
    );

    // 6) Print final indexes
    console.log(`\n===== FINAL indexes (${APPLY ? "APPLIED" : "DRY RUN"}) =====`);
    await printIndexes(entries, ENTRIES_COLLECTION);
    await printIndexes(screenshots, SCREENSHOTS_COLLECTION);

    console.log(`\n✅ Done. (${APPLY ? "Changes applied." : "Dry run only. Use --apply to execute."})\n`);
  } catch (err) {
    console.error("❌ Script failed:", err);
    process.exitCode = 1;
  } finally {
    await closeConnection();
  }
})();
