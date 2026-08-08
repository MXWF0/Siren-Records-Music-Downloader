window.ifdelwav = true;
window.ifsdir = true;
window.songs = {};
window.albums = {};
window.songOrder = [];

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

async function initData() {
  try {
    const [albumsPayload, songsPayload, state, settings] = await Promise.all([
      fetchJson('https://monster-siren.hypergryph.com/api/albums'),
      fetchJson('https://monster-siren.hypergryph.com/api/songs'),
      window.electronAPI.getDownloadState(),
      window.electronAPI.getSettings()
    ]);
    for (const album of albumsPayload.data || []) window.albums[String(album.cid)] = album;
    for (const song of songsPayload.data?.list || []) {
      const id = String(song.cid);
      window.songs[id] = song;
      window.songOrder.push(song);
    }
    window.setDownloadedState(state.downloaded || []);
    window.applyInitialSettings(settings);
    window.catalogReady = true;
    window.renderSongList();
  } catch (error) {
    console.error('Unable to load music catalogue:', error);
    document.getElementById('d_status').innerText = '歌曲目录加载失败，请检查网络后重试';
  }
}

setTimeout(initData, 0);
