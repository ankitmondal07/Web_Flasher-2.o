#!/usr/bin/env python3
"""
ESP Web Flasher - Local Server & Auto-Packager Script
------------------------------------------------------
This script parses an Arduino IDE / ESPTool flash command string,
AUTOMATICALLY detects and reads the compiled `.bin` files directly from
your local hard drive paths (e.g. AppData/Local/Temp/arduino_build_...),
copies them into `./firmware/`, updates `manifest.json`, and generates `web_flasher_portal.zip`.

Usage:
  1. Interactive CLI Mode:
     python package_firmware.py

  2. Command Line Argument Mode:
     python package_firmware.py "<esptool_command_string>"

  3. Local Web Server & API Mode:
     python package_firmware.py --server
"""

import os
import sys
import re
import shutil
import json
import zipfile
from http.server import HTTPServer, SimpleHTTPRequestHandler
import urllib.parse

DEFAULT_CMD = (
    r'C:\Users\Ankit Mondal\AppData\Local\Arduino15\packages\esp32\tools\esptool_py\3.3.0/esptool.exe '
    r'--chip esp32 --port COM14 --baud 921600 --before default_reset --after hard_reset write_flash -z '
    r'--flash_mode dio --flash_freq 80m --flash_size 4MB '
    r'0x1000 C:\Users\ANKITM~1\AppData\Local\Temp\arduino_build_411707/web_flash.ino.bootloader.bin '
    r'0x8000 C:\Users\ANKITM~1\AppData\Local\Temp\arduino_build_411707/web_flash.ino.partitions.bin '
    r'0xe000 C:\Users\Ankit Mondal\AppData\Local\Arduino15\packages\esp32\hardware\esp32\2.0.3/tools/partitions/boot_app0.bin '
    r'0x10000 C:\Users\ANKITM~1\AppData\Local\Temp\arduino_build_411707/web_flash.ino.bin'
)

def parse_command(cmd_str):
    print("\n Parsing ESPTool Command...")
    
    # 1. Detect Chip
    chip_match = re.search(r'--chip\s+([a-zA-Z0-9_-]+)', cmd_str, re.IGNORECASE)
    chip_name = "ESP32"
    if chip_match:
        raw_chip = chip_match.group(1).lower()
        if "esp32s2" in raw_chip: chip_name = "ESP32-S2"
        elif "esp32s3" in raw_chip: chip_name = "ESP32-S3"
        elif "esp32c3" in raw_chip: chip_name = "ESP32-C3"
        elif "esp32c6" in raw_chip: chip_name = "ESP32-C6"
        elif "esp8266" in raw_chip: chip_name = "ESP8266"
        else: chip_name = "ESP32"
        
    print(f" Detected Chip: {chip_name}")
    
    # 2. Extract write_flash section
    write_flash_idx = cmd_str.find("write_flash")
    if write_flash_idx == -1:
        print(" Error: 'write_flash' keyword not found in command!")
        return chip_name, []
        
    flash_args = cmd_str[write_flash_idx + len("write_flash"):]
    
    # Match all (offsetHex, filePath) pairs supporting paths with spaces
    pattern = r'(0x[0-9a-fA-F]+)\s+(.*?\.bin)'
    matches = re.findall(pattern, flash_args, re.IGNORECASE)
    
    parts = []
    for offset_hex, raw_path in matches:
        offset_dec = int(offset_hex, 16)
        cleaned_path = raw_path.strip("\"' ")
        basename = os.path.basename(cleaned_path.replace("\\", "/"))
        
        parts.append({
            "offset_hex": offset_hex,
            "offset_dec": offset_dec,
            "original_path": cleaned_path,
            "basename": basename
        })
        
    return chip_name, parts

