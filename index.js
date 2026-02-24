require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const mqtt = require('mqtt');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files
app.use('/static', express.static(path.join(__dirname, 'static')));

// ── Configuration ─────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/vehicle_sensor";
const MQTT_HOST = process.env.MQTT_HOST || "localhost";
const MQTT_PORT = parseInt(process.env.MQTT_PORT || "8883");
const MQTT_USER = process.env.MQTT_USER || "";
const MQTT_PASS = process.env.MQTT_PASS || "";
const MQTT_CA_CERT = process.env.MQTT_CA_CERT || "";
const MQTT_TOPIC_IMU = "/mobile/imu";
const MQTT_TOPIC_GPS = "/mobile/gps";

let db;
let imuCollection;
let gpsCollection;

// ── MongoDB Initialization ──────────────────────────────────────────────────
async function initMongo() {
    try {
        console.log("[Mongo] Attempting to connect...");
        const client = await MongoClient.connect(MONGO_URI);
        console.log("[Mongo] Client connected successfully");

        const dbName = MONGO_URI.split('/').pop().split('?')[0] || 'vehicle_sensor';
        db = client.db(dbName);
        console.log(`[Mongo] Using database: ${dbName}`);

        imuCollection = db.collection('imu');
        gpsCollection = db.collection('gps');

        // Create indexes
        await imuCollection.createIndex({ received_at: 1 });
        await gpsCollection.createIndex({ received_at: 1 });
        console.log("[Mongo] Indexes created/verified");

        return true;
    } catch (err) {
        console.error(`[Mongo] Initialization error: ${err.message}`);
        process.exit(1);
    }
}

// ── MQTT Initialization ──────────────────────────────────────────────────────
function initMqtt() {
    console.log("[MQTT] Connecting to broker...");

    const options = {
        port: MQTT_PORT,
        host: MQTT_HOST,
        clientId: 'express-backend-' + Math.random().toString(16).substr(2, 8),
        protocol: MQTT_PORT === 8883 ? 'mqtts' : 'mqtt',
    };

    if (MQTT_USER) {
        options.username = MQTT_USER;
        options.password = MQTT_PASS;
    }

    // if (fs.existsSync(MQTT_CA_CERT)) {
    //     options.ca = fs.readFileSync(MQTT_CA_CERT);
    //     options.rejectUnauthorized = false; // Match the python 'tls_insecure_set(False)' if it was True, but here it was False. Actually, in python it was client.tls_insecure_set(False) meaning it SHOULD validate. But often in dev we use self-signed.
    //     console.log("[MQTT] TLS configured with CA certificate");
    // }

    if (process.env.MQTT_CA_CERT) {
    options.ca = process.env.MQTT_CA_CERT.replace(/\\n/g, '\n');
    options.rejectUnauthorized = true;
    }

    const client = mqtt.connect(options);

    client.on('connect', () => {
        console.log("[MQTT] Connected");
        client.subscribe(MQTT_TOPIC_IMU, { qos: 1 });
        client.subscribe(MQTT_TOPIC_GPS, { qos: 1 });
    });

    client.on('message', async (topic, message) => {
        try {
            const payload = JSON.parse(message.toString());
            const received_at = new Date();

            if (topic === MQTT_TOPIC_IMU) {
                const doc = {
                    timestamp: payload.timestamp,
                    session: payload.session,
                    ax: payload.acc.x,
                    ay: payload.acc.y,
                    az: payload.acc.z,
                    gx: payload.gyro ? payload.gyro.x : 0.0,
                    gy: payload.gyro ? payload.gyro.y : 0.0,
                    gz: payload.gyro ? payload.gyro.z : 0.0,
                    received_at: received_at,
                };
                const result = await imuCollection.insertOne(doc);
                console.log(`[MQTT] IMU data saved: session=${payload.session}, id=${result.insertedId}`);
            } else if (topic === MQTT_TOPIC_GPS) {
                const doc = {
                    timestamp: payload.timestamp,
                    session: payload.session,
                    lat: payload.gps.lat,
                    lon: payload.gps.lon,
                    received_at: received_at,
                };
                const result = await gpsCollection.insertOne(doc);
                console.log(`[MQTT] GPS data saved: session=${payload.session}, id=${result.insertedId}`);
            }
        } catch (err) {
            console.error(`[MQTT] Message error: ${err.message}`);
        }
    });

    client.on('error', (err) => {
        console.error(`[MQTT] Error: ${err.message}`);
    });

    client.on('close', () => {
        console.log("[MQTT] Connection closed");
    });
}

// ── REST API ─────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

app.get('/api/health', async (req, res) => {
    let mongoStatus = "error";
    let mongoDetails = "Not connected";

    try {
        if (db) {
            await db.command({ ping: 1 });
            mongoStatus = "ok";
            mongoDetails = `Connected to ${MONGO_URI}`;
        }
    } catch (err) {
        mongoDetails = err.message;
    }

    res.json({
        status: "ok",
        mongo: mongoStatus,
        mongo_details: mongoDetails,
        mongo_ready: !!db
    });
});

