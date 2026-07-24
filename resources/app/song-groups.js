(function exposeSongGroups(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SongGroups = api;
})(typeof window === 'undefined' ? globalThis : window, function createSongGroups() {
  function normalizeId(song) {
    return String(typeof song === 'object' ? song.cid : song);
  }

  function partitionSongs(songs, downloadedIds) {
    const downloaded = downloadedIds instanceof Set ? downloadedIds : new Set(downloadedIds || []);
    return songs.reduce((groups, song) => {
      groups[downloaded.has(normalizeId(song)) ? 'downloaded' : 'pending'].push(song);
      return groups;
    }, { pending: [], downloaded: [] });
  }

  return { normalizeId, partitionSongs };
});
