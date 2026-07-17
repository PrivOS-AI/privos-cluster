import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Activity, FileText, FolderOpen, Loader2, RefreshCw, Send, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, getStoredToken } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ContainerRecord, FileEntry } from './types';

type ContainerTab = 'logs' | 'files' | 'terminal' | 'dispatch';

const TABS: Array<{ id: ContainerTab; label: string; icon: typeof Activity }> = [
	{ id: 'logs', label: 'Logs', icon: Activity },
	{ id: 'files', label: 'Files', icon: FolderOpen },
	{ id: 'terminal', label: 'Terminal', icon: Terminal },
	{ id: 'dispatch', label: 'Dispatch', icon: Send },
];

function joinPath(base: string, name: string): string {
	const cleanBase = base.replace(/\/+$/, '');
	return `${cleanBase}/${name}`.replace(/\/{2,}/g, '/');
}

export function ContainerOpsPanel({ container }: { container: ContainerRecord }) {
	const [tab, setTab] = useState<ContainerTab>('logs');

	useEffect(() => {
		setTab('logs');
	}, [container.id]);

	return (
		<div className="space-y-4">
			<div className="inline-flex rounded-lg border bg-card p-1">
				{TABS.map(({ id, label, icon: Icon }) => (
					<button
						key={id}
						type="button"
						onClick={() => setTab(id)}
						className={cn(
							'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors',
							tab === id
								? 'bg-secondary text-secondary-foreground shadow-sm'
								: 'text-muted-foreground hover:text-foreground',
						)}
					>
						<Icon className="h-4 w-4" />
						{label}
					</button>
				))}
			</div>

			{tab === 'logs' && <LogsPanel container={container} />}
			{tab === 'files' && <FilesPanel container={container} />}
			{tab === 'terminal' && <TerminalPanel container={container} />}
			{tab === 'dispatch' && <DispatchPanel container={container} />}
		</div>
	);
}

function LogsPanel({ container }: { container: ContainerRecord }) {
	const [tail, setTail] = useState('200');
	const [timestamps, setTimestamps] = useState(true);

	const logsQuery = useQuery({
		queryKey: ['container', container.id, 'logs', tail, timestamps],
		queryFn: () =>
			api
				.get<{ logs: string }>(`/api/v1/apps/${container.id}/logs`, {
					params: { tail: Number(tail) || 200, timestamps },
				})
				.then((r) => r.data),
		enabled: container.state === 'running',
	});

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<div className="flex items-center gap-2">
					<Label htmlFor={`tail-${container.id}`}>Tail</Label>
					<Input
						id={`tail-${container.id}`}
						className="w-24"
						value={tail}
						onChange={(e) => setTail(e.target.value)}
					/>
				</div>
				<label className="flex items-center gap-2 text-sm text-muted-foreground">
					<input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />
					Timestamps
				</label>
				<Button variant="outline" size="sm" onClick={() => logsQuery.refetch()} disabled={logsQuery.isFetching}>
					<RefreshCw className="h-4 w-4" />
					Refresh
				</Button>
			</div>
			{container.state !== 'running' ? (
				<div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
					Logs are only available when the container is running.
				</div>
			) : (
				<Textarea readOnly value={logsQuery.data?.logs ?? ''} className="min-h-[280px] font-mono text-xs" />
			)}
		</div>
	);
}

function FilesPanel({ container }: { container: ContainerRecord }) {
	const [path, setPath] = useState('/app');
	const [selectedFile, setSelectedFile] = useState<string | null>(null);

	useEffect(() => {
		setPath('/app');
		setSelectedFile(null);
	}, [container.id]);

	const filesQuery = useQuery({
		queryKey: ['container', container.id, 'files', path],
		queryFn: () =>
			api
				.get<{ path: string; entries: FileEntry[] }>(`/api/v1/apps/${container.id}/files`, {
					params: { path },
				})
				.then((r) => r.data),
		enabled: container.state === 'running',
	});

	const fileContentQuery = useQuery({
		queryKey: ['container', container.id, 'file-content', selectedFile],
		queryFn: () =>
			api
				.get<{ path: string; content: string; size: number }>(
					`/api/v1/apps/${container.id}/files/content`,
					{ params: { path: selectedFile } },
				)
				.then((r) => r.data),
		enabled: container.state === 'running' && Boolean(selectedFile),
	});

	const openEntry = (entry: FileEntry) => {
		const nextPath = joinPath(path, entry.name);
		if (entry.type === 'directory') {
			setPath(nextPath);
			setSelectedFile(null);
			return;
		}
		setSelectedFile(nextPath);
	};

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<Label htmlFor={`path-${container.id}`}>Path</Label>
				<Input
					id={`path-${container.id}`}
					value={path}
					onChange={(e) => {
						setPath(e.target.value);
						setSelectedFile(null);
					}}
					className="max-w-sm"
				/>
				<Button variant="outline" size="sm" onClick={() => filesQuery.refetch()} disabled={filesQuery.isFetching}>
					<RefreshCw className="h-4 w-4" />
					Refresh
				</Button>
			</div>

			{container.state !== 'running' ? (
				<div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
					File browser is only available when the container is running.
				</div>
			) : (
				<div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
					<div className="rounded-md border">
						<div className="border-b px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
							{filesQuery.data?.path ?? path}
						</div>
						<div className="max-h-[300px] overflow-auto">
							{(filesQuery.data?.entries ?? []).length === 0 && (
								<div className="p-4 text-sm text-muted-foreground">No entries.</div>
							)}
							{filesQuery.data?.entries.map((entry) => (
								<button
									key={entry.name}
									type="button"
									onClick={() => openEntry(entry)}
									className="flex w-full items-center justify-between border-b px-3 py-2 text-left text-sm hover:bg-accent/40"
								>
									<div className="flex items-center gap-2">
										<FileText className="h-4 w-4 text-muted-foreground" />
										<span>{entry.name}</span>
									</div>
									<span className="text-xs text-muted-foreground">{entry.type}</span>
								</button>
							))}
						</div>
					</div>

					<div className="space-y-2">
						<div className="text-sm font-medium">
							{fileContentQuery.data ? fileContentQuery.data.path : 'Preview'}
						</div>
						<Textarea
							readOnly
							value={fileContentQuery.data?.content ?? 'Select a file to preview it.'}
							className="min-h-[300px] font-mono text-xs"
						/>
					</div>
				</div>
			)}
		</div>
	);
}

