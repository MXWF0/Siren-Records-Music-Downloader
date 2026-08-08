window.downloadedIds = new Set();
window.downloadQueue = [];
window.currentDownloadId = null;
window.isdownloading = false;
window.catalogReady = false;
window.currentSettings = { downloadDirectory: '', deleteSourceWav: true, separateDirectory: true, groupByDownload: true };

const groupCollapsed = { pending: false, downloaded: false };
let currentIndex = -1;
let findRows = [];
let searchHighlightTimer;

function groupElement(group) {
  return document.getElementById(group === 'pending' ? 'pending-group' : 'downloaded-group');
}

function setGroupCollapsed(group, collapsed) {
  if (group === 'all') return;
  groupCollapsed[group] = collapsed;
  const toggle = document.getElementById(group === 'pending' ? 'pending-toggle' : 'downloaded-toggle');
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.title = collapsed ? '展开此分组' : '折叠此分组';
  groupElement(group).querySelectorAll('tr[data-song-row]').forEach((row) => row.classList.toggle('d-none', collapsed));
}

function refreshCounts() {
  const downloadedCount = window.songOrder.filter((song) => window.downloadedIds.has(String(song.cid))).length;
  const pendingCount = window.songOrder.length - downloadedCount;
  document.getElementById('downloaded-count').innerText = downloadedCount;
  document.getElementById('pending-count').innerText = pendingCount;
  document.getElementById('download-all-button').innerText = 'ALL!（下载全部）';
  document.getElementById('download-all-button').disabled = pendingCount === 0;
}

function createButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn btn-sm text-nowrap ${className}`;
  button.innerText = label;
  button.addEventListener('click', onClick);
  return button;
}

function createSongRow(song, group) {
  const id = String(song.cid);
  const row = document.createElement('tr');
  row.id = `song-row-${id}`;
  row.dataset.songRow = 'true';
  row.dataset.songId = id;
  row.dataset.group = group;
  if (window.downloadedIds.has(id)) row.classList.add('downloaded-row');
  const name = document.createElement('td');
  name.id = `song${id}`;
  name.innerText = song.name;
  const album = document.createElement('td');
  album.innerText = window.albums[String(song.albumCid)]?.name || String(song.albumCid);
  const actions = document.createElement('td');
  actions.className = 'text-nowrap';
  actions.append(
    createButton('详情', 'btn-secondary', () => info(id)),
    document.createTextNode(' '),
    createButton('下载专辑', 'btn-outline-primary', () => downloadAlbum(String(song.albumCid))),
    document.createTextNode(' '),
    createButton(group === 'downloaded' ? '重新下载' : '下载', group === 'downloaded' ? 'btn-outline-primary' : 'btn-primary', () => download(id))
  );
  row.append(name, album, actions);
  return row;
}

window.renderSongList = function renderSongList() {
  if (!window.catalogReady && !window.songOrder.length) return;
  const groupingEnabled = window.currentSettings.groupByDownload !== false;
  document.getElementById('pending-group-header').classList.toggle('d-none', !groupingEnabled);
  document.getElementById('downloaded-group-header').classList.toggle('d-none', !groupingEnabled);
  if (!groupingEnabled) {
    const pendingElement = groupElement('pending');
    const downloadedElement = groupElement('downloaded');
    while (pendingElement.children.length > 1) pendingElement.removeChild(pendingElement.lastChild);
    while (downloadedElement.children.length > 1) downloadedElement.removeChild(downloadedElement.lastChild);
    const fragment = document.createDocumentFragment();
    for (const song of window.songOrder) fragment.appendChild(createSongRow(song, 'all'));
    pendingElement.appendChild(fragment);
    refreshCounts();
    return;
  }
  const groups = window.SongGroups.partitionSongs(window.songOrder, window.downloadedIds);
  for (const [group, songs] of Object.entries(groups)) {
    const element = groupElement(group);
    while (element.children.length > 1) element.removeChild(element.lastChild);
    const fragment = document.createDocumentFragment();
    for (const song of songs) fragment.appendChild(createSongRow(song, group));
    element.appendChild(fragment);
    setGroupCollapsed(group, groupCollapsed[group]);
  }
  refreshCounts();
};

window.setDownloadedState = function setDownloadedState(ids) {
  window.downloadedIds = new Set((ids || []).map(String));
  if (window.catalogReady) window.renderSongList();
};

function applySettings(settings) {
  const groupingChanged = window.currentSettings.groupByDownload !== settings.groupByDownload;
  window.currentSettings = { ...window.currentSettings, ...settings };
  window.ifdelwav = window.currentSettings.deleteSourceWav;
  window.ifsdir = window.currentSettings.separateDirectory;
  document.getElementById('checkwav').checked = window.ifdelwav;
  document.getElementById('checkdir').checked = window.ifsdir;
  document.getElementById('checkgroup').checked = window.currentSettings.groupByDownload !== false;
  document.getElementById('current-directory').innerText = window.currentSettings.downloadDirectory || '未设置';
  document.getElementById('settings-directory').innerText = window.currentSettings.downloadDirectory || '未设置';
  if (groupingChanged && window.catalogReady) window.renderSongList();
}

window.applyInitialSettings = function applyInitialSettings(settings) {
  applySettings(settings);
};

function markDownloaded(id) {
  const songId = String(id);
  window.downloadedIds.add(songId);
  const row = document.getElementById(`song-row-${songId}`);
  if (row) row.classList.add('downloaded-row');
  if (!window.currentSettings.groupByDownload) {
    refreshCounts();
    return;
  }
  if (row && row.dataset.group !== 'downloaded') {
    row.dataset.group = 'downloaded';
    row.classList.remove('bg-warning-subtle');
    groupElement('downloaded').appendChild(row);
    row.classList.toggle('d-none', groupCollapsed.downloaded);
    const action = row.querySelector('td:last-child button:last-child');
    if (action) {
      action.innerText = '重新下载';
      action.className = 'btn btn-sm text-nowrap btn-outline-primary';
    }
  }
  refreshCounts();
}

function setStatus(status, detail = '') {
  document.getElementById('d_status').innerText = status;
  document.getElementById('d_info').innerText = detail;
}

function resetProgress() {
  document.getElementById('dl1').setAttribute('width', '0');
}

function warnBusy() {
  document.getElementById('d_warn').click();
}

function runNext() {
  while (window.downloadQueue.length) {
    const next = window.downloadQueue[0];
    if (!window.downloadedIds.has(next.id) || next.force) break;
    window.downloadQueue.shift();
  }
  if (!window.downloadQueue.length) {
    window.isdownloading = false;
    window.currentDownloadId = null;
    if (!document.getElementById('d_status').innerText.includes('失败')) setStatus('下载任务完成');
    return;
  }
  const item = window.downloadQueue.shift();
  const id = item.id;
  const song = window.songs[id];
  if (!song) return runNext();
  window.isdownloading = true;
  window.currentDownloadId = id;
  document.getElementById('d_song').innerText = `<${song.name}> `;
  resetProgress();
  document.getElementById(`song${id}`)?.classList.add('bg-warning-subtle');
  setStatus(item.force ? '正在重新下载' : '正在下载');
  window.electronAPI.startDownload({ id, force: item.force })
    .catch((error) => handleDownloadFailed({ id, message: error.message || '无法开始下载' }));
}

function queueSongs(ids, force = false) {
  if (window.isdownloading) return warnBusy();
  window.downloadQueue = window.DownloadQueue.createQueue(ids, window.downloadedIds, force);
  if (!window.downloadQueue.length) return setStatus('所选歌曲均已下载');
  runNext();
}

function download(id) {
  queueSongs([id], window.downloadedIds.has(String(id)));
}

function downloadAlbum(albumCid) {
  queueSongs(window.songOrder.filter((song) => String(song.albumCid) === String(albumCid)).map((song) => song.cid), 'downloaded');
}

function downloadAll() {
  queueSongs(window.songOrder.map((song) => song.cid), false);
}

function cancelDownload() {
  window.downloadQueue = [];
  if (!window.currentDownloadId) return setStatus('没有正在下载的歌曲');
  setStatus('正在取消');
  window.electronAPI.cancelCurrentDownload().catch((error) => setStatus('取消失败', error.message));
}

function finishCurrent(id) {
  if (window.currentDownloadId !== String(id)) return false;
  document.getElementById(`song${id}`)?.classList.remove('bg-warning-subtle');
  window.currentDownloadId = null;
  window.isdownloading = false;
  return true;
}

function handleDownloadFailed(value) {
  if (!finishCurrent(value.id)) return;
  setStatus('下载失败', value.message || '请检查网络后重试');
  setTimeout(runNext, 0);
}

window.electronAPI.onDownloadProgress((value) => {
  if (String(value.id) !== window.currentDownloadId) return;
  const loaded = value.loaded / 1024 / 1024;
  const total = value.total ? value.total / 1024 / 1024 : null;
  const rate = value.rate / 1024 / 1024;
  const percent = total ? Math.min(100, (loaded / total) * 100) : null;
  document.getElementById('dl1').setAttribute('width', String(percent ? percent * 16 : 0));
  setStatus('正在下载', total
    ? `（${percent.toFixed(0)}%） ${loaded.toFixed(2)} / ${total.toFixed(2)} MB，${rate.toFixed(2)} MB/s`
    : `${loaded.toFixed(2)} MB，${rate.toFixed(2)} MB/s`);
});

window.electronAPI.onDownloadComplete((value) => {
  markDownloaded(value.id);
  if (!finishCurrent(value.id)) return;
  setStatus(value.redownloaded ? '重新下载完成' : value.alreadyDownloaded ? '已下载' : '下载完成');
  setTimeout(runNext, 0);
});

window.electronAPI.onDownloadFailed(handleDownloadFailed);
window.electronAPI.onDownloadCancelled((value) => {
  if (!finishCurrent(value.id)) return;
  setStatus('已取消下载');
});
window.electronAPI.onDownloadStateChanged((value) => window.setDownloadedState(value.downloaded || []));
window.electronAPI.onSettingsChanged((value) => applySettings(value));

async function deltemp() {
  if (window.isdownloading) return warnBusy();
  try {
    await window.electronAPI.clearDownloadState();
    setStatus('已清除缓存和下载记录');
  } catch (error) {
    setStatus('清除失败', error.message);
  }
}

function openfolder() {
  window.electronAPI.openFolder().catch((error) => setStatus('无法打开下载目录', error.message));
}

async function selectfolder() {
  try {
    const result = await window.electronAPI.selectFolder();
    if (result.changed) applySettings(result);
  } catch (error) {
    setStatus('无法切换下载目录', error.message);
  }
}

async function persistSettings(changes) {
  try {
    const result = await window.electronAPI.updateSettings(changes);
    applySettings(result);
  } catch (error) {
    applySettings(window.currentSettings);
    setStatus('保存设置失败', error.message);
  }
}

function changecheckwav() {
  persistSettings({ deleteSourceWav: document.getElementById('checkwav').checked });
}

function changecheckdir() {
  persistSettings({ separateDirectory: document.getElementById('checkdir').checked });
}

function changecheckgroup() {
  persistSettings({ groupByDownload: document.getElementById('checkgroup').checked });
}

async function info(id) {
  const song = window.songs[String(id)];
  if (!song) return;
  document.getElementById('showmusicinfo').click();
  document.getElementById('info_name').innerText = song.name;
  const album = window.albums[String(song.albumCid)];
  document.getElementById('info_pic').src = album?.coverDeUrl || album?.coverUrl || '';
  try {
    const response = await fetch(`https://monster-siren.hypergryph.com/api/song/${id}`);
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const details = (await response.json()).data;
    for (const [containerId, value, placeholder] of [
      ['info_src', details.sourceUrl, '无音频地址'],
      ['info_lrc', details.lyricUrl, '无歌词地址']
    ]) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'form-control';
      input.value = value || '';
      input.placeholder = placeholder;
      input.readOnly = true;
      document.getElementById(containerId).replaceChildren(input);
    }
  } catch (error) {
    setStatus('无法加载详情', error.message);
  }
}

