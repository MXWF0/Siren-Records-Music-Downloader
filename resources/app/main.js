const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const axios = require('axios');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const NodeID3 = require('node-id3');
const { ensureCacheDirectory, loadDownloaded, saveDownloaded } = require('./download-state');
const { sanitizeFileName, writeReadableToFile } = require('./download-utils');
const { loadSettings, saveSettings, normalizeSettings } = require('./settings-store');
const { findCachedCover, saveCachedCover } = require('./cover-cache');

let win;
let defaultMusicDirectory;
let settingsFile;
let settings;
let musicDirectory;
let cacheDirectory;
let downloaded = {};
let initialization;
let activeDownload = null;

function send(channel, value) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}

function downloadedIds() {
  return Object.keys(downloaded);
}

function settingsView() {
  return { ...settings, downloaded: downloadedIds() };
}

function legacyPath() {
  return path.join(defaultMusicDirectory, 'tmp', 'path.txt');
}

async function switchDownloadDirectory(directory) {
  musicDirectory = directory;
  cacheDirectory = path.join(musicDirectory, 'tmp');
  await ensureCacheDirectory(cacheDirectory);
  downloaded = await loadDownloaded(cacheDirectory);
}

async function initialize() {
  defaultMusicDirectory = path.join(app.getPath('music'), 'monster-siren');
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  const defaults = { downloadDirectory: defaultMusicDirectory, deleteSourceWav: true, separateDirectory: true, groupByDownload: true };
  settings = await loadSettings(settingsFile, defaults, legacyPath());
  await switchDownloadDirectory(settings.downloadDirectory);
}

async function ensureInitialized() {
  await initialization;
}

function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
    titleBarStyle: 'hidden',
    titleBarOverlay: true
  });
  win.loadFile('index.html');
}

function isAbort(error, controller) {
  return error?.code === 'ERR_CANCELED' || error?.name === 'AbortError' || controller?.signal.aborted;
}

async function getFfmpegPath() {
  const candidates = [
    path.resolve(process.resourcesPath, '..', 'ffmpeg.exe'),
    path.resolve(__dirname, '..', '..', 'ffmpeg.exe')
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next packaged/development location.
    }
  }
  throw new Error('Bundled ffmpeg.exe was not found');
}

function runProcess(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    const stderr = [];
    child.stderr.on('data', (data) => stderr.push(data));
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) return reject(Object.assign(new Error('Download cancelled'), { name: 'AbortError' }));
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
    });
  });
}

async function fetchOptional(url, options, controller) {
  if (!url) return null;
  try {
    return await axios.get(url, options);
  } catch (error) {
    if (isAbort(error, controller)) throw error;
    console.warn(`Optional download failed: ${url}`, error.message);
    return null;
  }
}

async function loadCover(albumCid, url, controller) {
  const cachedCover = await findCachedCover(cacheDirectory, albumCid);
  const response = await fetchOptional(url, {
    responseType: 'arraybuffer', signal: controller.signal, timeout: 30000
  }, controller);
  if (!response?.data) return cachedCover;
  return saveCachedCover(
    cacheDirectory,
    albumCid,
    Buffer.from(response.data),
    response.headers['content-type'] || 'image/jpeg'
  );
}

async function downloadAudio(url, temporaryPath, controller, songId) {
  const response = await axios.get(url, {
    responseType: 'stream', signal: controller.signal, timeout: 30000,
    maxContentLength: Infinity, maxBodyLength: Infinity
  });
  const total = Number(response.headers['content-length']) || null;
  let lastSentAt = 0;
  let lastReceived = 0;
  let lastRateAt = Date.now();
  await writeReadableToFile(response.data, temporaryPath, {
    signal: controller.signal,
    onProgress: (loaded) => {
      const now = Date.now();
      const elapsed = Math.max(now - lastRateAt, 1);
      const rate = ((loaded - lastReceived) * 1000) / elapsed;
      if (now - lastSentAt >= 150 || (total && loaded >= total)) {
        send('download-progress', { id: songId, loaded, total, rate });
        if (win && !win.isDestroyed()) win.setProgressBar(total ? loaded / total : 2);
        lastSentAt = now;
        lastReceived = loaded;
        lastRateAt = now;
      }
    }
  });
  return response.headers['content-type'] || '';
}

