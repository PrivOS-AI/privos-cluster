// Image Build Types
export interface BuildRequest {
  dockerfile: string;
  imageName: string;
  tag: string;
  buildArgs?: Record<string, string>;
  context?: string;
  description?: string;
}

export interface BuildResponse {
  buildId: string;
  status: 'pending' | 'building' | 'success' | 'failed';
  imageName: string;
  tag: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export interface BuildLogEntry {
  timestamp: number;
  level: 'info' | 'error' | 'warning';
  message: string;
  step?: string;
}

export interface BuildHistoryItem {
  buildId: string;
  imageName: string;
  tag: string;
  status: 'success' | 'failed' | 'cancelled';
  startedAt: number;
  completedAt?: number;
  duration?: number;
  sizeBytes?: number;
  error?: string;
  builtBy: string;
  description?: string;
  dockerfile?: string;
}

export interface BuildTemplate {
  id: string;
  name: string;
  description: string;
  dockerfile: string;
  defaultImageName: string;
  defaultTag: string;
  variables: Array<{
    name: string;
    defaultValue: string;
    description: string;
  }>;
  category: 'nodejs' | 'python' | 'golang' | 'java' | 'static' | 'custom';
}

export interface ValidationError {
  line: number;
  column?: number;
  severity: 'error' | 'warning';
  message: string;
  instruction?: string;
}
