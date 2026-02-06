'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Upload,
  Mail,
  FileText,
  CheckCircle,
  XCircle,
  Clock,
  Trash2,
  Eye,
  EyeOff,
  RefreshCw,
  AlertCircle,
  File,
  X,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

function getAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem('auth_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface EmailSource {
  id: string;
  name: string;
  email_address: string | null;
  source_type: 'gmail' | 'outlook' | 'mbox' | 'pst' | 'api';
  file_name: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  emails_total: number;
  emails_processed: number;
  emails_failed: number;
  is_included_in_search: boolean;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export default function ImportPage() {
  const [sources, setSources] = useState<EmailSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    status: 'idle' | 'parsing' | 'uploading' | 'complete' | 'error';
    fileName?: string;
    total?: number;
    processed?: number;
    chunksTotal?: number;
    chunksProcessed?: number;
    error?: string;
  }>({ status: 'idle' });

  const fetchSources = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/sources`, {
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      setSources(data.sources || []);
    } catch (e) {
      console.error('Failed to fetch sources:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  useEffect(() => {
    fetchSources();
    const interval = setInterval(() => {
      if (sourcesRef.current.some(s => s.status === 'processing')) {
        fetchSources();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchSources]);

  const toggleIncluded = async (source: EmailSource) => {
    try {
      await fetch(`${API_URL}/api/sources/${source.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ is_included_in_search: !source.is_included_in_search }),
      });
      fetchSources();
    } catch (e) {
      console.error('Failed to toggle source:', e);
    }
  };

  const deleteSource = async (source: EmailSource) => {
    if (!confirm(`Delete "${source.name}" and all its emails? This cannot be undone.`)) {
      return;
    }
    try {
      await fetch(`${API_URL}/api/sources/${source.id}`, { method: 'DELETE', headers: getAuthHeaders() });
      fetchSources();
    } catch (e) {
      console.error('Failed to delete source:', e);
    }
  };

  const handleFileUpload = async (file: File, sourceName: string, emailAddress: string) => {
    const fileExt = file.name.split('.').pop()?.toLowerCase();

    if (fileExt === 'pst') {
      setUploadProgress({
        status: 'error',
        fileName: file.name,
        error: 'PST files require the CLI script:\n\npython3 scripts/ingest_pst.py /path/to/file.pst --api-url ' + API_URL,
      });
      return;
    }

    if (fileExt !== 'mbox') {
      setUploadProgress({
        status: 'error',
        fileName: file.name,
        error: 'Please select an .mbox file (from Gmail Takeout) or .pst file (from Outlook)',
      });
      return;
    }

    setUploadProgress({ status: 'uploading', fileName: file.name });
    console.log('[Upload] Starting upload for:', file.name, 'size:', file.size);

    try {
      // Create source first
      console.log('[Upload] Creating source...');
      const sourceRes = await fetch(`${API_URL}/api/sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          name: sourceName || file.name.replace('.mbox', ''),
          email_address: emailAddress || null,
          source_type: 'mbox',
          file_name: file.name,
        }),
      });

      console.log('[Upload] Source response status:', sourceRes.status);
      if (!sourceRes.ok) {
        const errorText = await sourceRes.text();
        console.error('[Upload] Source creation failed:', errorText);
        throw new Error('Failed to create source: ' + errorText);
      }

      const source = await sourceRes.json();
      console.log('[Upload] Source created:', source.id);

      // Upload file in chunks.
      // - Workers requests have an upper size limit
      // - KV values max out at 25MB, so keep chunks well under that
      const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB chunks
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      console.log('[Upload] File size:', file.size, 'Total chunks:', totalChunks);

      setUploadProgress({
        status: 'uploading',
        fileName: file.name,
        chunksTotal: totalChunks,
        chunksProcessed: 0,
      });

      // Upload chunks with concurrency (4 at a time)
      const CONCURRENCY = 4;
      let completedChunks = 0;

      const uploadChunk = async (chunkIdx: number) => {
        const start = chunkIdx * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const formData = new FormData();
        formData.append('file', chunk, file.name);
        formData.append('chunkIndex', chunkIdx.toString());
        formData.append('totalChunks', totalChunks.toString());

        const uploadRes = await fetch(`${API_URL}/api/sources/${source.id}/upload-chunk`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: formData,
        });

        if (!uploadRes.ok) {
          const errorText = await uploadRes.text();
          throw new Error(`Chunk ${chunkIdx + 1} upload failed: ${errorText}`);
        }

        completedChunks++;
        setUploadProgress(prev => ({
          ...prev,
          chunksProcessed: completedChunks,
        }));
      };

      // Process chunks in parallel batches
      for (let i = 0; i < totalChunks; i += CONCURRENCY) {
        const batch = [];
        for (let j = i; j < Math.min(i + CONCURRENCY, totalChunks); j++) {
          batch.push(uploadChunk(j));
        }
        await Promise.all(batch);
      }

      // Signal upload complete, start processing
      console.log('[Upload] All chunks uploaded, starting processing...');
      const processRes = await fetch(`${API_URL}/api/sources/${source.id}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ totalChunks }),
      });

      if (!processRes.ok) {
        const errorText = await processRes.text();
        console.error('[Upload] Process start failed:', errorText);
        throw new Error('Failed to start processing: ' + errorText);
      }

      const processResult = await processRes.json();
      console.log('[Upload] Processing started:', processResult);

      // Upload complete - server is now processing in background
      setUploadProgress({
        status: 'complete',
        fileName: file.name,
      });

      // Refresh sources to show processing status
      fetchSources();

    } catch (e) {
      console.error('[Upload] Error:', e);
      setUploadProgress({
        status: 'error',
        fileName: file.name,
        error: e instanceof Error ? e.message : 'Failed to process file',
      });
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Import Emails</h1>
          <p className="text-gray-600">
            Import email archives from Gmail or Outlook. Toggle sources on/off to control search scope.
          </p>
        </div>
        <button
          onClick={() => setShowUpload(true)}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 flex items-center gap-2"
        >
          <Upload className="h-4 w-4" />
          Import File
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Total Sources"
          value={sources.length.toString()}
          icon={<FileText className="h-5 w-5 text-blue-600" />}
        />
        <StatCard
          label="Active Sources"
          value={sources.filter(s => s.is_included_in_search).length.toString()}
          icon={<Eye className="h-5 w-5 text-green-600" />}
        />
        <StatCard
          label="Total Emails"
          value={sources.reduce((acc, s) => acc + s.emails_processed, 0).toLocaleString()}
          icon={<Mail className="h-5 w-5 text-purple-600" />}
        />
        <StatCard
          label="Processing"
          value={sources.filter(s => s.status === 'processing').length.toString()}
          icon={<RefreshCw className="h-5 w-5 text-orange-600" />}
        />
      </div>

      {/* Upload Progress */}
      {uploadProgress.status !== 'idle' && (
        <UploadProgressCard
          progress={uploadProgress}
          onClose={() => setUploadProgress({ status: 'idle' })}
        />
      )}

      {/* Sources List */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading sources...</div>
      ) : sources.length === 0 && uploadProgress.status === 'idle' ? (
        <EmptyState onAddNew={() => setShowUpload(true)} />
      ) : (
        <div className="space-y-4">
          {sources.map((source) => (
            <SourceCard
              key={source.id}
              source={source}
              onToggle={() => toggleIncluded(source)}
              onDelete={() => deleteSource(source)}
            />
          ))}
        </div>
      )}

      {/* Upload Modal */}
      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onUpload={handleFileUpload}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 flex items-center gap-4">
      <div className="p-2 bg-gray-50 rounded-lg">{icon}</div>
      <div>
        <div className="text-sm text-gray-500">{label}</div>
        <div className="text-2xl font-bold text-gray-900">{value}</div>
      </div>
    </div>
  );
}

