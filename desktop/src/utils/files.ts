export function safeFileName(value: string, fallback = "opcontroller_export") {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, "_")
      .slice(0, 80) || fallback
  );
}

export function downloadBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function downloadTextFile(fileName: string, content: string, type = "text/plain;charset=utf-8") {
  downloadBlob(fileName, new Blob([content], { type }));
}
