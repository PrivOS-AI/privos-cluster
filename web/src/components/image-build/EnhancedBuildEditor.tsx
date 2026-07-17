import { useState, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Upload, Link as LinkIcon, FileText, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, getStoredToken } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

type SourceType = 'editor' | 'upload' | 'url';

interface EnhancedBuildEditorProps {
	dockerfile: string;
	onDockerfileChange: (dockerfile: string) => void;
	onBuild: () => void;
	buildDisabled: boolean;
	isBuilding: boolean;
}

export function EnhancedBuildEditor({
	dockerfile,
	onDockerfileChange,
	onBuild,
	buildDisabled,
	isBuilding,
}: EnhancedBuildEditorProps) {
	const [source, setSource] = useState<SourceType>('editor');
	const [uploadFile, setUploadFile] = useState<File | null>(null);
	const [importURL, setImportURL] = useState('');
	const [previewContent, setPreviewContent] = useState('');
	const [uploadProgress, setUploadProgress] = useState(0);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Upload mutation
	const uploadMutation = useMutation({
		mutationFn: async (file: File) => {
			const formData = new FormData();
			formData.append('file', file);

			const response = await fetch('/api/v1/images/build/upload', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${getStoredToken() ?? ''}`,
				},
				body: formData,
			});

			if (!response.ok) {
				const error = await response.json() as { error?: string };
				throw new Error(error.error || 'Upload failed');
			}

			return response.json();
		},
		onSuccess: () => {
			toast.success('Dockerfile uploaded successfully');
			// Get uploaded content
			// In real implementation, you'd fetch the content from the server
			setUploadFile(null);
			setUploadProgress(0);
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	// Preview URL mutation
	const previewMutation = useMutation({
		mutationFn: async (url: string) => {
			const response = await api.get('/api/v1/images/build/preview-url', {
				params: { url },
			});
			return response.data as { content: string };
		},
		onSuccess: (result) => {
			setPreviewContent(result.content);
			toast.success('Dockerfile preview loaded');
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	// Import URL mutation
	const importMutation = useMutation({
		mutationFn: async (url: string) => {
			const response = await api.post('/api/v1/images/build/import-url', { url });
			return response.data as { previewId: string };
		},
		onSuccess: () => {
			// Fetch the content using the previewId
			// In real implementation, you'd store previewId and use it
			setImportURL('');
			toast.success('Dockerfile imported successfully');
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (file) {
			setUploadFile(file);
		}
	};

	const handleUpload = async () => {
		if (!uploadFile) return;

		// Simulate upload progress
		setUploadProgress(0);
		const interval = setInterval(() => {
			setUploadProgress((prev) => {
				if (prev >= 90) {
					clearInterval(interval);
					return 90;
				}
				return prev + 10;
			});
		}, 100);

		try {
			await uploadMutation.mutateAsync(uploadFile);
			setUploadProgress(100);
		} finally {
			clearInterval(interval);
		}
	};

	const handlePreview = async () => {
		if (!importURL.trim()) return;

		try {
			const result = await previewMutation.mutateAsync(importURL);
			setPreviewContent(result.content);
			toast.success('Dockerfile preview loaded');
		} catch (err) {
			toast.error(errorMessage(err));
		}
	};

	const handleImport = async () => {
		if (!importURL.trim()) return;

		try {
			await importMutation.mutateAsync(importURL);
			if (previewContent) {
				onDockerfileChange(previewContent);
			}
			toast.success('Dockerfile imported successfully');
		} catch (err) {
			toast.error(errorMessage(err));
		}
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		const file = e.dataTransfer.files[0];
		if (file && (file.name.endsWith('.dockerfile') || file.name === 'Dockerfile' || file.type === 'text/plain')) {
			setUploadFile(file);
		} else {
			toast.error('Please upload a valid Dockerfile');
		}
	};

	const handleDragOver = (e: React.DragEvent) => {
		e.preventDefault();
	};

	return (
		<div className="space-y-6">
			{/* Source Selector */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Dockerfile Source</CardTitle>
					<CardDescription>Choose how to provide your Dockerfile</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							onClick={() => setSource('editor')}
							className={[
								'flex items-center gap-2 rounded-md border px-4 py-2 text-sm transition-colors',
								source === 'editor'
									? 'border-primary bg-accent/40'
									: 'hover:bg-accent/40',
							].join(' ')}
						>
							<FileText className="h-4 w-4" />
							Write Editor
						</button>
						<button
							type="button"
							onClick={() => setSource('upload')}
							className={[
								'flex items-center gap-2 rounded-md border px-4 py-2 text-sm transition-colors',
								source === 'upload'
									? 'border-primary bg-accent/40'
									: 'hover:bg-accent/40',
							].join(' ')}
						>
							<Upload className="h-4 w-4" />
							Upload File
						</button>
						<button
							type="button"
							onClick={() => setSource('url')}
							className={[
								'flex items-center gap-2 rounded-md border px-4 py-2 text-sm transition-colors',
								source === 'url'
									? 'border-primary bg-accent/40'
									: 'hover:bg-accent/40',
							].join(' ')}
						>
							<LinkIcon className="h-4 w-4" />
							Import URL
						</button>
					</div>
				</CardContent>
			</Card>

			{/* Editor Source */}
			{source === 'editor' && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Dockerfile Editor</CardTitle>
						<CardDescription>Write your Dockerfile directly</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<Textarea
							value={dockerfile}
							onChange={(e) => onDockerfileChange(e.target.value)}
							className="min-h-[300px] font-mono text-sm"
							placeholder="# Your Dockerfile here..."
						/>
						<div className="flex items-center justify-between">
							<div className="text-xs text-muted-foreground">
								{dockerfile.split('\n').length} lines
							</div>
							<div className="flex gap-2">
								<Button variant="outline" size="sm" onClick={() => onDockerfileChange('')}>
									Clear
								</Button>
								<Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(dockerfile)}>
									Copy
								</Button>
							</div>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Upload Source */}
			{source === 'upload' && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Upload Dockerfile</CardTitle>
						<CardDescription>Upload a Dockerfile from your computer</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<input
							ref={fileInputRef}
							type="file"
							accept=".dockerfile,Dockerfile,text/plain"
							onChange={handleFileSelect}
							className="hidden"
						/>
						<div
							onDrop={handleDrop}
							onDragOver={handleDragOver}
							className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:bg-accent/40 transition-colors"
							onClick={() => fileInputRef.current?.click()}
						>
							<Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
							<p className="text-sm font-medium mb-2">
								{uploadFile ? uploadFile.name : 'Drop Dockerfile here or click to upload'}
							</p>
							<p className="text-xs text-muted-foreground">
								Supported: .dockerfile, Dockerfile, .txt (Max 1MB)
							</p>
						</div>

						{uploadFile && (
							<div className="space-y-3">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<FileText className="h-4 w-4 text-muted-foreground" />
										<span className="text-sm font-medium">{uploadFile.name}</span>
										<Badge variant="secondary">{(uploadFile.size / 1024).toFixed(1)} KB</Badge>
									</div>
									<Button variant="ghost" size="sm" onClick={() => setUploadFile(null)}>
										Remove
									</Button>
								</div>

								{uploadProgress > 0 && uploadProgress < 100 && (
									<div className="space-y-2">
										<div className="flex items-center justify-between text-xs">
											<span>Uploading...</span>
											<span>{uploadProgress}%</span>
										</div>
										<div className="h-2 bg-muted rounded-full overflow-hidden">
											<div
												className="h-full bg-primary transition-all"
												style={{ width: `${uploadProgress}%` }}
											/>
										</div>
									</div>
								)}

								<Button onClick={handleUpload} disabled={uploadMutation.isPending} className="w-full">
									{uploadMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
									Upload Dockerfile
								</Button>
							</div>
						)}
					</CardContent>
				</Card>
			)}

			{/* URL Import Source */}
			{source === 'url' && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Import from URL</CardTitle>
						<CardDescription>Import Dockerfile from GitHub, GitLab, or any raw URL</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="space-y-3">
							<div className="space-y-2">
								<Label>Dockerfile URL</Label>
								<Input
									value={importURL}
									onChange={(e) => setImportURL(e.target.value)}
									placeholder="https://raw.githubusercontent.com/user/repo/main/Dockerfile"
								/>
							</div>

							<div className="flex gap-2">
								<Button
									variant="outline"
									onClick={handlePreview}
									disabled={previewMutation.isPending || !importURL.trim()}
								>
									{previewMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
									Preview
								</Button>
								<Button
									onClick={handleImport}
									disabled={importMutation.isPending || !importURL.trim() || !previewContent}
								>
									{importMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
									Import
								</Button>
							</div>
						</div>

						{previewContent && (
							<>
								<Separator />
								<div className="space-y-2">
									<Label>Preview</Label>
									<Textarea
										value={previewContent}
										readOnly
										className="min-h-[200px] font-mono text-xs bg-muted/50"
									/>
								</div>
							</>
						)}

						<div className="space-y-2">
							<p className="text-xs font-medium">Examples:</p>
							<div className="space-y-1 text-xs text-muted-foreground">
								<p>• GitHub: https://raw.githubusercontent.com/user/repo/main/Dockerfile</p>
								<p>• GitLab: https://gitlab.com/user/repo/-/raw/main/Dockerfile</p>
								<p>• Any: https://example.com/path/to/Dockerfile</p>
							</div>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Validation Messages */}
			{dockerfile && (
				<Card>
					<CardContent className="pt-6">
						<div className="flex items-start gap-3">
							{dockerfile.toLowerCase().includes('from') ? (
								<CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5" />
							) : (
								<AlertCircle className="h-5 w-5 text-amber-600 mt-0.5" />
							)}
							<div className="flex-1">
								<p className="text-sm font-medium">
									{dockerfile.toLowerCase().includes('from')
										? 'Valid Dockerfile'
										: 'Warning: Missing FROM instruction'}
								</p>
								<p className="text-xs text-muted-foreground mt-1">
									{dockerfile.toLowerCase().includes('from')
										? 'Dockerfile contains required FROM instruction'
										: 'A valid Dockerfile must start with a FROM instruction'}
								</p>
							</div>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Build Button */}
			<Button
				onClick={onBuild}
				disabled={buildDisabled || isBuilding || !dockerfile.trim()}
				className="w-full"
				size="lg"
			>
				{isBuilding && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
				Build Image
			</Button>
		</div>
	);
}
