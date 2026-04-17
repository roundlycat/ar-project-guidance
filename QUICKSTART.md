# Quick Start - AR Project Guidance

## Step 1: Check Galaxy A9+ Compatibility

**CRITICAL:** Check if your device supports ARCore:
1. Open Play Store on Galaxy A9+
2. Search "Google Play Services for AR"
3. ✅ Shows "Install/Update" → Continue
4. ❌ Shows "Not compatible" → Need different device (Galaxy A51, A52, A53)

## Step 2: Create Repository Directory

```powershell
# Run this in PowerShell
mkdir C:\Users\seank\source\repos\ar-project-guidance
# Then copy all files from this folder into that directory
```

## Step 3: Install Android Studio

1. Download: https://developer.android.com/studio
2. Install with default settings (includes SDK)
3. Launch and complete setup wizard
4. Time: ~30-45 minutes

## Step 4: Enable Developer Mode

On Galaxy A9+:
1. Settings → About phone
2. Tap "Build number" 7 times
3. Back → Developer options → Enable "USB debugging"

## Step 5: Open in Android Studio

1. Android Studio → File → Open
2. Select: C:\Users\seank\source\repos\ar-project-guidance
3. Wait for Gradle sync
4. Connect Galaxy A9+ via USB
5. Run → Run 'app'

## Need Help?

See docs/SETUP.md for detailed instructions with troubleshooting.

## Files Included

- README.md - Project overview
- QUICKSTART.md - This file  
- build.gradle.kts - Project configuration
- app/build.gradle.kts - ARCore dependencies
- docs/SETUP.md - Complete guide

---

## Part B: Local Application Deployment (Standalone Server)

Instead of relying on your massive `hedgehog-library` database, I built a lightweight standalone Python server located right here inside `ar-project-guidance` (`server.py`). It serves your AR interface and securely proxies the Gemini Vision AI all in one script without any PostgreSQL dependencies to crash on!

### 1. Transfer the Files
Because this project is local, you must manually copy it to the Pi (e.g. via an SCP command from PowerShell):
```bash
scp -r C:\Users\seank\source\repos\ar-project-guidance pi@192.168.0.24:~/
```

### 2. Install Dependencies & Start the Server (On Inferno)
SSH into your Raspberry Pi and start the lightweight AR proxy server:

```bash
cd ~/ar-project-guidance

# Install the minimal requirements (FastAPI, httpx, uvicorn)
pip install -r requirements.txt

# Start the Standalone Proxy Server on port 9500
uvicorn server:app --host 0.0.0.0 --port 9500
```

### 3. Connect from Android/Tablet
To view the AR overlay interface on your Galaxy tablet or local browser:
1. Open Chrome/Web browser.
2. Visit **`http://<INFERNO_PI_IP>:9500/ar-app/`**
3. Tap "IP Config" (Wifi icon) to make sure it matches Inferno's IP.

*Note: Since the lightweight backend is natively hosting the frontend locally, all CORS and HTTPS restriction errors are completely bypassed!*

## Next: Read docs/SETUP.md (For Native Android App builds)
