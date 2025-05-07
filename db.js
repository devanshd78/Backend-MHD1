// db.js
require('dotenv').config();
const { MongoClient } = require('mongodb');

const { MONGODB_URI } = process.env;

if (!MONGODB_URI) {
    throw new Error('Missing MONGODB_URI environment variable');
}

let cachedClient = null;
let cachedDb = null;

/**
 * Connects to MongoDB (reuses the same client on subsequent calls).
 * Uses the default database specified in the connection URI.
 */
async function connectToDatabase() {
    if (cachedClient && cachedDb) {
        return { client: cachedClient, db: cachedDb };
    }

    const client = new MongoClient(MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    });

    await client.connect();
    const db = client.db();

    cachedClient = client;
    cachedDb = db;

    console.log(`✔️ Connected to MongoDB`);
    return { client, db };
}

/**
 * Gracefully closes the MongoDB connection.
 */
async function closeConnection() {
    if (cachedClient) {
        await cachedClient.close();
        cachedClient = null;
        cachedDb = null;
        console.log('🔒 MongoDB connection closed');
    }
}

module.exports = {
    connectToDatabase,
    closeConnection,
};