function searchWithEnter(event) {
  if (event.key === 'Enter') {
    if (!findRows.length) {
      const text = document.getElementById('searchBox').value.trim().toLowerCase();
      findRows = [...document.querySelectorAll('tr[data-song-row]')]
        .filter((row) => row.textContent.toLowerCase().includes(text));
    }
    if (findRows.length) {
      if (currentIndex >= 0) findRows[currentIndex].classList.remove('search-match');
      currentIndex = (currentIndex + 1) % findRows.length;
      const row = findRows[currentIndex];
      setGroupCollapsed(row.dataset.group, false);
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.remove('search-match');
      void row.offsetWidth;
      row.classList.add('search-match');
      clearTimeout(searchHighlightTimer);
      searchHighlightTimer = setTimeout(() => row.classList.remove('search-match'), 1800);
    }
  } else if (event.key !== 'Escape') clearFind();
}

function clearFind() {
  clearTimeout(searchHighlightTimer);
  if (currentIndex >= 0 && findRows[currentIndex]) findRows[currentIndex].classList.remove('search-match');
  findRows = [];
  currentIndex = -1;
}

document.getElementById('pending-toggle').addEventListener('click', () => setGroupCollapsed('pending', !groupCollapsed.pending));
document.getElementById('downloaded-toggle').addEventListener('click', () => setGroupCollapsed('downloaded', !groupCollapsed.downloaded));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') clearFind();
});
