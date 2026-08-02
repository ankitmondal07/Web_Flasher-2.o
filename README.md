# ESP Web Flasher Portal 🚀

A modern, browser-based ESP32 firmware flashing portal powered by [ESP Web Tools](https://esphome.github.io/esp-web-tools/) and the **Web Serial API**.

Allows users to flash pre-packaged firmware or **paste raw Arduino IDE / ESPTool compiler commands** with uploaded `.bin` files directly to ESP32 microcontrollers from **Google Chrome**, **Microsoft Edge**, **Opera**, or **Brave** without desktop software.

---

## ✨ Features

- **⚡ Direct Browser Flashing**: One-click flashing using WebSerial technology.
- **🔍 Smart Esptool Command Parser**: Paste any Arduino IDE / PlatformIO compiler flash command (`esptool.exe ... write_flash ...`) to automatically detect:
  - Chip architecture (`ESP32`, `ESP32-S2`, `ESP32-S3`, `ESP32-C3`, `ESP32-C6`, `ESP8266`).
  - Partition offsets (`0x1000`, `0x8000`, `0xe000`, `0x10000`).
  - Binary filenames.
- **📁 Drag & Drop `.bin` File Uploader**: Upload your compiled binaries; the portal automatically matches them to detected offsets.
- **📄 In-Memory Manifest Generator & Export**: Generates manifest Blobs on the fly and provides a one-click download for `manifest.json`.
- **🖥️ Built-in Web Serial Terminal**: Monitor 115200 baud serial output directly in the browser post-flash.
- **📊 Real-time Log Controls**: Pause, auto-scroll, clear log, and export serial output logs to text files.
- **🎨 Modern Dark Glassmorphism UI**: High-end cyberpunk design system with glowing status lights & smooth micro-animations.

---

## 📁 Repository Structure

```
├── firmware/
│   ├── boot_app0.bin
│   ├── web_flash.ino.bin
│   ├── web_flash.ino.bootloader.bin
│   └── web_flash.ino.partitions.bin
├── index.html              # Main web portal landing page with tabbed modes
├── styles.css              # Cyberpunk dark mode glassmorphism UI stylesheet
├── app.js                  # Esptool command parser, WebSerial & Serial Terminal JS logic
├── manifest.json           # ESP Web Tools manifest configuration
├── .nojekyll               # Prevents GitHub Pages Jekyll build filter
├── web_flash.ino           # Arduino source sketch (for reference)
└── README.md               # Project documentation
```

---

## 🌐 Deploying to GitHub Pages

Deploying this portal to GitHub Pages takes less than 2 minutes:

1. **Push Code to GitHub**:
   ```bash
   git add .
   git commit -m "Add ESP Web Flasher Portal with Command Parser"
   git push origin main
   ```

2. **Enable GitHub Pages**:
   - Go to your repository on GitHub.
   - Navigate to **Settings** > **Pages**.
   - Under **Build and deployment**:
     - **Source**: Select `Deploy from a branch`.
     - **Branch**: Select `main` (or `master`) and folder `/ (root)`.
   - Click **Save**.

3. **Access Your Live Flasher**:
   - GitHub Pages will provide a URL like: `https://<your-username>.github.io/<repository-name>/`
   - Open this link in **Google Chrome** or **Microsoft Edge** over HTTPS!

---

## 💻 Local Testing & Preview

To test the WebSerial flasher locally:

> **Note**: WebSerial requires a secure context (`https://` or `localhost`).

```bash
python -m http.server 8080
```
Then open `http://localhost:8080` in Google Chrome or Edge.

---

## ⚙️ How the Command Parser Works

In the **Paste Flash Command & Upload .bin** tab:
1. Paste your Arduino IDE upload command line (e.g. `... esptool.exe --chip esp32 ... write_flash 0x1000 bootloader.bin 0x8000 partitions.bin ...`).
2. Drag & Drop your `.bin` files.
3. The portal automatically maps each file to its offset (`0x1000`, `0x8000`, `0xe000`, `0x10000`).
4. Click **Connect & Flash Custom Binaries** to flash directly from the browser!
5. Optionally click **Download Generated manifest.json** to save the manifest for permanent GitHub Pages deployment.

---

## 📜 License

MIT License - feel free to customize for your own ESP32 / ESP8266 projects!
