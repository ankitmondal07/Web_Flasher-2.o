/**
 * ESP Web Flasher Portal - Main Application Logic
 * Integrates WebSerial API, Esptool Command Parser, Serial Monitor,
 * and Auto-Detect Local Binary Release ZIP Packager.
 */

// Global State for Custom / Creator Modes
let parsedEntries = [];
let uploadedFiles = [];
let detectedChip = 'ESP32';
let currentManifestObject = null;
let currentManifestBlobUrl = null;

// Creator Mode State
let creatorEntries = [];
let creatorFiles = [];
let creatorChip = 'ESP32';

// End-User ZIP State
let endUserManifestBlobUrl = null;

/**
 * End-User ZIP Uploader & Parser Initializer
 */
function initEndUserZipLoader() {
  const dropzone = document.getElementById('end-user-dropzone');
  const fileInput = document.getElementById('zip-input');
  
  if (!dropzone || !fileInput) return;



  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.zip'));
    if (files.length > 0) {
      handleEndUserZip(files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files).filter(f => f.name.toLowerCase().endsWith('.zip'));
    if (files.length > 0) {
      handleEndUserZip(files[0]);
    }
  });
}

/**
 * Parses the uploaded ZIP following this structure:
 *   zip/
 *     firmware/
 *       flash_command.txt   ← contains esptool offsets + filenames
 *       bootloader.bin
 *       partitions.bin
 *       boot_app0.bin
 *       firmware.bin
 *     manifest.json  (optional, used as fallback)
 *     README.md      (optional)
 */
