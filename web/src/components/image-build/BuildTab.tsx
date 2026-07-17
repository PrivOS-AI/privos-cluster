import { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Loader2,
  Play,
  RefreshCw,
  FileText,
  Clock,
  AlertCircle,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Trash2,
  Sparkles,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, getStoredToken } from '@/lib/api';
import { formatRelativeTime, formatBytes } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import type {
  BuildRequest,
  BuildHistoryItem,
  BuildTemplate,
  ValidationError,
  BuildLogEntry,
} from '@/types/image-build';

interface BuildTabProps {
  onBuildSuccess?: (imageName: string, tag: string) => void;
}

const defaultDockerfile = `# Use an official Node.js runtime as the base image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Define the command to run the application
CMD ["npm", "start"]
`;

const defaultBuildForm: BuildRequest = {
  dockerfile: defaultDockerfile,
  imageName: 'my-app',
  tag: 'latest',
  buildArgs: {},
  context: '.',
  description: '',
};

export function BuildTab({ onBuildSuccess }: BuildTabProps) {
  const queryClient = useQueryClient();
  const [buildForm, setBuildForm] = useState<BuildRequest>(defaultBuildForm);
  const [activeBuildId, setActiveBuildId] = useState<string | null>(null);
  const [buildLogs, setBuildLogs] = useState<BuildLogEntry[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState<'all' | 'success' | 'failed'>('all');

  const eventSourceRef = useRef<EventSource | null>(null);
  const buildLogsEndRef = useRef<HTMLDivElement>(null);
  const dockerfileInputRef = useRef<HTMLInputElement>(null);

  async function handleDockerfileImport(file: File | undefined | null) {
    if (!file) return;
    if (file.size > 1024 * 1024) {
      toast.error('Dockerfile is too large (max 1 MB)');
      return;
    }
    try {
      const text = await file.text();
      setBuildForm((prev) => ({ ...prev, dockerfile: text }));
      // Suggest image name from file naming convention "<name>.Dockerfile"
      const dotMatch = /^([\w.-]+?)\.dockerfile$/i.exec(file.name);
      if (dotMatch && dotMatch[1]) {
        setBuildForm((prev) => ({ ...prev, imageName: dotMatch[1].toLowerCase() }));
      }
      toast.success(`Imported ${file.name}`);
    } catch (err) {
      toast.error(`Failed to read file: ${(err as Error).message}`);
    }
  }

  // Fetch build templates
  const templatesQuery = useQuery({
    queryKey: ['image-templates'],
    queryFn: () => api.get<BuildTemplate[]>('/api/v1/images/build/templates').then((r) => r.data),
  });

  // Fetch build history
  const historyQuery = useQuery({
    queryKey: ['build-history', historyFilter],
    queryFn: () =>
      api
        .get<BuildHistoryItem[]>('/api/v1/images/builds', {
          params: {
            status: historyFilter === 'all' ? undefined : historyFilter,
            limit: 20,
          },
        })
        .then((r) => r.data),
    refetchInterval: 10_000,
  });

  // Build mutation
  const buildMutation = useMutation({
    mutationFn: async (data: BuildRequest) => {
      const response = await fetch('/api/v1/images/build', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${getStoredToken() ?? ''}`,
        },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        let message = `Build failed (${response.status})`;
        try {
          const body = (await response.json()) as { error?: string; reason?: string };
          message = body.reason ? `${body.error}: ${body.reason}` : body.error ?? message;
        } catch {
          // fall back to generic text
        }
        throw new Error(message);
      }

      const text = await response.text();
      let buildId: string | null = null;

      for (const block of text.split('\n\n')) {
        const line = block.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        const parsed = JSON.parse(payload) as {
          error?: string;
          buildId?: string;
          status?: string;
          message?: string;
          level?: string;
          timestamp?: number;
          step?: string;
        };

        if (parsed.error) throw new Error(parsed.error);
        if (parsed.buildId) buildId = parsed.buildId;

        // Handle streaming logs
        if (parsed.message && parsed.timestamp) {
          setBuildLogs((prev) => [
            ...prev,
            {
              timestamp: parsed.timestamp!,
              level: (parsed.level as 'info' | 'error' | 'warning') || 'info',
              message: parsed.message || '',
              step: parsed.step,
            },
          ]);
        }
      }

      if (!buildId) throw new Error('Build started but no build ID returned');
      return buildId;
    },
    onSuccess: (buildId) => {
      setActiveBuildId(buildId);
      toast.success('Build started successfully');
      void queryClient.invalidateQueries({ queryKey: ['build-history'] });
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      setBuildLogs([]);
    },
  });

  // Rebuild mutation
  const rebuildMutation = useMutation({
    mutationFn: async (buildItem: BuildHistoryItem) => {
      if (!buildItem.dockerfile) {
        throw new Error('Cannot rebuild: Dockerfile not available');
      }

      const response = await fetch('/api/v1/images/build', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${getStoredToken() ?? ''}`,
        },
        body: JSON.stringify({
          dockerfile: buildItem.dockerfile,
          imageName: buildItem.imageName,
          tag: buildItem.tag,
          description: buildItem.description,
        }),
      });

      if (!response.ok) {
        throw new Error('Rebuild failed');
      }

      const text = await response.text();
      let newBuildId: string | null = null;

      for (const block of text.split('\n\n')) {
        const line = block.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        const parsed = JSON.parse(payload);
        if (parsed.buildId) newBuildId = parsed.buildId;
      }

      return newBuildId;
    },
    onSuccess: (buildId) => {
      setActiveBuildId(buildId);
      toast.success('Rebuild started');
      void queryClient.invalidateQueries({ queryKey: ['build-history'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // Delete build mutation
  const deleteBuildMutation = useMutation({
    mutationFn: async (buildId: string) => {
      await api.delete(`/api/v1/images/builds/${buildId}`);
      return buildId;
    },
    onSuccess: () => {
      toast.success('Build deleted');
      void queryClient.invalidateQueries({ queryKey: ['build-history'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // Validate Dockerfile mutation
  const validateMutation = useMutation({
    mutationFn: async (dockerfile: string) => {
      const res = await api.post<ValidationError[]>('/api/v1/images/build/validate', { dockerfile });
      return res.data;
    },
  });

  // SSE connection for build progress
  useEffect(() => {
    if (!activeBuildId) return;

    const eventSource = new EventSource(
      `/api/v1/images/build/${activeBuildId}/logs?token=${getStoredToken() ?? ''}`
    );

    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          status?: string;
          message?: string;
          level?: string;
          timestamp?: number;
          step?: string;
          error?: string;
          completed?: boolean;
          imageId?: string;
        };

        if (data.status) {
          // Build status update
          if (data.status === 'success') {
            toast.success('Build completed successfully!');
            setActiveBuildId(null);
            if (onBuildSuccess && data.imageId) {
              onBuildSuccess(buildForm.imageName, buildForm.tag);
            }
            setBuildForm(defaultBuildForm);
            void queryClient.invalidateQueries({ queryKey: ['build-history'] });
            void queryClient.invalidateQueries({ queryKey: ['images'] });
          } else if (data.status === 'failed') {
            toast.error(data.error || 'Build failed');
            setActiveBuildId(null);
          }
        }

        if (data.message && data.timestamp) {
          // Log entry
          setBuildLogs((prev) => [
            ...prev,
            {
              timestamp: data.timestamp!,
              level: (data.level as 'info' | 'error' | 'warning') || 'info',
              message: data.message || '',
              step: data.step,
            },
          ]);
        }

        if (data.completed) {
          eventSource.close();
        }
      } catch (err) {
        console.error('Failed to parse SSE data:', err);
      }
    };

    eventSource.onerror = (err) => {
      console.error('SSE error:', err);
      eventSource.close();
      setActiveBuildId(null);
    };

    return () => {
      eventSource.close();
    };
  }, [activeBuildId, buildForm.imageName, buildForm.tag, onBuildSuccess, queryClient]);

  // Auto-scroll build logs
  useEffect(() => {
    if (buildLogsEndRef.current) {
      buildLogsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [buildLogs]);

  // Apply template
  const applyTemplate = (template: BuildTemplate) => {
    setBuildForm({
      ...buildForm,
      dockerfile: template.dockerfile,
      imageName: template.defaultImageName,
      tag: template.defaultTag,
    });
    setShowTemplates(false);
  };

  // Handle build
  const handleBuild = () => {
    if (!buildForm.dockerfile.trim()) {
      toast.error('Dockerfile cannot be empty');
      return;
    }
    if (!buildForm.imageName.trim()) {
      toast.error('Image name is required');
      return;
    }

    setBuildLogs([]);
    buildMutation.mutate(buildForm);
  };

  // Handle template selection
  const handleTemplateSelect = (templateId: string) => {
    const template = templatesQuery.data?.find((t) => t.id === templateId);
    if (template) {
      applyTemplate(template);
    }
  };

  const templates = templatesQuery.data ?? [];
  const buildHistory = historyQuery.data ?? [];
  const filteredHistory = buildHistory.filter((item) => {
    if (historyFilter === 'all') return true;
    return item.status === historyFilter;
  });

  return (
    <div className="space-y-6">
      {/* Build Form */}
      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Build Docker Image</CardTitle>
                  <CardDescription>Create Docker images from Dockerfiles</CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowTemplates(!showTemplates)}
                  className="gap-2"
                >
                  <Sparkles className="h-4 w-4" />
                  Templates
                  {showTemplates ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Template Selector */}
              {showTemplates && templates.length > 0 && (
                <div className="mb-4 space-y-3">
                  <Label>Quick Start Templates</Label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {templates.map((template) => (
                      <Card
                        key={template.id}
                        className="cursor-pointer transition-colors hover:bg-accent/40"
                        onClick={() => handleTemplateSelect(template.id)}
                      >
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm">{template.name}</CardTitle>
                          <CardDescription className="text-xs">{template.description}</CardDescription>
                        </CardHeader>
                      </Card>
                    ))}
                  </div>
                </div>
              )}

              {/* Dockerfile Editor */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Dockerfile</Label>
                  <div className="flex items-center gap-1">
                    <input
                      ref={dockerfileInputRef}
                      type="file"
                      accept=".dockerfile,.Dockerfile,Dockerfile,.txt,text/plain"
                      className="hidden"
                      onChange={(e) => {
                        handleDockerfileImport(e.target.files?.[0]);
                        if (dockerfileInputRef.current) dockerfileInputRef.current.value = '';
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => dockerfileInputRef.current?.click()}
                    >
                      <Upload className="h-4 w-4" />
                      Import
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => validateMutation.mutate(buildForm.dockerfile)}
                      disabled={validateMutation.isPending}
                    >
                      <FileText className="h-4 w-4" />
                      Validate
                    </Button>
                  </div>
                </div>
                <Textarea
                  value={buildForm.dockerfile}
                  onChange={(e) => setBuildForm({ ...buildForm, dockerfile: e.target.value })}
                  className="min-h-[300px] font-mono text-sm"
                  placeholder="Enter your Dockerfile here..."
                />
                {validateMutation.data && validateMutation.data.length > 0 && (
                  <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                      <AlertCircle className="h-4 w-4" />
                      Validation Errors
                    </div>
                    <ul className="mt-2 space-y-1 text-xs">
                      {validateMutation.data.map((err, i) => (
                        <li key={i} className="text-destructive">
                          Line {err.line}: {err.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Image Configuration */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Image Name</Label>
                  <Input
                    value={buildForm.imageName}
                    onChange={(e) => setBuildForm({ ...buildForm, imageName: e.target.value })}
                    placeholder="my-app"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Tag</Label>
                  <Input
                    value={buildForm.tag}
                    onChange={(e) => setBuildForm({ ...buildForm, tag: e.target.value })}
                    placeholder="latest"
                  />
                </div>
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label>Description (Optional)</Label>
                <Input
                  value={buildForm.description}
                  onChange={(e) => setBuildForm({ ...buildForm, description: e.target.value })}
                  placeholder="Build description or notes..."
                />
              </div>

              {/* Build Button */}
              <Button
                className="w-full"
                onClick={handleBuild}
                disabled={buildMutation.isPending || !!activeBuildId}
              >
                {buildMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Starting Build...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4" />
                    Build Image
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Build Progress */}
          {(activeBuildId || buildLogs.length > 0) && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Build Progress
                    </CardTitle>
                    <CardDescription>
                      Building {buildForm.imageName}:{buildForm.tag}
                    </CardDescription>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setBuildLogs([])}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {activeBuildId ? 'Build in progress...' : 'Build completed'}
                    </span>
                    <span className="font-medium">{buildLogs.length} log entries</span>
                  </div>
                  <div className="rounded-md border bg-black p-4">
                    <div className="max-h-[300px] space-y-1 overflow-y-auto font-mono text-xs text-white">
                      {buildLogs.map((log, index) => (
                        <div key={index} className="flex gap-2">
                          <span className="text-muted-foreground">
                            [{new Date(log.timestamp).toLocaleTimeString()}]
                          </span>
                          <span
                            className={
                              log.level === 'error'
                                ? 'text-red-400'
                                : log.level === 'warning'
                                  ? 'text-yellow-400'
                                  : 'text-white'
                            }
                          >
                            {log.step && `[${log.step}] `}
                            {log.message}
                          </span>
                        </div>
                      ))}
                      <div ref={buildLogsEndRef} />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Build History */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Build History</CardTitle>
                  <CardDescription>Recent build attempts</CardDescription>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => historyQuery.refetch()}
                  disabled={historyQuery.isPending}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* History Filters */}
              <div className="flex items-center gap-2">
                {(['all', 'success', 'failed'] as const).map((filter) => (
                  <Button
                    key={filter}
                    variant={historyFilter === filter ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => setHistoryFilter(filter)}
                  >
                    {filter}
                  </Button>
                ))}
              </div>

              {/* History List */}
              {historyQuery.isLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading build history...
                </div>
              )}

              {!historyQuery.isLoading && filteredHistory.length === 0 && (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No build history found
                </div>
              )}

              {filteredHistory.map((build) => (
                <div key={build.buildId} className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setExpandedHistoryId(expandedHistoryId === build.buildId ? null : build.buildId)}
                    className="w-full rounded-lg border p-3 text-left transition-colors hover:bg-accent/40"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{build.imageName}</span>
                          <span className="rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase">
                            {build.tag}
                          </span>
                          <StatusBadge status={build.status} />
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatRelativeTime(build.startedAt)}
                          <span>·</span>
                          <span>by {build.builtBy}</span>
                          {build.duration && (
                            <>
                              <span>·</span>
                              <span>{Math.round(build.duration / 1000)}s</span>
                            </>
                          )}
                        </div>
                      </div>
                      {expandedHistoryId === build.buildId ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>

                    {expandedHistoryId === build.buildId && (
                      <div className="mt-3 space-y-3">
                        <Separator />

                        {build.description && (
                          <p className="text-sm text-muted-foreground">{build.description}</p>
                        )}

                        {build.error && (
                          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                            <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                              <AlertCircle className="h-4 w-4" />
                              Build Error
                            </div>
                            <p className="mt-1 text-xs text-destructive">{build.error}</p>
                          </div>
                        )}

                        {build.sizeBytes && (
                          <div className="text-sm">
                            <span className="text-muted-foreground">Image Size:</span>{' '}
                            <span className="font-medium">{formatBytes(build.sizeBytes)}</span>
                          </div>
                        )}

                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              rebuildMutation.mutate(build);
                            }}
                            disabled={rebuildMutation.isPending}
                          >
                            <RefreshCw className="h-4 w-4" />
                            Rebuild
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (build.dockerfile) {
                                navigator.clipboard.writeText(build.dockerfile);
                                toast.success('Dockerfile copied to clipboard');
                              }
                            }}
                          >
                            <Copy className="h-4 w-4" />
                            Copy Dockerfile
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (window.confirm('Delete this build record?')) {
                                deleteBuildMutation.mutate(build.buildId);
                              }
                            }}
                            disabled={deleteBuildMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </button>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: BuildHistoryItem['status'] }) {
  switch (status) {
    case 'success':
      return (
        <span className="flex items-center gap-1 rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-700">
          <CheckCircle2 className="h-3 w-3" />
          Success
        </span>
      );
    case 'failed':
      return (
        <span className="flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-700">
          <XCircle className="h-3 w-3" />
          Failed
        </span>
      );
    case 'cancelled':
      return (
        <span className="flex items-center gap-1 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-[11px] font-medium text-yellow-700">
          <AlertCircle className="h-3 w-3" />
          Cancelled
        </span>
      );
    default:
      return null;
  }
}
