import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowsClockwise,
  CaretRight,
  File as FileIcon,
  Folder,
  FolderOpen,
} from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo/components/button";
import { api, type WorkspaceEntry } from "../api";
import { CopyButton } from "./CopyButton";
import { useToasts } from "../toasts";

// Browse the Isolate Sandbox's SQLite-backed workspace. Two-pane layout:
// directory listing on the left, file preview on the right. Directories
// navigate by replacing the active path; files open in the preview pane
// without leaving the page.
export function WorkspaceBrowser({ sessionId }: { sessionId: string }) {
  const { push } = useToasts();
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [info, setInfo] = useState<{
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
    r2FileCount: number;
  } | null>(null);

  const [selectedFile, setSelectedFile] = useState<WorkspaceEntry | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [loadingFile, setLoadingFile] = useState(false);

  const loadList = useCallback(
    async (target: string) => {
      setLoadingList(true);
      try {
        const data = await api.workspaceList(sessionId, target);
        setEntries(data.entries);
      } catch (err) {
        push((err as Error).message, "error");
      } finally {
        setLoadingList(false);
      }
    },
    [sessionId, push],
  );

  const loadInfo = useCallback(async () => {
    try {
      setInfo(await api.workspaceInfo(sessionId));
    } catch {
      // Info is optional — failure leaves the header summary blank.
    }
  }, [sessionId]);

  useEffect(() => {
    loadList(path);
  }, [loadList, path]);

  useEffect(() => {
    loadInfo();
  }, [loadInfo]);

  const openEntry = (entry: WorkspaceEntry) => {
    if (entry.type === "directory") {
      setPath(entry.path);
      setSelectedFile(null);
      setFileContent("");
      return;
    }
    if (entry.type === "file") {
      setSelectedFile(entry);
      setLoadingFile(true);
      api
        .workspaceFile(sessionId, entry.path)
        .then((res) => setFileContent(res.content))
        .catch((err) => push((err as Error).message, "error"))
        .finally(() => setLoadingFile(false));
    }
  };

  const refresh = () => {
    loadList(path);
    loadInfo();
    if (selectedFile) {
      setLoadingFile(true);
      api
        .workspaceFile(sessionId, selectedFile.path)
        .then((res) => setFileContent(res.content))
        .catch((err) => push((err as Error).message, "error"))
        .finally(() => setLoadingFile(false));
    }
  };

  // Build breadcrumb segments from the active path. Each segment links to
  // its absolute path so users can hop directly to a parent.
  const crumbs = useMemo(() => {
    const parts = path.split("/").filter(Boolean);
    const out: Array<{ label: string; path: string }> = [{ label: "/", path: "/" }];
    let acc = "";
    for (const part of parts) {
      acc += `/${part}`;
      out.push({ label: part, path: acc });
    }
    return out;
  }, [path]);

  // Sort directories first, then files, each alphabetically — same shape
  // most file browsers use so users don't have to scan a mixed list.
  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => {
      if (a.type !== b.type) {
        if (a.type === "directory") return -1;
        if (b.type === "directory") return 1;
      }
      return a.name.localeCompare(b.name);
    });
  }, [entries]);

  return (
    <div className="workspace-browser">
      <div className="workspace-toolbar">
        <div className="workspace-crumbs mono">
          {crumbs.map((crumb, i) => (
            <span key={crumb.path} className="workspace-crumb-row">
              {i > 0 && <CaretRight size={12} weight="regular" className="muted" />}
              {i === crumbs.length - 1 ? (
                <span className="workspace-crumb-current">{crumb.label}</span>
              ) : (
                <button
                  className="workspace-crumb-link"
                  onClick={() => setPath(crumb.path)}
                  type="button"
                >
                  {crumb.label}
                </button>
              )}
            </span>
          ))}
        </div>
        <div className="workspace-summary muted">
          {info ? (
            <>
              {info.fileCount} files · {info.directoryCount} dirs ·{" "}
              {formatBytes(info.totalBytes)}
            </>
          ) : (
            <>—</>
          )}
        </div>
        <Button variant="ghost" size="sm" icon={ArrowsClockwise} onClick={refresh}>
          Refresh
        </Button>
      </div>

      <div className="workspace-panes">
        <div className="workspace-list">
          {loadingList && entries.length === 0 ? (
            <div className="empty-state">Loading...</div>
          ) : sortedEntries.length === 0 ? (
            <div className="empty-state">Empty directory</div>
          ) : (
            <ul className="workspace-entries">
              {sortedEntries.map((entry) => {
                const isSelected = selectedFile?.path === entry.path;
                const Icon =
                  entry.type === "directory" ? Folder : entry.type === "symlink" ? FolderOpen : FileIcon;
                return (
                  <li key={entry.path}>
                    <button
                      className={`workspace-entry ${isSelected ? "selected" : ""}`}
                      onClick={() => openEntry(entry)}
                      type="button"
                    >
                      <Icon size={14} weight="regular" className="workspace-entry-icon" />
                      <span className="workspace-entry-name">{entry.name}</span>
                      {entry.type === "file" && (
                        <span className="workspace-entry-size muted">
                          {formatBytes(entry.size)}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="workspace-preview">
          {selectedFile ? (
            <>
              <div className="workspace-preview-header">
                <div className="workspace-preview-meta">
                  <strong className="mono">{selectedFile.name}</strong>
                  <span className="muted" style={{ fontSize: "0.75rem" }}>
                    {selectedFile.mimeType || "application/octet-stream"} ·{" "}
                    {formatBytes(selectedFile.size)}
                  </span>
                </div>
                <CopyButton
                  compact
                  text={() => fileContent}
                  label="Copy"
                  copiedLabel="Copied"
                  title="Copy file contents"
                />
              </div>
              {loadingFile ? (
                <div className="empty-state">Loading...</div>
              ) : (
                <pre className="workspace-preview-body">{fileContent || "(empty file)"}</pre>
              )}
            </>
          ) : (
            <div className="empty-state workspace-preview-empty">
              Select a file to preview its contents.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Compact byte formatter — same convention the rest of the dashboard uses
// (1 decimal place, K/M/G powers of 1024).
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