function UploadProgressCard({
  progress,
  onClose,
}: {
  progress: {
    status: string;
    fileName?: string;
    total?: number;
    processed?: number;
    chunksTotal?: number;
    chunksProcessed?: number;
    error?: string;
  };
  onClose: () => void;
}) {
  const chunkPercentage = progress.chunksTotal
    ? Math.round((progress.chunksProcessed || 0) / progress.chunksTotal * 100)
    : 0;
  const emailPercentage = progress.total ? Math.round((progress.processed || 0) / progress.total * 100) : 0;

  return (
    <div className={`mb-6 p-4 rounded-lg border ${
      progress.status === 'error' ? 'bg-red-50 border-red-200' :
      progress.status === 'complete' ? 'bg-green-50 border-green-200' :
      'bg-blue-50 border-blue-200'
    }`}>
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          {progress.status === 'parsing' && <RefreshCw className="h-5 w-5 text-blue-600 animate-spin mt-0.5" />}
          {progress.status === 'uploading' && <RefreshCw className="h-5 w-5 text-blue-600 animate-spin mt-0.5" />}
          {progress.status === 'complete' && <CheckCircle className="h-5 w-5 text-green-600 mt-0.5" />}
          {progress.status === 'error' && <XCircle className="h-5 w-5 text-red-600 mt-0.5" />}
          <div>
            <div className="font-medium text-gray-900">
              {progress.status === 'parsing' && `Parsing ${progress.fileName}...`}
              {progress.status === 'uploading' && `Importing ${progress.fileName}...`}
              {progress.status === 'complete' && `Import complete!`}
              {progress.status === 'error' && `Import failed`}
            </div>
            {progress.status === 'uploading' && progress.chunksTotal && (
              <div className="text-sm text-gray-600 mt-1">
                <span className="font-medium">Reading file:</span> {progress.chunksProcessed} / {progress.chunksTotal} chunks ({chunkPercentage}%)
                {(progress.total ?? 0) > 0 && (
                  <span className="ml-3">
                    <span className="font-medium">Uploaded:</span> {progress.processed?.toLocaleString()} / {progress.total?.toLocaleString()} emails
                  </span>
                )}
              </div>
            )}
            {progress.status === 'complete' && (
              <div className="text-sm text-green-700 mt-1">
                Successfully imported {progress.processed?.toLocaleString()} emails from {progress.fileName}
              </div>
            )}
            {progress.status === 'error' && (
              <div className="text-sm text-red-700 mt-1 whitespace-pre-wrap">{progress.error}</div>
            )}
          </div>
        </div>
        {(progress.status === 'complete' || progress.status === 'error') && (
          <button onClick={onClose} className="p-1 hover:bg-white/50 rounded">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {progress.status === 'uploading' && progress.chunksTotal && (
        <div className="mt-3 h-2 bg-white rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all duration-300"
            style={{ width: `${chunkPercentage}%` }}
          />
        </div>
      )}
    </div>
  );
}

function EmptyState({ onAddNew }: { onAddNew: () => void }) {
  return (
    <div className="text-center py-16 bg-white rounded-lg border border-gray-200">
      <Upload className="h-12 w-12 text-gray-300 mx-auto mb-4" />
      <h3 className="text-lg font-medium text-gray-900 mb-2">No email sources yet</h3>
      <p className="text-gray-600 mb-6 max-w-md mx-auto">
        Import your email archives from Gmail (MBOX) or Outlook (PST) to start searching.
      </p>
      <button
        onClick={onAddNew}
        className="px-6 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
      >
        Import Your First File
      </button>

      <div className="mt-8 pt-8 border-t border-gray-100 max-w-2xl mx-auto">
        <h4 className="text-sm font-medium text-gray-700 mb-4">How to export your emails:</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-left">
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="font-medium text-gray-900 mb-2 flex items-center gap-2">
              <span className="text-red-500">Gmail</span>
              <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">Drag & Drop</span>
            </div>
            <ol className="text-sm text-gray-600 space-y-1 list-decimal list-inside">
              <li>Go to takeout.google.com</li>
              <li>Deselect all, then select only "Mail"</li>
              <li>Click "All Mail data included"</li>
              <li>Select MBOX format</li>
              <li>Export, download, and drag here</li>
            </ol>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="font-medium text-gray-900 mb-2 flex items-center gap-2">
              <span className="text-blue-500">Outlook</span>
              <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded">CLI Required</span>
            </div>
            <ol className="text-sm text-gray-600 space-y-1 list-decimal list-inside">
              <li>Open Outlook desktop app</li>
              <li>File → Open & Export → Import/Export</li>
              <li>Export to Outlook Data File (.pst)</li>
              <li>Run CLI: <code className="bg-gray-200 px-1 rounded text-xs">python3 scripts/ingest_pst.py file.pst</code></li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

function SourceCard({
  source,
  onToggle,
  onDelete,
}: {
  source: EmailSource;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const statusColors = {
    pending: 'bg-gray-100 text-gray-700',
    processing: 'bg-yellow-100 text-yellow-700',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
  };

  const statusIcons = {
    pending: <Clock className="h-4 w-4" />,
    processing: <RefreshCw className="h-4 w-4 animate-spin" />,
    completed: <CheckCircle className="h-4 w-4" />,
    failed: <XCircle className="h-4 w-4" />,
  };

  const progress = source.emails_total > 0
    ? Math.round((source.emails_processed / source.emails_total) * 100)
    : 0;

  return (
    <div className={`bg-white rounded-lg border p-4 ${
      source.is_included_in_search ? 'border-gray-200' : 'border-gray-100 opacity-60'
    }`}>
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-4">
          <div className={`p-2 rounded-lg ${
            source.source_type === 'gmail' || source.source_type === 'mbox'
              ? 'bg-red-50'
              : 'bg-blue-50'
          }`}>
            <Mail className={`h-6 w-6 ${
              source.source_type === 'gmail' || source.source_type === 'mbox'
                ? 'text-red-600'
                : 'text-blue-600'
            }`} />
          </div>
          <div>
            <h3 className="font-medium text-gray-900">{source.name}</h3>
            {source.email_address && (
              <p className="text-sm text-gray-500">{source.email_address}</p>
            )}
            <div className="flex items-center gap-3 mt-2">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${statusColors[source.status]}`}>
                {statusIcons[source.status]}
                {source.status}
              </span>
              <span className="text-xs text-gray-400">
                {source.source_type.toUpperCase()}
              </span>
              {source.file_name && (
                <span className="text-xs text-gray-400">
                  {source.file_name}
                </span>
              )}
              <span className="text-xs text-gray-400">
                {format(parseISO(source.created_at), 'MMM d, yyyy h:mm a')}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onToggle}
            className={`p-2 rounded-lg ${
              source.is_included_in_search
                ? 'bg-green-50 text-green-600 hover:bg-green-100'
                : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
            }`}
            title={source.is_included_in_search ? 'Included in search' : 'Excluded from search'}
          >
            {source.is_included_in_search ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
          </button>
          <button
            onClick={onDelete}
            className="p-2 rounded-lg bg-gray-50 text-gray-400 hover:bg-red-50 hover:text-red-600"
            title="Delete source"
          >
            <Trash2 className="h-5 w-5" />
          </button>
        </div>
      </div>

      {source.status === 'processing' && source.emails_total > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between text-sm text-gray-600 mb-1">
            <span>Importing emails...</span>
            <span>{source.emails_processed.toLocaleString()} / {source.emails_total.toLocaleString()}</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {source.status === 'completed' && (
        <div className="mt-4 flex items-center gap-6 text-sm">
          <span className="text-gray-600">
            <strong className="text-gray-900">{source.emails_processed.toLocaleString()}</strong> emails
          </span>
          {source.emails_failed > 0 && (
            <span className="text-red-600">
              <strong>{source.emails_failed.toLocaleString()}</strong> failed
            </span>
          )}
          {source.completed_at && (
            <span className="text-gray-400">
              Completed {format(parseISO(source.completed_at), 'MMM d, yyyy')}
            </span>
          )}
        </div>
      )}

      {source.status === 'failed' && source.error_message && (
        <div className="mt-4 p-3 bg-red-50 rounded-lg flex items-start gap-2">
          <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{source.error_message}</p>
        </div>
      )}
    </div>
  );
}

function UploadModal({
  onClose,
  onUpload,
}: {
  onClose: () => void;
  onUpload: (file: File, name: string, email: string) => void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      setSelectedFile(file);
      if (!name) {
        setName(file.name.replace(/\.(mbox|pst)$/i, ''));
      }
    }
  }, [name]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setSelectedFile(file);
      if (!name) {
        setName(file.name.replace(/\.(mbox|pst)$/i, ''));
      }
    }
  };

  const handleSubmit = () => {
    if (selectedFile) {
      onUpload(selectedFile, name, email);
      onClose();
    }
  };

  const fileExt = selectedFile?.name.split('.').pop()?.toLowerCase();

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full">
        <div className="p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Import Email Archive</h2>

          {/* Drop Zone */}
          <div
            className={`relative border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
              dragActive
                ? 'border-primary-500 bg-primary-50'
                : selectedFile
                ? 'border-green-500 bg-green-50'
                : 'border-gray-300 hover:border-gray-400'
            }`}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
            <label htmlFor="file-upload" className="sr-only">Choose email file</label>
            <input
              ref={fileInputRef}
              id="file-upload"
              name="file-upload"
              type="file"
              accept=".mbox,.pst"
              onChange={handleFileSelect}
              className="hidden"
            />

            {selectedFile ? (
              <div className="flex items-center justify-center gap-3">
                <File className={`h-10 w-10 ${fileExt === 'mbox' ? 'text-red-500' : 'text-blue-500'}`} />
                <div className="text-left">
                  <div className="font-medium text-gray-900">{selectedFile.name}</div>
                  <div className="text-sm text-gray-500">
                    {(selectedFile.size / 1024 / 1024).toFixed(1)} MB
                    {fileExt === 'pst' && (
                      <span className="ml-2 text-yellow-600">(CLI required)</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setSelectedFile(null)}
                  className="p-1 hover:bg-white rounded"
                >
                  <X className="h-5 w-5 text-gray-400" />
                </button>
              </div>
            ) : (
              <>
                <Upload className={`h-10 w-10 mx-auto mb-3 ${dragActive ? 'text-primary-500' : 'text-gray-400'}`} />
                <p className="text-gray-600 mb-2">
                  Drag and drop your email file here, or{' '}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="text-primary-600 hover:text-primary-700 font-medium"
                  >
                    browse
                  </button>
                </p>
                <p className="text-sm text-gray-400">
                  Supports .mbox (Gmail) and .pst (Outlook)
                </p>
              </>
            )}
          </div>

          {/* Name & Email Fields */}
          {selectedFile && (
            <div className="mt-4 space-y-4">
              <div>
                <label htmlFor="source-name" className="block text-sm font-medium text-gray-700 mb-1">
                  Display Name
                </label>
                <input
                  id="source-name"
                  name="source-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Work Gmail, Personal"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label htmlFor="source-email" className="block text-sm font-medium text-gray-700 mb-1">
                  Email Address (optional)
                </label>
                <input
                  id="source-email"
                  name="source-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="e.g., you@example.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>

              {fileExt === 'pst' && (
                <div className="p-3 bg-yellow-50 rounded-lg border border-yellow-200">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-5 w-5 text-yellow-600 flex-shrink-0 mt-0.5" />
                    <div className="text-sm text-yellow-800">
                      <p className="font-medium">PST files require CLI processing</p>
                      <p className="mt-1">After clicking Import, you'll need to run:</p>
                      <code className="block mt-2 p-2 bg-yellow-100 rounded text-xs">
                        python3 scripts/ingest_pst.py "{selectedFile.name}"
                      </code>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-6 py-4 bg-gray-50 rounded-b-lg flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!selectedFile}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {fileExt === 'pst' ? 'Create Source' : 'Start Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
