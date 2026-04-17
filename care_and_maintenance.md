# Care & Maintenance of the AR Guidance Ecology

A multi-node, distributed hardware ecosystem requires disciplined care to prevent entropy, library mismatches, and hardware degradation over time. Here are the core operational principles and "known quirks" for maintaining the AR Guidance System.

## 1. Hardware Lifecycle & Thermal Management

### The Hailo NPU (Main Pi)
*   **Thermal Throttling:** The Hailo-8L operates at up to 26 TOPS and generates significant heat during continuous bounding-box inference (the Fast Track). Ensure the Raspberry Pi's active cooling fan is unrestricted.
*   **Sustained Operation:** Do not leave the `hailo_tracker_bridge.py` running in a dormant loop overnight. Even if there are no WebSocket clients connected to `server.py`, the NPU will continuously run inference on the camera feed if not explicitly paused or shut down, reducing component lifespan.

### The Xbox Controller (Windows Workstation)
*   **XInput Glitching:** `XInput-Python` heavily favors active, wired Xbox controller connections. If the controller enters sleep mode during a long session, the system may throw a silent disconnect error and drop the "Grammar of Uncertainty" haptic feedback. Avoid wireless bluetooth for dev-sessions if possible.

## 2. Software Environments & Dependencies

The most frequent source of downtime in "Sensor Ecology" involves Python dependency drift across the different OS architectures (Windows x86 vs. Debian ARM64).

*   **Virtual Environments vs Docker:** Currently, scripts are run out of local virtual environments (`.venv`). This creates fragility when pushing `requirements.txt` from Windows to the Raspberry Pi.
    *   *Maintenance Task:* Over the next development cycles, both `registry_intake.py` (Inferno DB) and `server.py` (Main Pi) must be migrated to Docker containers. This will guarantee `psycopg2-binary`, `uvicorn`, and `fastapi` compile correctly on the target architectures.
*   **Hailo Software Suite:** Pre-compiling `.hef` files (Hailo Executable Format) for the NPU requires the Hailo Dataflow Compiler. Only update the Hailo RT (Runtime) on the Main Pi when you are also prepared to recompile your Yolo models to match the new runtime ABI.

## 3. Network Resiliency & "Brain Offline" Handling

A system running over local Wi-Fi will experience dropped packets and port refusals. The system is designed to degrade *gracefully*, rather than crash.

*   **Handling Port 10061 (Connection Refused):** If the Windows workstation attempts a "Spacebar Snap", but the Inferno Pi's Uvicorn server is offline, the background thread in `visual_cortex.py` is programmed to swallow the `requests.exceptions.ConnectionError`. It will display a simple `"Brain Offline"` visual indicator rather than freezing the main camera feed thread.
*   **WebSocket Reconnection Logic:** AR guidance demands a smooth feed from the Main Pi. The Windows client must aggressively attempt to reconnect to `ws://[MAIN_PI_IP]:9500` if the connection drops.
*   **Static IP Leases:** To prevent configuration drift, ensure your local router has permanent DHCP reservations for:
    *   **Main Pi:** Bound in `visual_cortex.py`
    *   **Inferno Pi:** Bound in `.env` `$DATABASE_URL` strings.

## 4. Database Grooming (Inferno Pi)
The `sensor_ecology` PostgreSQL cluster relies heavily on the `pgvector` extension.
*   Over time, embedding representations might drift or become noisy if images with poor lighting are continuously added to the `parts_catalogue`.
*   *Maintenance Routine:* Periodically query the database for anomalies or duplicated embeddings (using high cosine-similarity overlap without identical matching parts) and prune the index.
