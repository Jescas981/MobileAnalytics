import os
import json
import threading
import sys
from datetime import datetime, timezone, timedelta
from flask import Flask, jsonify, request, render_template
from flask_cors import CORS
import paho.mqtt.client as mqtt
import ssl
from dotenv import load_dotenv
from pymongo import MongoClient
from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError

load_dotenv()

app = Flask(__name__)
CORS(app)

# ── MongoDB Configuration ─────────────────────────────────────────────────────
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/vehicle_sensor")
print(f"MONGO_URI: {MONGO_URI}")

# Initialize MongoDB manually
mongo_client = None
mongo_db = None

def init_mongo():
    """Initialize MongoDB connection manually"""
    global mongo_client, mongo_db
    
    try:
        print("[Mongo] Attempting to connect...")
        mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        # Test connection
        mongo_client.admin.command('ping')
        print("[Mongo] Client connected successfully")
        
        # Get database name from URI or use default
        db_name = MONGO_URI.split('/')[-1].split('?')[0] or 'vehicle_sensor'
        mongo_db = mongo_client[db_name]
        print(f"[Mongo] Using database: {db_name}")
        
        # List collections
        collections = mongo_db.list_collection_names()
        print(f"[Mongo] Existing collections: {collections}")
        
        return True
    except ConnectionFailure as e:
        print(f"[Mongo] Connection failure: {e}")
    except ServerSelectionTimeoutError as e:
        print(f"[Mongo] Server selection timeout: {e}")
    except Exception as e:
        print(f"[Mongo] Unexpected error: {e}")
    
    return False

# Initialize MongoDB at startup
if not init_mongo():
    print("[Mongo] Failed to connect to MongoDB. Exiting.")
    sys.exit(1)

# ── MQTT Config ────────────────────────────────────────────────────────────────
MQTT_HOST     = os.getenv("MQTT_HOST", "localhost")
MQTT_PORT     = int(os.getenv("MQTT_PORT", 8883))
MQTT_USER     = os.getenv("MQTT_USER", "")
MQTT_PASS     = os.getenv("MQTT_PASS", "")
MQTT_CA_CERT  = os.getenv("MQTT_CA_CERT", "ca.crt")
MQTT_TOPIC_IMU = "/mobile/imu"
MQTT_TOPIC_GPS = "/mobile/gps"

# Global flag to indicate MongoDB is ready
mongo_ready = threading.Event()

# ── Indexes (run safely) ───────────────────────────────────────────────────────
def ensure_indexes():
    """Create indexes if they don't exist"""
    try:
        if mongo_db is not None:
            # Create indexes
            mongo_db.imu.create_index([("received_at", 1)])
            mongo_db.gps.create_index([("received_at", 1)])
            print("[Mongo] Indexes created/verified")
        else:
            print("[Mongo] Cannot create indexes: mongo_db is None")
    except Exception as e:
        print(f"[Mongo] Error creating indexes: {e}")

# ── MQTT Callbacks ─────────────────────────────────────────────────────────────
def on_connect(client, userdata, flags, rc):
    codes = {0:"OK",1:"Wrong protocol",2:"Client ID rejected",3:"Broker unavailable",
             4:"Bad credentials",5:"Not authorized"}
    print(f"[MQTT] Connected — {codes.get(rc, rc)}")
    if rc == 0:
        client.subscribe(MQTT_TOPIC_IMU, qos=1)
        client.subscribe(MQTT_TOPIC_GPS, qos=1)

def on_message(client, userdata, msg):
    # Wait for MongoDB to be ready (with timeout)
    if msg.retain == 1:
        print("[MQTT] Ignoring retained message")
        return
        
    if not mongo_ready.wait(timeout=10):
        print("[MQTT] Timed out waiting for MongoDB, dropping message")
        return
    
    try:
        payload = json.loads(msg.payload.decode())
        received_at = datetime.now(timezone.utc)

        # Use the global mongo_db directly
        global mongo_db
        
        if mongo_db is None:
            print("[MQTT] mongo_db is None, cannot save data")
            return

        if msg.topic == MQTT_TOPIC_IMU:
            doc = {
                "timestamp": payload.get("timestamp"),
                "session": payload.get("session"),
                "ax": payload["acc"]["x"],
                "ay": payload["acc"]["y"],
                "az": payload["acc"]["z"],
                "gx": payload.get("gyro", {}).get("x", 0.0),
                "gy": payload.get("gyro", {}).get("y", 0.0),
                "gz": payload.get("gyro", {}).get("z", 0.0),
                "received_at": received_at,
            }
            result = mongo_db.imu.insert_one(doc)
            print(f"[MQTT] IMU data saved: session={payload.get('session')}, id={result.inserted_id}")

        elif msg.topic == MQTT_TOPIC_GPS:
            doc = {
                "timestamp": payload.get("timestamp"),
                "session": payload.get("session"),
                "lat": payload["gps"]["lat"],
                "lon": payload["gps"]["lon"],
                "received_at": received_at,
            }
            result = mongo_db.gps.insert_one(doc)
            print(f"[MQTT] GPS data saved: session={payload.get('session')}, id={result.inserted_id}")

    except KeyError as e:
        print(f"[MQTT] Missing key in payload: {e}")
    except Exception as e:
        print(f"[MQTT] Message error: {e}")

