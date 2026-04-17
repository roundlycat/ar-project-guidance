# Android Studio Setup for AR Development

Complete guide for Galaxy A9+ AR development.

## Prerequisites

- Windows 10/11 (64-bit), 16GB+ RAM
- Samsung Galaxy A9+
- USB cable
- Internet connection

## Part 1: Check ARCore Compatibility

**CRITICAL FIRST STEP:**
1. Open Play Store on Galaxy A9+
2. Search "Google Play Services for AR"
3. If shows "Install/Update" → ✅ Continue
4. If shows "Not compatible" → ❌ Need Galaxy A51/A52/A53

Check official list: https://developers.google.com/ar/devices

## Part 2: Install Android Studio

1. Download from https://developer.android.com/studio
2. Run installer, choose "Standard" setup
3. Install includes: Android SDK, SDK Tools, Emulator
4. Time: 30-45 minutes (with downloads)

**SDK Manager Setup:**
- Tools → SDK Manager
- Install: API 24, 31, 34
- Install: Android SDK Build-Tools
- Click Apply

## Part 3: Device Setup

**Enable Developer Mode:**
1. Settings → About phone
2. Tap "Build number" 7 times
3. Enter PIN/password
4. Back → Developer options appears

**Enable USB Debugging:**
1. Developer options → USB debugging (ON)
2. Connect device via USB
3. Allow USB debugging popup → Allow

**Verify Connection:**
```bash
# In PowerShell
cd C:\Users\seank\AppData\Local\Android\Sdk\platform-tools
.\adb devices

# Should show your device
```

## Part 4: Open Project

1. Android Studio → File → Open
2. Select: C:\Users\seank\source\repos\ar-project-guidance
3. Wait for Gradle sync (first time: 5-10 min)
4. Fix any errors (usually auto-fixed)

## Part 5: Run on Device

1. Top toolbar → Select your Galaxy A9+
2. Click green play button (or Shift+F10)
3. Grant camera permissions on device
4. App launches

## Basic AR Test

Point camera at flat surface (table, floor). You should see:
- White dots appearing (plane detection)
- Surfaces highlighted
- No crashes or errors

## Troubleshooting

**Device Not Found:**
- Check USB cable
- Re-enable USB debugging
- Try: `adb kill-server` then `adb start-server`

**ARCore Not Supported:**
- Install "Google Play Services for AR" from Play Store
- If not available → Galaxy A9+ may not be certified
- Alternative: Galaxy A51/A52/A53

**Build Errors:**
- File → Sync Project with Gradle Files
- Build → Clean Project
- Build → Rebuild Project

**Camera Permission Denied:**
- Settings → Apps → AR Project Guide → Permissions → Camera → Allow

## Next Steps

Once basic app runs:
1. Study ARCore fundamentals (see docs online)
2. Add 3D object placement
3. Implement gesture controls
4. Build project guidance system

## Resources

- ARCore Docs: https://developers.google.com/ar/develop
- Codelabs: https://codelabs.developers.google.com/arcore-intro
- Android Docs: https://developer.android.com/guide

