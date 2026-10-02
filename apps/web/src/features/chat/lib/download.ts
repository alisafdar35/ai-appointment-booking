/** Hand a generated file to the browser's download flow without a server round trip. */
export function downloadTextFile(fileName: string, content: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next task so the browser has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
