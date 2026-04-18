# Simulating Blind Whisperer (browser, mobile shell, Meta glasses)

This guide covers three levels of simulation: **web UI only**, the **Capacitor** Android/iOS shell without glasses hardware, and **Meta’s Mock Device Kit** once you integrate the Wearables Device Access Toolkit natively.

## 1. Web app (fastest, no Meta SDK)

Use this to exercise the full flow—camera, speech (where supported), and `POST /api/scene`—on your computer.

1. Start the backend (see the main [README](../README.md#backend-setup)).
2. From `frontend`, run `npm install` and `npm run dev`.
3. Open the URL Vite prints (default `http://127.0.0.1:5173`).

**HTTPS:** For microphone / speech APIs, browsers often require a secure context. `http://localhost` usually qualifies; for other hostnames use HTTPS or tunneling (for example `mkcert` + local HTTPS, or a dev proxy).

This does **not** simulate Meta glasses; it matches “phone browser” behavior closest to the Capacitor WebView.

## 2. Capacitor app (Android Emulator or iOS Simulator)

The wrapper under `frontend/android` and `frontend/ios` loads the same web assets in a **WebView** and uses the **emulator’s or simulator’s** camera/mic when you grant permissions—not Ray-Ban hardware.

### Prerequisites

- **Android:** Android Studio, an SDK with a system image, and a virtual device (AVD). For camera tests, configure the AVD to use a **webcam** or emulated camera in the device manager.
- **iOS (macOS only):** Xcode, CocoaPods (`cd frontend/ios/App && pod install` if needed), and a Simulator. The Simulator can use the Mac’s camera for some flows; behavior differs from a real device.

### Steps

1. Build and sync after setting the API URL (use your machine’s **LAN IP** if the backend runs on the host and the emulator/simulator uses bridged networking):

   ```bash
   cd frontend
   # Example: backend on your PC at 192.168.1.10:8000
   echo 'VITE_API_BASE_URL=http://192.168.1.10:8000' > .env.local
   npm run build
   npx cap sync
   ```

2. **Android:** `npm run cap:open:android`, select your project, run on an AVD.  
   **iOS:** `npm run cap:open:ios`, pick a Simulator, build and run.

3. **Networking:** Android Emulator often reaches the host as `10.0.2.2` (not `127.0.0.1`). You may set `VITE_API_BASE_URL=http://10.0.2.2:8000` for emulator-only runs, or use your LAN IP consistently for both emulator and physical device testing.

**Limitations:** This validates the packaged UI and native permissions, not Bluetooth pairing or glasses-specific streams.

## 3. Meta glasses: Mock Device Kit (no physical glasses)

Meta provides **Mock Device Kit** as part of the Wearables Device Access Toolkit so you can develop and test **without** real glasses. It simulates pairing, power state, unfold/don, and can feed **mock video or still images** for streaming and capture tests.

Official entry points:

- [Mock Device Kit basics](https://wearables.developer.meta.com/docs/mock-device-kit) — overview and how it appears in Meta’s **CameraAccess** sample (Debug menu, pair mock device, PowerOn / Unfold / Don, assign mock media).
- [How to test with Mock Device Kit on Android](https://wearables.developer.meta.com/docs/testing-mdk-android) — instrumentation tests with `MockDeviceKit`, pairing a mock Ray-Ban Meta device, and setting camera feed / capture image from assets.

**Relationship to this repository:** The Capacitor wrapper here does **not** embed the Wearables SDK yet. To use Mock Device Kit end-to-end you typically:

1. Follow Meta’s [Setup](https://wearables.developer.meta.com/docs/getting-started-toolkit) and add the toolkit to your **native** Android or iOS project (or start from their samples).
2. Use the Debug / Mock Device Kit UI or the programmatic APIs from the docs above.
3. Keep sending frames to your existing backend via `POST /api/scene` from the native layer once you obtain images or video from the toolkit.

## Quick comparison

| Goal | What to use |
|------|----------------|
| Iterate on UI and API quickly | Web: `npm run dev` |
| Test installable app + WebView + permissions | Android Emulator / iOS Simulator + `cap sync` |
| Test Meta glasses APIs without hardware | Meta Mock Device Kit + Device Access Toolkit ([docs](https://wearables.developer.meta.com/docs/mock-device-kit)) |
