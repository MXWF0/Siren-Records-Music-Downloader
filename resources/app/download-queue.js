(function exposeDownloadQueue(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DownloadQueue = api;
})(typeof window === 'undefined' ? globalThis : window, function createDownloadQueue() {
  function createQueue(ids, downloadedIds, force) {
    const downloaded = downloadedIds instanceof Set ? downloadedIds : new Set(downloadedIds || []);
    const forceFor = force === 'downloaded'
      ? (id) => downloaded.has(id)
      : () => Boolean(force);
    return ids.map(String)
      .filter((id) => forceFor(id) || !downloaded.has(id))
      .map((id) => ({ id, force: forceFor(id) }));
  }
  return { createQueue };
});
