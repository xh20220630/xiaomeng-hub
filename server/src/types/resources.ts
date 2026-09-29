export interface ResourceContext {
  sessionId: string;
  cwd: string;
}

export interface ResourceAttachment {
  reference: string;
  name: string;
  kind: 'image' | 'file';
  snapshot?: boolean;
}

export interface ResourceMetadata {
  resourceId: string;
  name: string;
  kind: 'image' | 'text' | 'markdown' | 'directory' | 'file';
  mimeType: string;
  size: number;
  version: string;
  modifiedAt: number;
  snapshot: boolean;
  previewAvailable: boolean;
  line?: number;
  width?: number;
  height?: number;
  sourceName?: string;
}

export interface ResourceRequest {
  reference?: string;
  baseResourceId?: string;
  resourceId?: string;
  version?: string;
  startLine?: number;
  cursor?: string;
  variant?: 'content' | 'thumbnail' | 'text';
  transferId?: string;
}

export interface ResourceText {
  text: string;
  startLine: number;
  nextLine: number | null;
  truncated: boolean;
  encoding: string;
  version: string;
}

export interface ResourceDirectory {
  directory: ResourceMetadata;
  entries: { name: string; reference: string; directory: boolean }[];
  nextCursor: string | null;
}