function audioKind(contentType, sourceUrl) {
  const type = String(contentType).toLowerCase();
  if (type.includes('mpeg') || type.includes('mp3') || /\.mp3(?:$|[?#])/i.test(sourceUrl)) return 'mp3';
  if (type.includes('wav') || /\.wav(?:$|[?#])/i.test(sourceUrl)) return 'wav';
  throw new Error(`Unsupported audio type: ${contentType || sourceUrl}`);
}

async function finishMp3({ temporaryAudio, finalPath, tags }) {
  const result = NodeID3.update(tags, temporaryAudio);
  if (result instanceof Error || result === false) throw new Error('Unable to write MP3 metadata');
  await fs.rename(temporaryAudio, finalPath);
}

async function finishWav({ temporaryAudio, jobDirectory, finalBasePath, tags, coverPath, controller, deleteSourceWav }) {
  const ffmpegPath = await getFfmpegPath();
  const temporaryFlac = path.join(jobDirectory, 'converted.flac');
  const args = ['-y', '-i', temporaryAudio];
  if (coverPath) args.push('-i', coverPath, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic');
  args.push('-metadata', `title=${tags.title}`, '-metadata', `artist=${tags.artist}`, '-metadata', `album=${tags.album}`, '-codec:a', 'flac', temporaryFlac);
  await runProcess(ffmpegPath, args, controller.signal);
  await fs.rename(temporaryFlac, `${finalBasePath}.flac`);
  if (!deleteSourceWav) await fs.copyFile(temporaryAudio, `${finalBasePath}.wav`);
}

async function performDownload(job, request) {
  const { id, controller } = job;
  const jobDirectory = path.join(cacheDirectory, 'active', id);
  let temporaryAudio;
  let kind;
  let finalBasePath;
  let terminalEvent;
  try {
    await fs.mkdir(jobDirectory, { recursive: true });
    const songResponse = await axios.get(`https://monster-siren.hypergryph.com/api/song/${id}`, { signal: controller.signal, timeout: 30000 });
    const song = songResponse.data?.data;
    if (!song?.sourceUrl) throw new Error('Song metadata does not contain an audio URL');

    const albumRequest = axios.get(`https://monster-siren.hypergryph.com/api/album/${song.albumCid}/data`, { signal: controller.signal, timeout: 30000 });
    const lyricsRequest = fetchOptional(song.lyricUrl, { responseType: 'text', signal: controller.signal, timeout: 30000 }, controller);
    const albumWithCoverRequest = albumRequest.then(async (response) => ({
      albumResult: response,
      cover: await loadCover(song.albumCid, response.data?.data?.coverUrl, controller)
    }));
    temporaryAudio = path.join(jobDirectory, 'audio.source');
    const audioRequest = downloadAudio(song.sourceUrl, temporaryAudio, controller, id);
    const [albumWithCover, lyricsResult, contentType] = await Promise.all([albumWithCoverRequest, lyricsRequest, audioRequest]);

    const album = albumWithCover.albumResult.data?.data || {};
    const cover = albumWithCover.cover;
    const safeAlbum = sanitizeFileName(album.name || String(song.albumCid), String(song.albumCid));
    const safeName = sanitizeFileName(song.name, String(id));
    const outputDirectory = settings.separateDirectory ? path.join(musicDirectory, safeAlbum) : musicDirectory;
    await fs.mkdir(outputDirectory, { recursive: true });
    finalBasePath = path.join(outputDirectory, `[${safeAlbum}] ${safeName}`);
    kind = audioKind(contentType, song.sourceUrl);
    const tags = { title: song.name, artist: Array.isArray(song.artists) ? song.artists.join(' ') : '', album: album.name || safeAlbum };
    if (cover?.buffer) {
      tags.APIC = { mime: cover.mime || 'image/jpeg', type: { id: 3 }, imageBuffer: cover.buffer };
    }
    if (lyricsResult?.data) tags.unsynchronisedLyrics = { language: 'eng', text: lyricsResult.data };

    if (kind === 'mp3') await finishMp3({ temporaryAudio, finalPath: `${finalBasePath}.mp3`, tags });
    else await finishWav({ temporaryAudio, jobDirectory, finalBasePath, tags, coverPath: cover?.path, controller, deleteSourceWav: settings.deleteSourceWav });
    if (lyricsResult?.data) await fs.writeFile(`${finalBasePath}.lrc`, lyricsResult.data, 'utf8');

    downloaded[String(id)] = true;
    await saveDownloaded(cacheDirectory, downloaded);
    terminalEvent = { channel: 'download-complete', value: { id: String(id), redownloaded: request.force === true } };
  } catch (error) {
    const cancelled = isAbort(error, controller);
    if (!cancelled) controller.abort();
    if (cancelled) terminalEvent = { channel: 'download-cancelled', value: { id: String(id) } };
    else {
      if (kind === 'wav' && temporaryAudio && finalBasePath) {
        try { await fs.rename(temporaryAudio, `${finalBasePath}.wav`); } catch { /* best effort preservation */ }
      }
      console.error(`Download failed for ${id}:`, error);
      terminalEvent = { channel: 'download-failed', value: { id: String(id), message: error.message || 'Download failed' } };
    }
  } finally {
    await fs.rm(jobDirectory, { recursive: true, force: true }).catch(() => {});
    if (activeDownload === job) {
      activeDownload = null;
      if (win && !win.isDestroyed()) win.setProgressBar(-1);
    }
    if (terminalEvent) send(terminalEvent.channel, terminalEvent.value);
  }
}

async function startDownload(_event, request) {
  await ensureInitialized();
  const id = String(request?.id || '');
  if (!/^\d+$/.test(id)) throw new Error('Invalid song id');
  if (activeDownload) throw new Error('Another download is already active');
  if (downloaded[id] && request?.force !== true) {
    send('download-complete', { id, alreadyDownloaded: true });
    return { started: false, alreadyDownloaded: true };
  }
  const job = { id, controller: new AbortController() };
  activeDownload = job;
  if (win && !win.isDestroyed()) win.setProgressBar(2);
  void performDownload(job, { force: request?.force === true });
  return { started: true };
}

async function cancelCurrentDownload() {
  if (activeDownload) activeDownload.controller.abort();
  return { cancelled: Boolean(activeDownload) };
}

async function clearDownloadState() {
  await ensureInitialized();
  if (activeDownload) throw new Error('Cancel the active download before clearing the cache');
  await fs.rm(cacheDirectory, { recursive: true, force: true });
  await ensureCacheDirectory(cacheDirectory);
  downloaded = {};
  await saveDownloaded(cacheDirectory, downloaded);
  send('download-state-changed', { downloaded: [] });
  return { downloaded: [] };
}

async function updateSettings(_event, changes) {
  await ensureInitialized();
  if (activeDownload) throw new Error('Finish or cancel the active download before changing settings');
  const next = normalizeSettings({
    ...settings,
    deleteSourceWav: typeof changes?.deleteSourceWav === 'boolean' ? changes.deleteSourceWav : settings.deleteSourceWav,
    separateDirectory: typeof changes?.separateDirectory === 'boolean' ? changes.separateDirectory : settings.separateDirectory,
    groupByDownload: typeof changes?.groupByDownload === 'boolean' ? changes.groupByDownload : settings.groupByDownload
  }, settings);
  settings = next;
  await saveSettings(settingsFile, settings);
  send('settings-changed', settingsView());
  return settingsView();
}

async function selectFolder() {
  await ensureInitialized();
  if (activeDownload) throw new Error('Finish or cancel the active download before changing settings');
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return { changed: false, ...settingsView() };
  settings = normalizeSettings({ ...settings, downloadDirectory: result.filePaths[0] }, settings);
  await saveSettings(settingsFile, settings);
  await switchDownloadDirectory(settings.downloadDirectory);
  const value = { changed: true, ...settingsView() };
  send('download-state-changed', { downloaded: downloadedIds() });
  send('settings-changed', settingsView());
  return value;
}

async function openFolder() {
  await ensureInitialized();
  return shell.openPath(musicDirectory);
}

app.whenReady().then(() => {
  initialization = initialize();
  ipcMain.handle('get-download-state', async () => {
    await ensureInitialized();
    return { downloaded: downloadedIds() };
  });
  ipcMain.handle('get-settings', async () => { await ensureInitialized(); return settingsView(); });
  ipcMain.handle('update-settings', updateSettings);
  ipcMain.handle('start-download', startDownload);
  ipcMain.handle('cancel-current-download', cancelCurrentDownload);
  ipcMain.handle('clear-download-state', clearDownloadState);
  ipcMain.handle('open-folder', openFolder);
  ipcMain.handle('select-folder', selectFolder);
  createWindow();
  Menu.setApplicationMenu(Menu.buildFromTemplate([]));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
