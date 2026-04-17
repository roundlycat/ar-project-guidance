# Visual Cortex & Semantic Brain Pipeline (Sensor Ecology AR)

## 1. System Overview
The AR Guided Workbench uses a distributed "Fast Track / Slow Track" AI pipeline to bridge real-time object tracking (0-latency haptics) with Deep Semantic Knowledge (vector-database identification). 

- **Fast Track (Visual Cortex):** Runs locally on the Windows workbench via `visual_cortex.py`. It uses YOLOv8 nano to read the camera feed, generate bounding boxes at 60fps, and dispatch spatial stereo rumble profiles to an Xbox Controller via `XInput-Python` using the "Grammar of Uncertainty" (smooth hums for locked focus, jarring rumbles for lost confidence).
- **Slow Track (Semantic Brain):** Runs on the Raspberry Pi "Inferno" node (`registry_intake.py` via Uvicorn/FastAPI). It consumes an HTTP POST bounding-box crop, asks Gemini for a visual context description, converts the text to mathematical embeddings via `sentence-transformers`, and runs cosine similarity against the `parts_catalogue` in PostgreSQL to extract the exact component.

## 2. Boot Sequence
Because the components talk strictly over local HTTP, no WSL or HTTPS certificates are necessary.

**Terminal 1 (The Brain):**
```powershell
# Set environmental passkeys (Powershell)
$env:GEMINI_API_KEY="AIzaSy...[REDACTED]"
$env:DATABASE_URL="dbname=sensor_ecology user=sean password=[REDACTED] host=192.168.0.28"

# Boot the FastAPI Server
uvicorn server:app --port 8000
```

**Terminal 2 (The Cortex):**
```powershell
# Boot the Local Reflex engine (Xbox Controller MUST be wired/active first)
python visual_cortex.py
```

## 3. The "Spacebar Snap" Workflow
Because YOLOv8n is trained on general COCO datasets (cats, cars, kites) instead of microscopic electronic PCBs, the Fast Track is only used for geometric isolation (grabbing the bounding box). 

To extract absolute knowledge of a component:
1. Place the component under the crosshairs until the Fast Track locks a bounding box.
2. Tap the **Spacebar**.
3. A background thread instantly crops the precise `<x,y>` dimensions of the bounding box.
4. The thread POSTs the raw image buffer as `multipart/form-data` to `http://127.0.0.1:8000/api/registry/identify`.
5. The `visual_cortex.py` overlay shifts to "Consulting The Brain...".
6. The `registry_intake.py` endpoint processes the image, matches it through pgvector, and returns a JSON payload with the identical component string.
7. `visual_cortex` intercepts the DB result, dynamically text-wraps the massive paragraph string, and paints it neatly in Cyan above the actual PCB bounding box.

## 4. Known Environment Quirks
- **XInput Glitching:** `XInput-Python` requires the Xbox Controller to be fully awake (and ideally wired via USB) prior to script initialization. If it drops connection, it safely fails via `if controller_connected and XInput:` instead of crashing the loop.
- **Port Refusals [WinError 10061]:** The Cortex requires Uvicorn to be fully online (`Application startup complete`). If a Snap is fired while Uvicorn is dead or restarting, the background thread intercepts the `requests.post` exception and displays a safe `"Brain Offline"` visual shield rather than hard-crashing the `cv2` video feed. 
- **DB Quirks:** The ingestion endpoint has been explicitly targeted to pull from the `parts_catalogue` schema array rather than default stubbed arrays like `registry_components`.