app.get('/api/sessions', async (req, res) => {
    try {
        const imuSessions = await imuCollection.distinct("session");
        const gpsSessions = await gpsCollection.distinct("session");
        const allSessions = [...new Set([...imuSessions, ...gpsSessions])].sort((a, b) => {
            if (typeof a === 'number' && typeof b === 'number') return b - a;
            return String(b).localeCompare(String(a));
        });
        res.json(allSessions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function buildQuery(query) {
    const filter = {};
    const limit = parseInt(query.limit || "2000");

    if (query.session && query.session !== "all") {
        const sessionInt = parseInt(query.session);
        filter.session = isNaN(sessionInt) ? query.session : sessionInt;
    }

    if (query.minutes) {
        const dtFrom = new Date(Date.now() - parseFloat(query.minutes) * 60 * 1000);
        filter.received_at = { $gte: dtFrom };
    } else {
        const dtFilter = {};
        if (query.from_dt) {
            dtFilter.$gte = new Date(query.from_dt);
        }
        if (query.to_dt) {
            dtFilter.$lte = new Date(query.to_dt);
        }
        if (Object.keys(dtFilter).length > 0) {
            filter.received_at = dtFilter;
        }
    }

    return { filter, limit };
}

app.get('/api/imu', async (req, res) => {
    try {
        const { filter, limit } = buildQuery(req.query);
        const docs = await imuCollection.find(filter, {
            projection: { _id: 0, received_at: 1, ax: 1, ay: 1, az: 1, gx: 1, gy: 1, gz: 1, session: 1, timestamp: 1 }
        })
        .sort({ received_at: 1 })
        .limit(limit)
        .toArray();
        
        res.json(docs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/imu/stats', async (req, res) => {
    try {
        const { filter } = buildQuery(req.query);
        const pipeline = [
            { $match: filter },
            { $group: {
                _id: null,
                count:  { $sum: 1 },
                ax_avg: { $avg: "$ax" }, ax_min: { $min: "$ax" }, ax_max: { $max: "$ax" },
                ay_avg: { $avg: "$ay" }, ay_min: { $min: "$ay" }, ay_max: { $max: "$ay" },
                az_avg: { $avg: "$az" }, az_min: { $min: "$az" }, az_max: { $max: "$az" },
                gx_avg: { $avg: "$gx" }, gx_min: { $min: "$gx" }, gx_max: { $max: "$gx" },
                gy_avg: { $avg: "$gy" }, gy_min: { $min: "$gy" }, gy_max: { $max: "$gy" },
                gz_avg: { $avg: "$gz" }, gz_min: { $min: "$gz" }, gz_max: { $max: "$gz" },
            }}
        ];
        const result = await imuCollection.aggregate(pipeline).toArray();
        if (result.length > 0) {
            delete result[0]._id;
            res.json(result[0]);
        } else {
            res.json({});
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/gps', async (req, res) => {
    try {
        const { filter, limit } = buildQuery(req.query);
        const docs = await gpsCollection.find(filter, {
            projection: { _id: 0, received_at: 1, lat: 1, lon: 1, session: 1, timestamp: 1 }
        })
        .sort({ received_at: 1 })
        .limit(limit)
        .toArray();

        res.json(docs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/gps/latest', async (req, res) => {
    try {
        const doc = await gpsCollection.findOne({}, { sort: { received_at: -1 } });
        res.json(doc);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/summary', async (req, res) => {
    try {
        const { filter } = buildQuery(req.query);
        const imuCount = await imuCollection.countDocuments(filter);
        const gpsCount = await gpsCollection.countDocuments(filter);
        res.json({
            imu_count: imuCount,
            gps_count: gpsCount
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/days', async (req, res) => {
    try {
        const pipeline = [
            { $group: { _id: {
                y: { $year: "$received_at" },
                m: { $month: "$received_at" },
                d: { $dayOfMonth: "$received_at" }
            }}},
            { $sort: { "_id.y": -1, "_id.m": -1, "_id.d": -1 } },
            { $limit: 90 }
        ];
        const daysImu = await imuCollection.aggregate(pipeline).toArray();
        const daysGps = await gpsCollection.aggregate(pipeline).toArray();
        
        const daysSet = new Set();
        [...daysImu, ...daysGps].forEach(d => {
            const v = d._id;
            daysSet.add(`${v.y}-${String(v.m).padStart(2, '0')}-${String(v.d).padStart(2, '0')}`);
        });
        
        res.json([...daysSet].sort().reverse());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

async function start() {
    await initMongo();
    initMqtt();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on http://0.0.0.0:${PORT}`);
    });
}

start();
