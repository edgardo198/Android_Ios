export function nextUploadProgress(event, previous = {}) {
  const reportedLoaded = Number(event?.loaded);
  const loaded = Math.max(previous.loaded || 0, Number.isFinite(reportedLoaded) ? Math.max(0, reportedLoaded) : 0);
  const reportedTotal = Number(event?.total);
  const total = Number.isFinite(reportedTotal) && reportedTotal > 0 ? reportedTotal : previous.total || null;
  const percent = total ? Math.min(100, Math.floor((loaded / total) * 100)) : undefined;
  const complete = total && loaded >= total;
  return { phase: complete ? 'processing' : 'uploading', loaded, total, ...(percent !== undefined ? { percent } : {}) };
}