def on_disconnect(client, userdata, rc):
    print(f"[MQTT] Disconnected (rc={rc})")

def start_mqtt():
    """Start MQTT client in a separate thread"""
    print("[MQTT] Thread started, waiting for MongoDB...")
    
    # Wait for MongoDB to be ready before connecting
    if not mongo_ready.wait(timeout=30):
        print("[MQTT] MongoDB not ready after 30 seconds, aborting MQTT connection")
        return

    print("[MQTT] MongoDB ready, connecting to broker...")
    
    client = mqtt.Client(client_id="flask-backend", protocol=mqtt.MQTTv311)
    
    # TLS setup
    try:
        if os.path.exists(MQTT_CA_CERT):
            client.tls_set(
                ca_certs=MQTT_CA_CERT,
                tls_version=ssl.PROTOCOL_TLS,
            )
            client.tls_insecure_set(False)
            print("[MQTT] TLS configured with CA certificate")
        else:
            print(f"[MQTT] Warning: CA certificate not found at {MQTT_CA_CERT}")
            # Try without TLS for development
            print("[MQTT] Attempting connection without TLS...")
    except Exception as e:
        print(f"[MQTT] TLS setup error: {e}")
        return

    if MQTT_USER:
        client.username_pw_set(MQTT_USER, MQTT_PASS)
        print(f"[MQTT] Username set: {MQTT_USER}")
    
    client.on_connect    = on_connect
    client.on_message    = on_message
    client.on_disconnect = on_disconnect
    
    try:
        print(f"[MQTT] Connecting to {MQTT_HOST}:{MQTT_PORT}...")
        client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
        print("[MQTT] Connected, starting loop...")
        client.loop_forever()
    except Exception as e:
        print(f"[MQTT] Connection error: {e}")

# ── REST API ───────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")

def serialize(doc):
    doc["_id"] = str(doc["_id"])
    if "received_at" in doc:
        doc["received_at"] = doc["received_at"].isoformat()
    return doc

@app.route("/api/health")
def health():
    # Test MongoDB connection
    mongo_status = "error"
    mongo_details = "Not connected"
    
    try:
        if mongo_db is not None:
            mongo_db.command('ping')
            mongo_status = "ok"
            mongo_details = f"Connected to {MONGO_URI}"
        else:
            mongo_details = "mongo_db is None"
    except Exception as e:
        mongo_status = "error"
        mongo_details = str(e)
    
    return jsonify({
        "status": "ok",
        "mongo": mongo_status,
        "mongo_details": mongo_details,
        "mongo_ready": mongo_ready.is_set()
    })

# ── IMU endpoints ──────────────────────────────────────────────────────────────
@app.route("/api/sessions")
def sessions():
    """Distinct session IDs across both collections, newest first."""
    if mongo_db is None:
        return jsonify({"error": "MongoDB not connected"}), 500
    
    try:
        imu_s = mongo_db.imu.distinct("session")
        gps_s = mongo_db.gps.distinct("session")
        all_s = sorted(set(imu_s) | set(gps_s), reverse=True)
        return jsonify(all_s)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/imu")
def get_imu():
    if mongo_db is None:
        return jsonify({"error": "MongoDB not connected"}), 500
    
    try:
        query, limit = _build_query(request.args)
        docs = list(
            mongo_db.imu.find(query, {"_id":0, "received_at":1, "ax":1, "ay":1, "az":1, "gx":1, "gy":1, "gz":1, "session":1, "timestamp":1})
            .sort("received_at", 1)
            .limit(limit)
        )
        for d in docs:
            d["received_at"] = d["received_at"].isoformat()
        return jsonify(docs)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/imu/stats")
