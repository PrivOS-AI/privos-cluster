import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileUp, Loader2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage, getStoredToken } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn, formatBytes } from '@/lib/utils';

interface ImportedImage {
	id: string;
	repository: string;
	tag: string;
}

interface ProgressEntry {
	stream?: string;
	error?: string;
	done?: boolean;
	images?: ImportedImage[];
	count?: number;
}

export function ImportTarballCard() {
	const queryClient = useQueryClient();
	const inputRef = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<File | null>(null);
	const [description, setDescription] = useState('');
	const [isUploading, setIsUploading] = useState(false);
	const [progress, setProgress] = useState<ProgressEntry[]>([]);
	const [dragOver, setDragOver] = useState(false);

	function reset() {
		setFile(null);
		setDescription('');
		setProgress([]);
		if (inputRef.current) inputRef.current.value = '';
	}

	function handleFile(f: File | undefined | null) {
		if (!f) return;
		const isTar = f.name.endsWith('.tar') || f.name.endsWith('.tar.gz') || f.name.endsWith('.tgz');
		if (!isTar) {
			toast.warning('Expected a .tar / .tar.gz file from `docker save`. Trying anyway.');
		}
		setFile(f);
		setProgress([]);
	}

	async function startUpload() {
		if (!file) return;
		setIsUploading(true);
		setProgress([]);

		const fd = new FormData();
		fd.append('file', file, file.name);
		if (description.trim()) fd.append('description', description.trim());

		let importedCount = 0;
		try {
			const res = await fetch('/api/v1/images/import', {
				method: 'POST',
				headers: { authorization: `Bearer ${getStoredToken() ?? ''}` },
				body: fd,
			});

			if (!res.ok || !res.body) {
				let msg = `Upload failed (${res.status})`;
				try {
					const body = (await res.json()) as { error?: string; hint?: string };
					if (body.error) msg = body.hint ? `${body.error}: ${body.hint}` : body.error;
				} catch {
					// keep generic
				}
				throw new Error(msg);
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const frames = buffer.split('\n\n');
				buffer = frames.pop() ?? '';
				for (const frame of frames) {
					const line = frame.trim();
					if (!line.startsWith('data:')) continue;
					const payload = line.slice(5).trim();
					if (!payload) continue;
					const entry = JSON.parse(payload) as ProgressEntry;
					setProgress((prev) => [...prev, entry]);
					if (entry.done && entry.count !== undefined) importedCount = entry.count;
					if (entry.error && entry.done) throw new Error(entry.error);
				}
			}

			toast.success(
				importedCount > 0
					? `Imported ${importedCount} image${importedCount === 1 ? '' : 's'} from ${file.name}`
					: `Loaded ${file.name} (no images registered)`,
			);
			void queryClient.invalidateQueries({ queryKey: ['images'] });
			reset();
		} catch (err) {
			toast.error(errorMessage(err));
		} finally {
			setIsUploading(false);
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<FileUp className="h-4 w-4" />
					Import from tarball
				</CardTitle>
				<CardDescription>
					Upload a <span className="font-mono">.tar</span> produced by{' '}
					<span className="font-mono">docker save</span>. Cluster will{' '}
					<span className="font-mono">docker load</span> it and register the resulting image(s).
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{/* Drop zone */}
				<div
					onDragOver={(e) => {
						e.preventDefault();
						setDragOver(true);
					}}
					onDragLeave={() => setDragOver(false)}
					onDrop={(e) => {
						e.preventDefault();
						setDragOver(false);
						handleFile(e.dataTransfer.files?.[0]);
					}}
					onClick={() => !isUploading && inputRef.current?.click()}
					className={cn(
						'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors',
						dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-accent/30',
						isUploading && 'pointer-events-none opacity-60',
					)}
				>
					<input
						ref={inputRef}
						type="file"
						accept=".tar,.tar.gz,.tgz,application/x-tar,application/gzip"
						className="hidden"
						onChange={(e) => handleFile(e.target.files?.[0])}
					/>
					{file ? (
						<div className="w-full">
							<div className="flex items-center justify-between gap-3">
								<div className="min-w-0 flex-1 space-y-0.5 text-left">
									<div className="truncate text-sm font-medium">{file.name}</div>
									<div className="text-xs text-muted-foreground">{formatBytes(file.size)}</div>
								</div>
								{!isUploading && (
									<Button
										variant="ghost"
										size="sm"
										className="h-7 px-2"
										onClick={(e) => {
											e.stopPropagation();
											reset();
										}}
									>
										<X className="h-3.5 w-3.5" />
									</Button>
								)}
							</div>
						</div>
					) : (
						<>
							<Upload className="mb-2 h-6 w-6 text-muted-foreground" />
							<div className="text-sm font-medium">Drop a .tar file here, or click to browse</div>
							<div className="mt-1 text-xs text-muted-foreground">Max 2 GB</div>
						</>
					)}
				</div>

				<div className="space-y-2">
					<Label>Description (optional)</Label>
					<Input
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="Where did this image come from?"
						disabled={isUploading}
					/>
				</div>

				<Button
					className="w-full"
					onClick={startUpload}
					disabled={!file || isUploading}
				>
					{isUploading ? (
						<Loader2 className="h-4 w-4 animate-spin" />
					) : (
						<Upload className="h-4 w-4" />
					)}
					{isUploading ? 'Loading into Docker...' : 'Import image'}
				</Button>

				{/* Progress log */}
				{progress.length > 0 && (
					<div className="max-h-[160px] overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
						{progress.map((p, i) => (
							<div key={i} className={cn(p.error ? 'text-rose-600' : 'text-muted-foreground')}>
								{p.error
									? `! ${p.error}`
									: p.done
										? `✓ done — ${p.count ?? 0} image(s) registered`
										: p.stream?.trim()}
							</div>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