function TerminalPanel({ container }: { container: ContainerRecord }) {
	const socketRef = useRef<WebSocket | null>(null);
	const outputRef = useRef<HTMLTextAreaElement | null>(null);
	const [status, setStatus] = useState<'idle' | 'connecting' | 'open' | 'closed' | 'error'>('idle');
	const [output, setOutput] = useState('');
	const [input, setInput] = useState('');

	useEffect(() => {
		setOutput('');
		setInput('');
		setStatus('idle');

		if (container.state !== 'running') return;
		const token = getStoredToken();
		if (!token) {
			setStatus('error');
			setOutput('Missing auth token.');
			return;
		}

		const wsUrl = new URL(`/api/v1/apps/${container.id}/terminal`, window.location.origin);
		wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
		wsUrl.searchParams.set('token', token);

		setStatus('connecting');
		const socket = new WebSocket(wsUrl.toString());
		socketRef.current = socket;

		socket.onopen = () => {
			setStatus('open');
			setOutput((prev) => prev + `[connected ${new Date().toLocaleTimeString()}]\n`);
		};
		socket.onmessage = (event) => {
			const chunk = typeof event.data === 'string' ? event.data : '';
			setOutput((prev) => prev + chunk);
		};
		socket.onclose = () => setStatus((prev) => (prev === 'error' ? prev : 'closed'));
		socket.onerror = () => {
			setStatus('error');
			setOutput((prev) => prev + '\n[terminal error]\n');
		};

		return () => {
			try {
				socket.close();
			} catch {
				// ignore
			}
			socketRef.current = null;
		};
	}, [container.id, container.state]);

	useEffect(() => {
		const node = outputRef.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [output]);

	const sendInput = () => {
		const socket = socketRef.current;
		if (!socket || socket.readyState !== WebSocket.OPEN) return;
		socket.send(`${input}${input.endsWith('\n') ? '' : '\n'}`);
		setInput('');
	};

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-3">
				<div className="text-sm text-muted-foreground">Status: {status}</div>
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						try {
							socketRef.current?.close();
						} catch {
							// ignore
						}
					}}
				>
					<Terminal className="h-4 w-4" />
					Close
				</Button>
			</div>

			{container.state !== 'running' ? (
				<div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
					Terminal is only available when the container is running.
				</div>
			) : (
				<>
					<Textarea ref={outputRef} readOnly value={output} className="min-h-[260px] font-mono text-xs" />
					<div className="flex gap-2">
						<Input
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && !e.shiftKey) {
									e.preventDefault();
									sendInput();
								}
							}}
							className="font-mono"
							placeholder="Type a shell command and press Enter"
						/>
						<Button onClick={sendInput}>
							<Send className="h-4 w-4" />
							Send
						</Button>
					</div>
				</>
			)}
		</div>
	);
}

function DispatchPanel({ container }: { container: ContainerRecord }) {
	const [body, setBody] = useState('{\n  "jsonrpc": "2.0",\n  "method": "ping",\n  "id": 1\n}');
	const [result, setResult] = useState('');
	const dispatchMutation = useMutation({
		mutationFn: async () => {
			try {
				const parsed = JSON.parse(body) as Record<string, unknown>;
				const res = await api.post(`/api/v1/apps/${container.id}/dispatch`, parsed);
				return res.data;
			} catch (err) {
				throw new Error(err instanceof Error ? err.message : 'Invalid JSON payload');
			}
		},
		onSuccess: (data) => {
			setResult(JSON.stringify(data, null, 2));
		},
		onError: (err) => {
			setResult(errorMessage(err));
			toast.error(errorMessage(err));
		},
	});

	return (
		<div className="space-y-3">
			<div className="text-sm text-muted-foreground">Send a JSON-RPC/MCP payload to the running app.</div>
			<Textarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[220px] font-mono text-xs" />
			<div className="flex items-center gap-2">
				<Button onClick={() => dispatchMutation.mutate()} disabled={dispatchMutation.isPending}>
					<Send className="h-4 w-4" />
					Dispatch
				</Button>
				{dispatchMutation.isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
			</div>
			<Textarea readOnly value={result} className="min-h-[180px] font-mono text-xs" />
		</div>
	);
}