def package_firmware(cmd_str):
    project_dir = os.path.dirname(os.path.abspath(__file__))
    firmware_dir = os.path.join(project_dir, "firmware")
    # Clean out old firmware files before copying new ones
    if os.path.exists(firmware_dir):
        shutil.rmtree(firmware_dir)
    os.makedirs(firmware_dir, exist_ok=True)
    
    chip_name, parts = parse_command(cmd_str)
    if not parts:
        print(" [ERROR] No binary file locations found in the command string.")
        return False, "No binary files found"
    
    manifest_parts = []
    copied_files = []
    missing_files = []
    
    print("\n Auto-detecting & Copying Local Compiled Binary Files:")
    for part in parts:
        src_path = part["original_path"]
        basename = part["basename"]
        dest_path = os.path.join(firmware_dir, basename)
        
        # Expand environment variables and user home directory
        expanded_src = os.path.expanduser(os.path.expandvars(src_path))
        
        if os.path.exists(expanded_src):
            shutil.copy2(expanded_src, dest_path)
            copied_files.append(basename)
            print(f"  [COPIED] [{part['offset_hex']}]: {basename}\n           from '{expanded_src}'")
        elif os.path.exists(dest_path):
            copied_files.append(basename)
            print(f"  [EXISTING] [{part['offset_hex']}]: Found {basename} in firmware/")
        else:
            missing_files.append(expanded_src)
            print(f"  [WARNING] File not found on disk at '{expanded_src}' or 'firmware/{basename}'.")
            
        manifest_parts.append({
            "path": f"firmware/{basename}",
            "offset": part["offset_dec"]
        })
        
    # Write manifest.json
    manifest_data = {
        "name": "ESP32 Web Flasher",
        "version": "1.0.0",
        "new_install_prompt_erase": True,
        "builds": [
            {
                "chipFamily": chip_name,
                "parts": manifest_parts
            }
        ]
    }
    
    manifest_file = os.path.join(project_dir, "manifest.json")
    with open(manifest_file, "w", encoding="utf-8") as f:
        json.dump(manifest_data, f, indent=2)
    print(f"\n Updated 'manifest.json' for {chip_name} with {len(manifest_parts)} partitions.")
    
    # Create Web Flasher Release ZIP
    zip_path = os.path.join(project_dir, "web_flasher_portal.zip")
    files_to_zip = ["manifest.json"]
    
    # Generate dynamic README with flash offset table
    readme_lines = [
        f"# ESP Web Flasher - {chip_name} Firmware Package",
        "",
        "This package was auto-generated by the **ESP Web Flasher Portal**.",
        "",
        "## Firmware Partition Table",
        "",
        "| Flash Offset | Filename |",
        "|:------------:|:---------|",
    ]
    for part in parts:
        readme_lines.append(f"| `{part['offset_hex']}` | `{part['basename']}` |")
    readme_lines += [
        "",
        "",
        f"**Target Chip:** {chip_name}",
        "",
        "## Original Flash Command",
        "```bash",
        f"{cmd_str}",
        "```",
        "",
        "## How to Use",
        "",
        "1. Host these files on **GitHub Pages** (or any HTTPS server).",
        "2. Open the page in **Google Chrome** or **Microsoft Edge**.",
        "3. Click **Connect & Flash Device** and select your ESP board.",
        "",
        "---",
        "*Powered by [ESP Web Tools](https://esphome.github.io/esp-web-tools/) & Web Serial API*",
        "",
    ]
    readme_content = "\n".join(readme_lines)
    
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
        for f in files_to_zip:
            f_path = os.path.join(project_dir, f)
            if os.path.exists(f_path):
                zipf.write(f_path, f)
        
        # Add the dynamic README
        zipf.writestr("README.md", readme_content)
        
        # Add the original flash command file INSIDE firmware/ so End-User Flasher finds it
        zipf.writestr("firmware/flash_command.txt", cmd_str)
                
        for root, _, files in os.walk(firmware_dir):
            for file in files:
                file_abs = os.path.join(root, file)
                rel_path = os.path.relpath(file_abs, project_dir).replace("\\", "/")
                zipf.write(file_abs, rel_path)
                
    print(f"\n SUCCESS! Created complete web portal release ZIP archive:\n {zip_path}\n")
    return True, zip_path

class WebFlasherHTTPHandler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/api/auto-package':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length).decode('utf-8')
            try:
                data = json.loads(post_data)
                cmd_str = data.get('command', '')
                success, zip_path = package_firmware(cmd_str)
                
                self.send_response(200 if success else 400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                
                resp = {
                    "success": success,
                    "message": "Package generated successfully" if success else zip_path,
                    "zip_url": "web_flasher_portal.zip"
                }
                self.wfile.write(json.dumps(resp).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "message": str(e)}).encode('utf-8'))
        else:
            self.send_error(404, "Endpoint not found")

def start_server(port=8080):
    project_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(project_dir)
    server_address = ('', port)
    httpd = HTTPServer(server_address, WebFlasherHTTPHandler)
    print(f"\n [SERVER] ESP Web Flasher Server running at http://localhost:{port}")
    print(" Press Ctrl+C to stop the server.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")

if __name__ == "__main__":
    if len(sys.argv) > 1:
        if sys.argv[1] == "--server":
            port = int(sys.argv[2]) if len(sys.argv) > 2 else 8080
            start_server(port)
        else:
            cmd = sys.argv[1]
            package_firmware(cmd)
    else:
        print("=" * 65)
        print("      ESP Web Flasher - Auto-Detect Local Binary Packager")
        print("=" * 65)
        user_cmd = input("\nPaste your Arduino IDE / ESPTool flash command string:\n> ").strip()
        if not user_cmd:
            print("No command provided. Using default example command...")
            user_cmd = DEFAULT_CMD
        package_firmware(user_cmd)