async function handleEndUserZip(zipFile) {
  if (typeof JSZip === 'undefined') {
    alert('JSZip library is still loading. Please try again.');
    return;
  }

  const statusMsg    = document.getElementById('end-user-flasher-msg');
  const metaContainer = document.getElementById('end-user-meta');
  const flasherBox   = document.getElementById('end-user-flasher-box');
  const badge        = document.getElementById('end-user-chip-badge');

  statusMsg.innerHTML = '<span style="color: var(--accent-cyan);"><i class="fas fa-spinner fa-spin"></i> Unpacking ZIP file...</span>';
  metaContainer.style.display = 'none';
  flasherBox.style.display = 'none';
  badge.textContent = 'Parsing...';

  try {
    // ── STEP 1: Unzip ────────────────────────────────────────────────────────
    const zip = new JSZip();
    const loadedZip = await zip.loadAsync(zipFile);

    statusMsg.innerHTML = '<span style="color: var(--accent-cyan);"><i class="fas fa-spinner fa-spin"></i> Reading flash command from firmware folder...</span>';

    let chipFamily  = 'ESP32';
    let parts       = [];           // [{path, offset}]
    let firmwareName = zipFile.name.replace(/\.zip$/i, '');
    let version     = '1.0.0';
    let erasePrompt = true;
    let commandText = '';

    // ── STEP 2: Find the command file inside firmware/ ────────────────────────
    // Collect every file that lives inside a "firmware" sub-folder
    const firmwareEntries = Object.values(loadedZip.files).filter(f => {
      if (f.dir) return false;
      const normalized = f.name.replace(/\\/g, '/');
      return normalized.startsWith('firmware/');
    });

    // Look for a text/command file inside firmware/ (prefer flash_command.txt)
    let commandFile = null;

    // Priority 1: exact name firmware/flash_command.txt
    commandFile = loadedZip.file('firmware/flash_command.txt');

    // Priority 2: any .txt file inside firmware/
    if (!commandFile) {
      commandFile = firmwareEntries.find(f => {
        const name = f.name.replace(/\\/g, '/').split('/').pop().toLowerCase();
        return name.endsWith('.txt');
      }) || null;
    }

    // Priority 3: any non-binary file inside firmware/ that contains write_flash
    if (!commandFile) {
      for (const entry of firmwareEntries) {
        const name = entry.name.replace(/\\/g, '/').split('/').pop().toLowerCase();
        if (name.endsWith('.bin')) continue;
        try {
          const txt = await entry.async('text');
          if (txt.includes('write_flash') || txt.match(/0x[0-9a-fA-F]+\s+\S+\.bin/)) {
            commandFile = entry;
            break;
          }
        } catch (_) { /* skip unreadable */ }
      }
    }

    if (commandFile) {
      commandText = await commandFile.async('text');
      console.log('[EndUserFlasher] Found command file:', commandFile.name);
      console.log('[EndUserFlasher] Command text:', commandText.substring(0, 300));

      // ── STEP 3: Parse chip from command ─────────────────────────────────────
      const chipMatch = commandText.match(/--chip\s+([a-zA-Z0-9_-]+)/i);
      if (chipMatch) {
        const raw = chipMatch[1].toLowerCase();
        if      (raw.includes('esp32s2')) chipFamily = 'ESP32-S2';
        else if (raw.includes('esp32s3')) chipFamily = 'ESP32-S3';
        else if (raw.includes('esp32c3')) chipFamily = 'ESP32-C3';
        else if (raw.includes('esp32c6')) chipFamily = 'ESP32-C6';
        else if (raw.includes('esp8266')) chipFamily = 'ESP8266';
        else                              chipFamily = 'ESP32';
      }

      // ── STEP 4: Parse offsets + filenames from the command ──────────────────
      const wfIdx = commandText.indexOf('write_flash');
      if (wfIdx !== -1) {
        const afterWF = commandText.substring(wfIdx + 'write_flash'.length);
        // Match pairs like:  0x1000  bootloader.bin
        //                    0x1000  "bootloader.bin"
        //                    0x1000  C:\...\bootloader.bin
        const pattern = /(0x[0-9a-fA-F]+)\s+([^\s]+\.bin)/gi;
        let m;
        while ((m = pattern.exec(afterWF)) !== null) {
          const offsetHex = m[1];
          // Strip surrounding quotes and take only the basename
          const rawFilePath = m[2].trim().replace(/^["']|["']$/g, '');
          const basename = rawFilePath.replace(/\\/g, '/').split('/').pop();
          parts.push({
            basename: basename,
            offset:   parseInt(offsetHex, 16),
            offsetHex: offsetHex
          });
        }
      }
    }

    // ── STEP 5: Fallback to manifest.json if no command file / no parts ───────
    if (parts.length === 0) {
      const manifestFile = loadedZip.file('manifest.json');
      if (manifestFile) {
        const mObj = JSON.parse(await manifestFile.async('text'));
        if (mObj.builds && mObj.builds.length > 0) {
          const build = mObj.builds[0];
          chipFamily   = build.chipFamily || 'ESP32';
          firmwareName = mObj.name || firmwareName;
          version      = mObj.version || version;
          erasePrompt  = mObj.new_install_prompt_erase !== false;
          parts = build.parts.map(p => ({
            basename:  p.path.replace(/\\/g, '/').split('/').pop(),
            offset:    p.offset,
            offsetHex: '0x' + p.offset.toString(16)
          }));
        }
      }
    }

    if (parts.length === 0) {
      throw new Error(
        'Could not find any flash offsets.\n' +
        'Make sure your ZIP contains a firmware/ folder with flash_command.txt inside it.'
      );
    }

    statusMsg.innerHTML = '<span style="color: var(--accent-cyan);"><i class="fas fa-spinner fa-spin"></i> Loading firmware binaries...</span>';

    // ── STEP 6: Locate each .bin inside firmware/ and create Blob URLs ────────
    // Build a lookup map: lowercase_basename → JSZip file entry
    const firmwareBinMap = {};
    for (const entry of firmwareEntries) {
      if (entry.dir) continue;
      const bname = entry.name.replace(/\\/g, '/').split('/').pop().toLowerCase();
      if (bname.endsWith('.bin')) {
        firmwareBinMap[bname] = entry;
      }
    }

    const partsWithBlobUrls = [];
    for (const part of parts) {
      const key = part.basename.toLowerCase();
      const entry = firmwareBinMap[key];
      if (!entry) {
        throw new Error(
          `Binary file "${part.basename}" not found inside the firmware/ folder of the ZIP.\n` +
          `Available files: ${Object.keys(firmwareBinMap).join(', ') || '(none)'}`
        );
      }
      const blob    = await entry.async('blob');
      const blobUrl = URL.createObjectURL(blob);
      partsWithBlobUrls.push({
        path:             blobUrl,
        offset:           part.offset,
        offsetHex:        part.offsetHex,
        originalFilename: part.basename
      });
    }

    // ── STEP 7: Build in-browser manifest and wire up esp-web-install-button ──
    const newManifest = {
      name:                    firmwareName,
      version:                 version,
      new_install_prompt_erase: erasePrompt,
      builds: [{
        chipFamily: chipFamily,
        parts: partsWithBlobUrls.map(p => ({ path: p.path, offset: p.offset }))
      }]
    };

    if (endUserManifestBlobUrl) URL.revokeObjectURL(endUserManifestBlobUrl);
    const manifestBlob = new Blob([JSON.stringify(newManifest, null, 2)], { type: 'application/json' });
    endUserManifestBlobUrl = URL.createObjectURL(manifestBlob);

    const installBtn = document.getElementById('esp-button-default');
    installBtn.setAttribute('manifest', endUserManifestBlobUrl);

    // ── STEP 8: Update the UI ─────────────────────────────────────────────────
    document.getElementById('meta-zip-name').textContent    = firmwareName;
    document.getElementById('meta-zip-chip').textContent    = chipFamily;
    document.getElementById('meta-zip-version').textContent = version;
    badge.textContent = chipFamily;

    const tbody = document.getElementById('meta-zip-partitions-table-body');
    tbody.innerHTML = '';
    partsWithBlobUrls.forEach(part => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="color: var(--accent-cyan); font-weight: 600; font-family: var(--font-mono);">${escapeHtml(part.offsetHex)}</td>
        <td style="color: var(--text-muted); font-family: var(--font-mono);">${escapeHtml(part.originalFilename)}</td>
        <td><span class="badge-status success"><i class="fas fa-check"></i> Loaded from firmware/</span></td>
      `;
      tbody.appendChild(tr);
    });

    statusMsg.innerHTML = '<span style="color: var(--accent-emerald); font-weight: 600;"><i class="fas fa-check-circle"></i> Firmware loaded! Click <strong>Connect &amp; Flash Device</strong> to flash your board.</span>';
    metaContainer.style.display = 'block';
    flasherBox.style.display = 'block';

  } catch (err) {
    console.error('[EndUserFlasher] Error:', err);
    badge.textContent = 'Error';
    statusMsg.innerHTML = `<span style="color: var(--accent-rose); font-weight: 600;"><i class="fas fa-exclamation-triangle"></i> Failed: ${escapeHtml(err.message)}</span>`;
    metaContainer.style.display = 'none';
    flasherBox.style.display = 'none';
  }
}


document.addEventListener('DOMContentLoaded', () => {

  initBrowserCheck();
  initModeTabs();
  initEndUserZipLoader();
  initCommandParser();
  initDropzone();
  initCreatorMode();
  initSerialTerminal();
  initUI();
});

/**
 * Check if current browser supports Web Serial API
 */
function initBrowserCheck() {
  const statusEl = document.getElementById('browser-status');
  const alertDefault = document.getElementById('browser-alert-default');
  const hasWebSerial = 'serial' in navigator;

  if (hasWebSerial) {
    statusEl.className = 'browser-status supported';
    statusEl.innerHTML = `
      <span class="status-dot"></span>
      <span>WebSerial Ready (Chrome / Edge)</span>
    `;
    if (alertDefault) alertDefault.style.display = 'none';
  } else {
    statusEl.className = 'browser-status unsupported';
    statusEl.innerHTML = `
      <span class="status-dot"></span>
      <span>WebSerial Not Supported</span>
    `;
    if (alertDefault) {
      alertDefault.style.display = 'block';
      alertDefault.innerHTML = `
        <i class="fas fa-exclamation-triangle"></i>
        <strong>Browser Incompatible:</strong> WebSerial is required to flash ESP devices directly. 
        Please open this page in <strong>Google Chrome</strong>, <strong>Microsoft Edge</strong>, or <strong>Brave</strong>.
      `;
    }
  }
}

/**
 * Tab switcher between End-User Flasher, Quick Command Flasher, and Developer ZIP Generator
 */
function initModeTabs() {
  const tabDefault = document.getElementById('tab-default');
  const tabCustom = document.getElementById('tab-custom');
  const tabCreator = document.getElementById('tab-creator');
  
  const sectionDefault = document.getElementById('section-default-flasher');
  const sectionCustom = document.getElementById('section-custom-flasher');
  const sectionCreator = document.getElementById('section-creator-flasher');

  if (!tabDefault || !tabCustom || !tabCreator) return;

  function switchTab(activeTab, activeSection) {
    [tabDefault, tabCustom, tabCreator].forEach(t => t.classList.remove('active'));
    [sectionDefault, sectionCustom, sectionCreator].forEach(s => s.classList.remove('active'));
    activeTab.classList.add('active');
    activeSection.classList.add('active');
  }

  tabDefault.addEventListener('click', () => switchTab(tabDefault, sectionDefault));
  tabCustom.addEventListener('click', () => switchTab(tabCustom, sectionCustom));
  tabCreator.addEventListener('click', () => switchTab(tabCreator, sectionCreator));
}

/**
 * Command Parser Logic for Quick Command Flasher Mode
 */
function initCommandParser() {
  const btnParse = document.getElementById('btn-parse-cmd');
  const btnExample = document.getElementById('btn-example-cmd');
  const btnClear = document.getElementById('btn-clear-cmd');
  const cmdTextarea = document.getElementById('esptool-cmd');
  const btnExport = document.getElementById('btn-export-manifest');

  if (!btnParse || !cmdTextarea) return;

  btnParse.addEventListener('click', () => {
    parseEsptoolCommand(cmdTextarea.value);
  });

  cmdTextarea.addEventListener('input', () => {
    parseEsptoolCommand(cmdTextarea.value);
  });

  btnExample.addEventListener('click', () => {
    const exampleCmd = `C:\\Users\\Ankit Mondal\\AppData\\Local\\Arduino15\\packages\\esp32\\tools\\esptool_py\\3.3.0/esptool.exe --chip esp32 --port COM14 --baud 921600 --before default_reset --after hard_reset write_flash -z --flash_mode dio --flash_freq 80m --flash_size 4MB 0x1000 C:\\Users\\ANKITM~1\\AppData\\Local\\Temp\\arduino_build_411707/web_flash.ino.bootloader.bin 0x8000 C:\\Users\\ANKITM~1\\AppData\\Local\\Temp\\arduino_build_411707/web_flash.ino.partitions.bin 0xe000 C:\\Users\\Ankit Mondal\\AppData\\Local\\Arduino15\\packages\\esp32\\hardware\\esp32\\2.0.3/tools/partitions/boot_app0.bin 0x10000 C:\\Users\\ANKITM~1\\AppData\\Local\\Temp\\arduino_build_411707/web_flash.ino.bin`;
    cmdTextarea.value = exampleCmd;
    parseEsptoolCommand(exampleCmd);
  });

  btnClear.addEventListener('click', () => {
    cmdTextarea.value = '';
    parsedEntries = [];
    renderParsedTable();
  });

  btnExport.addEventListener('click', () => {
    if (!currentManifestObject) return;
    const exportManifest = JSON.parse(JSON.stringify(currentManifestObject));
    exportManifest.builds[0].parts.forEach((part, i) => {
      const entry = parsedEntries[i];
      part.path = `firmware/${entry.matchedFile ? entry.matchedFile.name : entry.commandFilename}`;
    });

    const blob = new Blob([JSON.stringify(exportManifest, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'manifest.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

/**
 * Parse chip name and write_flash offset/file pairs from command string
 */
function parseEsptoolCommand(rawCmd) {
  if (!rawCmd || !rawCmd.trim()) {
    parsedEntries = [];
    renderParsedTable();
    return;
  }

  // 1. Detect Chip
  const chipMatch = rawCmd.match(/--chip\s+([a-zA-Z0-9_-]+)/i);
  if (chipMatch && chipMatch[1]) {
    const rawChip = chipMatch[1].toLowerCase();
    if (rawChip.includes('esp32s2')) detectedChip = 'ESP32-S2';
    else if (rawChip.includes('esp32s3')) detectedChip = 'ESP32-S3';
    else if (rawChip.includes('esp32c3')) detectedChip = 'ESP32-C3';
    else if (rawChip.includes('esp32c6')) detectedChip = 'ESP32-C6';
    else if (rawChip.includes('esp8266')) detectedChip = 'ESP8266';
    else detectedChip = 'ESP32';
  } else {
    detectedChip = 'ESP32';
  }

  document.getElementById('detected-chip-badge').textContent = `Chip: ${detectedChip}`;

  // 2. Locate write_flash section
  const writeFlashIndex = rawCmd.indexOf('write_flash');
  if (writeFlashIndex === -1) {
    parsedEntries = [];
    renderParsedTable();
    return;
  }

  const flashArgsStr = rawCmd.substring(writeFlashIndex + 'write_flash'.length);

  const pattern = /(0x[0-9a-fA-F]+)\s+(.*?\.bin)/gi;
  parsedEntries = [];

  let match;
  while ((match = pattern.exec(flashArgsStr)) !== null) {
    const offsetHex = match[1];
    const offsetDec = parseInt(offsetHex, 16);
    const rawPath = match[2].trim().replace(/^["']|["']$/g, '');
    const basename = rawPath.split(/[/\\]/).pop();

    parsedEntries.push({
      offsetHex: offsetHex,
      offsetDec: offsetDec,
      commandFilename: basename,
      rawPath: rawPath,
      matchedFile: null
    });
  }

  matchUploadedFilesWithEntries();
  renderParsedTable();
}

/**
 * Drag & Drop and File Input setup for Quick Flasher Mode
 */
function initDropzone() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');

  if (!dropzone || !fileInput) return;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.bin'));
    addUploadedFiles(files);
  });

  fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files).filter(f => f.name.endsWith('.bin'));
    addUploadedFiles(files);
  });
}

function addUploadedFiles(newFiles) {
  newFiles.forEach(file => {
    if (!uploadedFiles.some(f => f.name === file.name)) {
      uploadedFiles.push(file);
    }
  });

  renderUploadedFileChips();
  matchUploadedFilesWithEntries();
  renderParsedTable();
}

function removeUploadedFile(index) {
  uploadedFiles.splice(index, 1);
  renderUploadedFileChips();
  matchUploadedFilesWithEntries();
  renderParsedTable();
}

function renderUploadedFileChips() {
  const container = document.getElementById('uploaded-files-list');
  if (!container) return;

  container.innerHTML = '';
  uploadedFiles.forEach((file, idx) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = `
      <i class="fas fa-file-binary"></i>
      <span>${escapeHtml(file.name)} (${(file.size / 1024).toFixed(1)} KB)</span>
      <i class="fas fa-times remove-file" onclick="removeUploadedFile(${idx})"></i>
    `;
    container.appendChild(chip);
  });
}

window.removeUploadedFile = removeUploadedFile;

function matchUploadedFilesWithEntries() {
  parsedEntries.forEach(entry => {
    let match = uploadedFiles.find(f => f.name.toLowerCase() === entry.commandFilename.toLowerCase());

    if (!match) {
      const lowerCmd = entry.commandFilename.toLowerCase();
      match = uploadedFiles.find(f => {
        const lowerName = f.name.toLowerCase();
        if (lowerCmd.includes('bootloader') && lowerName.includes('bootloader')) return true;
        if (lowerCmd.includes('partition') && lowerName.includes('partition')) return true;
        if (lowerCmd.includes('boot_app0') && lowerName.includes('boot_app0')) return true;
        return false;
      });
    }

    entry.matchedFile = match || null;
  });
}

function renderParsedTable() {
  const container = document.getElementById('parsed-table-container');
  const tbody = document.getElementById('parsed-table-body');
  const badgeStatus = document.getElementById('match-status-badge');
  const customFlasherMsg = document.getElementById('custom-flasher-msg');
  const espButtonCustom = document.getElementById('esp-button-custom');
  const btnExport = document.getElementById('btn-export-manifest');

  if (!container || !tbody) return;

  if (parsedEntries.length === 0) {
    container.style.display = 'none';
    espButtonCustom.style.display = 'none';
    btnExport.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  tbody.innerHTML = '';

  let allMatched = true;

  parsedEntries.forEach((entry, idx) => {
    const tr = document.createElement('tr');

    const matchedName = entry.matchedFile ? entry.matchedFile.name : null;
    const isMatch = !!matchedName;
    if (!isMatch) allMatched = false;

    let fileSelectorHtml = '';
    if (uploadedFiles.length > 0) {
      fileSelectorHtml = `<select class="baud-select" onchange="onManualFileSelect(${idx}, this.value)">`;
      fileSelectorHtml += `<option value="">-- Select Uploaded File --</option>`;
      uploadedFiles.forEach(f => {
        const selected = (matchedName === f.name) ? 'selected' : '';
        fileSelectorHtml += `<option value="${escapeHtml(f.name)}" ${selected}>${escapeHtml(f.name)}</option>`;
      });
      fileSelectorHtml += `</select>`;
    } else {
      fileSelectorHtml = `<span style="color: var(--text-dim);">No .bin uploaded</span>`;
    }

    tr.innerHTML = `
      <td style="color: var(--accent-cyan); font-weight: 600;">${entry.offsetHex} <span style="font-size: 0.78rem; color: var(--text-dim);">(${entry.offsetDec})</span></td>
      <td style="color: var(--text-muted);">${escapeHtml(entry.commandFilename)}</td>
      <td>${fileSelectorHtml}</td>
      <td>
        ${isMatch 
          ? `<span class="badge-status success"><i class="fas fa-check"></i> Matched</span>`
          : `<span class="badge-status pending"><i class="fas fa-exclamation-circle"></i> Missing File</span>`}
      </td>
    `;

    tbody.appendChild(tr);
  });

  if (allMatched && parsedEntries.length > 0) {
    badgeStatus.className = 'badge-status success';
    badgeStatus.textContent = 'All Files Ready ✅';
    customFlasherMsg.style.display = 'none';

    generateDynamicManifest();

    espButtonCustom.style.display = 'block';
    btnExport.style.display = 'inline-flex';
  } else {
    badgeStatus.className = 'badge-status pending';
    badgeStatus.textContent = `Pending (${parsedEntries.filter(e => !e.matchedFile).length} Missing)`;
    customFlasherMsg.style.display = 'block';
    customFlasherMsg.innerHTML = `Upload or select the remaining <code>.bin</code> files to enable flashing.`;
    espButtonCustom.style.display = 'none';
    btnExport.style.display = 'none';
  }
}

function onManualFileSelect(entryIndex, selectedFilename) {
  const file = uploadedFiles.find(f => f.name === selectedFilename) || null;
  parsedEntries[entryIndex].matchedFile = file;
  renderParsedTable();
}
window.onManualFileSelect = onManualFileSelect;

function generateDynamicManifest() {
  const parts = parsedEntries.map(entry => {
    return {
      path: URL.createObjectURL(entry.matchedFile),
      offset: entry.offsetDec
    };
  });

  currentManifestObject = {
    name: "Custom Uploaded Firmware",
    version: "1.0.0",
    new_install_prompt_erase: true,
    builds: [
      {
        chipFamily: detectedChip,
        parts: parts
      }
    ]
  };

  if (currentManifestBlobUrl) {
    URL.revokeObjectURL(currentManifestBlobUrl);
  }

  const manifestBlob = new Blob([JSON.stringify(currentManifestObject, null, 2)], { type: 'application/json' });
  currentManifestBlobUrl = URL.createObjectURL(manifestBlob);

  const customBtn = document.getElementById('esp-button-custom');
  customBtn.setAttribute('manifest', currentManifestBlobUrl);
}

/**
 * ==========================================================================
 * DEVELOPER RELEASE ZIP GENERATOR & AUTO-FETCH (MODE 3)
 * ==========================================================================
 */
function initCreatorMode() {
  const cmdTextarea = document.getElementById('creator-cmd');
  const btnExample = document.getElementById('btn-creator-example');
  const btnClear = document.getElementById('btn-creator-clear');
  const btnAutoFetch = document.getElementById('btn-auto-fetch-local');
  const dropzone = document.getElementById('creator-dropzone');
  const fileInput = document.getElementById('creator-file-input');
  const btnGenerateZip = document.getElementById('btn-generate-zip');
  const statusMsg = document.getElementById('creator-status-msg');

  if (!cmdTextarea || !dropzone || !btnGenerateZip) return;

  cmdTextarea.addEventListener('input', updateCreatorState);

  btnExample.addEventListener('click', () => {
    const exampleCmd = `C:\\Users\\Ankit Mondal\\AppData\\Local\\Arduino15\\packages\\esp32\\tools\\esptool_py\\3.3.0/esptool.exe --chip esp32 --port COM14 --baud 921600 --before default_reset --after hard_reset write_flash -z --flash_mode dio --flash_freq 80m --flash_size 4MB 0x1000 C:\\Users\\ANKITM~1\\AppData\\Local\\Temp\\arduino_build_411707/web_flash.ino.bootloader.bin 0x8000 C:\\Users\\ANKITM~1\\AppData\\Local\\Temp\\arduino_build_411707/web_flash.ino.partitions.bin 0xe000 C:\\Users\\Ankit Mondal\\AppData\\Local\\Arduino15\\packages\\esp32\\hardware\\esp32\\2.0.3/tools/partitions/boot_app0.bin 0x10000 C:\\Users\\ANKITM~1\\AppData\\Local\\Temp\\arduino_build_411707/web_flash.ino.bin`;
    cmdTextarea.value = exampleCmd;
    updateCreatorState();
  });

  btnClear.addEventListener('click', () => {
    cmdTextarea.value = '';
    creatorFiles = [];
    renderCreatorFileChips();
    updateCreatorState();
  });

  // Auto Fetch Local Files via Backend Server API
  if (btnAutoFetch) {
    btnAutoFetch.addEventListener('click', async () => {
      const rawCmd = cmdTextarea.value.trim();
      if (!rawCmd) {
        alert('Please paste your compiler flash command first.');
        return;
      }

      btnAutoFetch.disabled = true;
      btnAutoFetch.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Reading Local Disk & Packaging ZIP...';
      statusMsg.innerHTML = '<span style="color: var(--accent-cyan);">Detecting and fetching compiled .bin files from disk...</span>';

      try {
        // Prevent calling the local API if hosted on GitHub Pages or other remote servers
        if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
          throw new Error('The Auto-Detect feature only works when running the local Python server (localhost). On GitHub Pages, please use the manual drag-and-drop area below.');
        }

        const response = await fetch('/api/auto-package', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: rawCmd })
        });

        const contentType = response.headers.get("content-type");
        if (!response.ok || !contentType || !contentType.includes("application/json")) {
          throw new Error('Local server not responding correctly. Ensure `python package_firmware.py --server` is running.');
        }

        const resData = await response.json();

        if (resData.success) {
          statusMsg.innerHTML = `<span style="color: var(--accent-emerald); font-weight: 600;"><i class="fas fa-check-circle"></i> Success! Local .bin files detected on disk and packaged into <code>${resData.zip_url}</code>!</span>`;
          
          // Trigger immediate download of generated ZIP
          const a = document.createElement('a');
          a.href = resData.zip_url + '?t=' + Date.now();
          a.download = 'web_flasher_portal.zip';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        } else {
          throw new Error(resData.message || 'Error processing request.');
        }
      } catch (err) {
        console.warn(err);
        statusMsg.innerHTML = `<span style="color: var(--accent-amber);"><i class="fas fa-exclamation-triangle"></i> ${err.message}</span>`;
      } finally {
        btnAutoFetch.disabled = false;
        btnAutoFetch.innerHTML = '<i class="fas fa-magic"></i> Auto-Detect Local .BIN Files & Create ZIP';
      }
    });
  }

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.bin'));
    addCreatorFiles(files);
  });

  fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files).filter(f => f.name.endsWith('.bin'));
    addCreatorFiles(files);
  });

  btnGenerateZip.addEventListener('click', generateReleaseZip);
}

function addCreatorFiles(newFiles) {
  newFiles.forEach(file => {
    if (!creatorFiles.some(f => f.name === file.name)) {
      creatorFiles.push(file);
    }
  });

  renderCreatorFileChips();
  updateCreatorState();
}

function removeCreatorFile(index) {
  creatorFiles.splice(index, 1);
  renderCreatorFileChips();
  updateCreatorState();
}
window.removeCreatorFile = removeCreatorFile;

function renderCreatorFileChips() {
  const container = document.getElementById('creator-files-list');
  if (!container) return;

  container.innerHTML = '';
  creatorFiles.forEach((file, idx) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = `
      <i class="fas fa-file-archive"></i>
      <span>${escapeHtml(file.name)} (${(file.size / 1024).toFixed(1)} KB)</span>
      <i class="fas fa-times remove-file" onclick="removeCreatorFile(${idx})"></i>
    `;
    container.appendChild(chip);
  });
}

function updateCreatorState() {
  const rawCmd = document.getElementById('creator-cmd').value;
  const statusMsg = document.getElementById('creator-status-msg');
  const btnGenerateZip = document.getElementById('btn-generate-zip');
  const badge = document.getElementById('creator-chip-badge');

  if (!rawCmd || !rawCmd.trim()) {
    statusMsg.innerHTML = 'Paste an esptool command and click <strong>Auto-Detect Local .BIN Files & Create ZIP</strong>.';
    btnGenerateZip.style.display = 'none';
    badge.textContent = 'Auto-Detect Mode';
    return;
  }

  const chipMatch = rawCmd.match(/--chip\s+([a-zA-Z0-9_-]+)/i);
  creatorChip = 'ESP32';
  if (chipMatch && chipMatch[1]) {
    const rawChip = chipMatch[1].toLowerCase();
    if (rawChip.includes('esp32s2')) creatorChip = 'ESP32-S2';
    else if (rawChip.includes('esp32s3')) creatorChip = 'ESP32-S3';
    else if (rawChip.includes('esp32c3')) creatorChip = 'ESP32-C3';
    else if (rawChip.includes('esp32c6')) creatorChip = 'ESP8266';
  }
  badge.textContent = `Chip: ${creatorChip}`;

  const writeFlashIndex = rawCmd.indexOf('write_flash');
  if (writeFlashIndex === -1) {
    statusMsg.innerHTML = '<span style="color: var(--accent-rose);">Invalid command: "write_flash" keyword missing.</span>';
    btnGenerateZip.style.display = 'none';
    return;
  }

  const flashArgsStr = rawCmd.substring(writeFlashIndex + 'write_flash'.length);
  const pattern = /(0x[0-9a-fA-F]+)\s+(.*?\.bin)/gi;
  creatorEntries = [];

  let match;
  while ((match = pattern.exec(flashArgsStr)) !== null) {
    const offsetHex = match[1];
    const offsetDec = parseInt(offsetHex, 16);
    const rawPath = match[2].trim().replace(/^["']|["']$/g, '');
    const basename = rawPath.split(/[/\\]/).pop();

    creatorEntries.push({
      offsetHex: offsetHex,
      offsetDec: offsetDec,
      commandFilename: basename,
      matchedFile: creatorFiles.find(f => f.name.toLowerCase() === basename.toLowerCase()) || null
    });
  }

  const missingCount = creatorEntries.filter(e => !e.matchedFile).length;

  if (creatorEntries.length === 0) {
    statusMsg.innerHTML = '<span style="color: var(--accent-rose);">No offset addresses (0x...) or .bin filenames detected.</span>';
    btnGenerateZip.style.display = 'none';
  } else if (missingCount > 0) {
    statusMsg.innerHTML = `Detected ${creatorEntries.length} partitions (${creatorChip}). Click <strong>Auto-Detect Local .BIN Files & Create ZIP</strong> to fetch files from your hard drive automatically!`;
    btnGenerateZip.style.display = 'none';
  } else {
    statusMsg.innerHTML = `<span style="color: var(--accent-emerald); font-weight: 600;"><i class="fas fa-check-circle"></i> Ready! All ${creatorEntries.length} partitions matched for ${creatorChip}.</span>`;
    btnGenerateZip.style.display = 'inline-flex';
  }
}

/**
 * Generate standalone deployable release ZIP using JSZip
 */
async function generateReleaseZip() {
  if (typeof JSZip === 'undefined') {
    alert('JSZip library loading. Please try again in a moment.');
    return;
  }

  const btnGenerateZip = document.getElementById('btn-generate-zip');
  btnGenerateZip.disabled = true;
  btnGenerateZip.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Building web_flasher_portal.zip...';

  try {
    const zip = new JSZip();

    const manifestParts = creatorEntries.map(entry => ({
      path: `firmware/${entry.matchedFile.name}`,
      offset: entry.offsetDec
    }));

    const rawCmd = document.getElementById('creator-cmd').value.trim();

    // Generate dynamic README.md
    let readmeLines = [
      `# ESP Web Flasher - ${creatorChip} Firmware Package`,
      "",
      "This package was auto-generated by the **ESP Web Flasher Portal**.",
      "",
      "## Firmware Partition Table",
      "",
      "| Flash Offset | Filename |",
      "|:------------:|:---------|",
    ];
    creatorEntries.forEach(entry => {
      readmeLines.push(`| \`${entry.offsetHex}\` | \`${entry.matchedFile.name}\` |`);
    });
    readmeLines = readmeLines.concat([
      "",
      `**Target Chip:** ${creatorChip}`,
      "",
      "## Original Flash Command",
      "```bash",
      rawCmd,
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
      ""
    ]);
    const readmeContent = readmeLines.join("\n");
    const manifestObj = {
      name: "ESP32 Web Flasher",
      version: "1.0.0",
      new_install_prompt_erase: true,
      builds: [
        {
          chipFamily: creatorChip,
          parts: manifestParts
        }
      ]
    };

    zip.file('manifest.json', JSON.stringify(manifestObj, null, 2));
    zip.file('README.md', readmeContent);

    const firmwareFolder = zip.folder('firmware');
    // Store flash_command.txt INSIDE firmware/ so End-User Flasher reads it
    firmwareFolder.file('flash_command.txt', rawCmd);
    creatorEntries.forEach(entry => {
      firmwareFolder.file(entry.matchedFile.name, entry.matchedFile);
    });

    const content = await zip.generateAsync({ type: 'blob' });

    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `web_flasher_portal_${creatorChip.toLowerCase().replace(/[^a-z0-9]/g, '')}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

  } catch (err) {
    console.error('ZIP generation error:', err);
    alert('Failed to generate ZIP package: ' + err.message);
  } finally {
    btnGenerateZip.disabled = false;
    btnGenerateZip.innerHTML = '<i class="fas fa-file-export"></i> Download Browser Generated Release ZIP';
  }
}

/**
 * Serial Monitor Terminal state and event handlers
 */
let port = null;
let reader = null;
let keepReading = false;
let autoScroll = true;

function initSerialTerminal() {
  const btnConnect = document.getElementById('btn-connect-terminal');
  const btnClear = document.getElementById('btn-clear-terminal');
  const btnAutoScroll = document.getElementById('btn-autoscroll');
  const btnSaveLog = document.getElementById('btn-save-log');
  const baudSelect = document.getElementById('baud-rate');
  const terminalWindow = document.getElementById('terminal-window');

  if (!btnConnect) return;

  if (!('serial' in navigator)) {
    btnConnect.disabled = true;
    btnConnect.title = 'WebSerial not supported in this browser';
    btnConnect.style.opacity = '0.5';
    btnConnect.style.cursor = 'not-allowed';
  }

  btnConnect.addEventListener('click', async () => {
    if (port) {
      await disconnectSerial();
    } else {
      await connectSerial(parseInt(baudSelect.value, 10));
    }
  });

  btnClear.addEventListener('click', () => {
    terminalWindow.innerHTML = `
      <div class="terminal-placeholder">
        Serial log cleared. Waiting for device output...
      </div>
    `;
  });

  btnAutoScroll.addEventListener('click', () => {
    autoScroll = !autoScroll;
    btnAutoScroll.classList.toggle('btn-primary-sm', autoScroll);
    btnAutoScroll.innerHTML = autoScroll
      ? '<i class="fas fa-arrow-down"></i> Auto-scroll ON'
      : '<i class="fas fa-pause"></i> Auto-scroll OFF';
  });

  btnSaveLog.addEventListener('click', () => {
    const textContent = Array.from(terminalWindow.querySelectorAll('.terminal-line'))
      .map(el => el.textContent)
      .join('\n');
    
    if (!textContent) {
      alert('No serial log content to download.');
      return;
    }

    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `esp32-serial-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

/**
 * Connect to serial device
 */
async function connectSerial(baudRate) {
  const btnConnect = document.getElementById('btn-connect-terminal');
  const terminalWindow = document.getElementById('terminal-window');

  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: baudRate });

    btnConnect.innerHTML = '<i class="fas fa-plug"></i> Disconnect';
    btnConnect.classList.add('btn-primary-sm');

    const placeholder = terminalWindow.querySelector('.terminal-placeholder');
    if (placeholder) placeholder.remove();

    appendLogLine(`[SYSTEM] Connected to serial port at ${baudRate} baud. Listening...`, 'info');

    keepReading = true;
    readSerialLoop();
  } catch (err) {
    console.error('Serial Connection Error:', err);
    if (err.name !== 'NotFoundError') {
      appendLogLine(`[ERROR] Connection failed: ${err.message}`, 'error');
    }
  }
}

/**
 * Disconnect from serial device
 */
async function disconnectSerial() {
  keepReading = false;
  const btnConnect = document.getElementById('btn-connect-terminal');

  if (reader) {
    try {
      await reader.cancel();
    } catch (e) {
      console.warn(e);
    }
  }

  if (port) {
    try {
      await port.close();
    } catch (e) {
      console.warn(e);
    }
    port = null;
  }

  btnConnect.innerHTML = '<i class="fas fa-terminal"></i> Start Terminal';
  btnConnect.classList.remove('btn-primary-sm');
  appendLogLine('[SYSTEM] Disconnected from serial port.', 'warning');
}

/**
 * Continuous read loop from WebSerial input stream
 */
async function readSerialLoop() {
  const textDecoder = new TextDecoderStream();
  const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
  reader = textDecoder.readable.getReader();

  let lineBuffer = '';

  try {
    while (keepReading) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        lineBuffer += value;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();

        for (const line of lines) {
          appendLogLine(line.trimEnd());
        }
      }
    }
  } catch (error) {
    if (keepReading) {
      appendLogLine(`[ERROR] Read error: ${error.message}`, 'error');
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Append formatted log line to terminal view
 */
function appendLogLine(text, type = 'normal') {
  if (!text && type === 'normal') return;
  const terminalWindow = document.getElementById('terminal-window');
  
  const lineEl = document.createElement('div');
  lineEl.className = `terminal-line ${type}`;

  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  lineEl.innerHTML = `<span class="timestamp">[${timestamp}]</span> ${escapeHtml(text)}`;

  terminalWindow.appendChild(lineEl);

  if (autoScroll) {
    terminalWindow.scrollTop = terminalWindow.scrollHeight;
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * General UI enhancements
 */
function initUI() {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      e.preventDefault();
      const target = document.getElementById(this.getAttribute('href').substring(1));
      if (target) {
        target.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });
}