def imu_stats():
    if mongo_db is None:
        return jsonify({"error": "MongoDB not connected"}), 500
    
    try:
        query, _ = _build_query(request.args)
        pipeline = [
            {"$match": query},
            {"$group": {
                "_id": None,
                "count":  {"$sum": 1},
                "ax_avg": {"$avg": "$ax"}, "ax_min": {"$min": "$ax"}, "ax_max": {"$max": "$ax"},
                "ay_avg": {"$avg": "$ay"}, "ay_min": {"$min": "$ay"}, "ay_max": {"$max": "$ay"},
                "az_avg": {"$avg": "$az"}, "az_min": {"$min": "$az"}, "az_max": {"$max": "$az"},
                "gx_avg": {"$avg": "$gx"}, "gx_min": {"$min": "$gx"}, "gx_max": {"$max": "$gx"},
                "gy_avg": {"$avg": "$gy"}, "gy_min": {"$min": "$gy"}, "gy_max": {"$max": "$gy"},
                "gz_avg": {"$avg": "$gz"}, "gz_min": {"$min": "$gz"}, "gz_max": {"$max": "$gz"},
            }}
        ]
        result = list(mongo_db.imu.aggregate(pipeline))
        if result:
            result[0].pop("_id", None)
        return jsonify(result[0] if result else {})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── GPS endpoints ──────────────────────────────────────────────────────────────
@app.route("/api/gps")
def get_gps():
    if mongo_db is None:
        return jsonify({"error": "MongoDB not connected"}), 500
    
    try:
        query, limit = _build_query(request.args)
        docs = list(
            mongo_db.gps.find(query, {"_id":0, "received_at":1, "lat":1, "lon":1, "session":1, "timestamp":1})
            .sort("received_at", 1)
            .limit(limit)
        )
        for d in docs:
            d["received_at"] = d["received_at"].isoformat()
        return jsonify(docs)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/gps/latest")
def gps_latest():
    if mongo_db is None:
        return jsonify({"error": "MongoDB not connected"}), 500
    
    try:
        doc = mongo_db.gps.find_one(sort=[("received_at", -1)])
        if not doc:
            return jsonify(None)
        return jsonify(serialize(doc))
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── Summary / counts ───────────────────────────────────────────────────────────
@app.route("/api/summary")
def summary():
    if mongo_db is None:
        return jsonify({"error": "MongoDB not connected"}), 500
    
    try:
        query, _ = _build_query(request.args)
        return jsonify({
            "imu_count": mongo_db.imu.count_documents(query),
            "gps_count": mongo_db.gps.count_documents(query),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── Available days ─────────────────────────────────────────────────────────────
@app.route("/api/days")
def available_days():
    if mongo_db is None:
        return jsonify({"error": "MongoDB not connected"}), 500
    
    try:
        pipeline = [
            {"$group": {"_id": {
                "y": {"$year": "$received_at"},
                "m": {"$month": "$received_at"},
                "d": {"$dayOfMonth": "$received_at"}
            }}},
            {"$sort": {"_id": -1}},
            {"$limit": 90}
        ]
        days_imu = list(mongo_db.imu.aggregate(pipeline))
        days_gps = list(mongo_db.gps.aggregate(pipeline))
        days = set()
        for d in days_imu + days_gps:
            v = d["_id"]
            days.add(f"{v['y']:04d}-{v['m']:02d}-{v['d']:02d}")
        return jsonify(sorted(days, reverse=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── Helper ─────────────────────────────────────────────────────────────────────
def _build_query(args):
    query = {}
    limit = int(args.get("limit", 2000))

    # Session filter
    if args.get("session") not in (None, "", "all"):
        try:
            query["session"] = int(args["session"])
        except ValueError:
            query["session"] = args["session"]

    # Time window
    minutes = args.get("minutes")
    if minutes:
        dt_from = datetime.now(timezone.utc) - timedelta(minutes=float(minutes))
        query["received_at"] = {"$gte": dt_from}
    else:
        dt_filter = {}
        if args.get("from_dt"):
            dt_filter["$gte"] = datetime.fromisoformat(args["from_dt"].replace("Z", "+00:00"))
        if args.get("to_dt"):
            dt_filter["$lte"] = datetime.fromisoformat(args["to_dt"].replace("Z", "+00:00"))
        if dt_filter:
            query["received_at"] = dt_filter

    return query, limit

# ── Entry point ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 50)
    print("Starting Vehicle Sensor Application")
    print("=" * 50)
    print(f"Python version: {sys.version}")
    print(f"MongoDB URI: {MONGO_URI}")
    
    # Ensure indexes are created
    ensure_indexes()
    
    # Signal that MongoDB is ready
    mongo_ready.set()
    print("[Mongo] Ready flag set")

    # Start MQTT in background thread
    mqtt_thread = threading.Thread(target=start_mqtt, daemon=True)
    mqtt_thread.start()
    print("MQTT thread started")

    # Start Flask app
    print("Starting Flask server on http://0.0.0.0:5000")
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)