export type StickerRecord = {
  id: string;
  contentHash: string;
  storageName: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  title: string | null;
  textContent: string | null;
  emotion: string | null;
  sourceKind: string | null;
  sourceNote: string | null;
  createdAt: string;
  updatedAt: string;
  tags: string[];
};

export type StickerListItem = StickerRecord;

export type CreateStickerInput = {
  buffer: Buffer;
  title?: string | null;
  textContent?: string | null;
  emotion?: string | null;
  tags?: string[];
  sourceKind?: string | null;
  sourceNote?: string | null;
};

export type UpdateStickerInput = {
  title?: string | null;
  textContent?: string | null;
  emotion?: string | null;
  tags?: string[] | null;
  sourceKind?: string | null;
  sourceNote?: string | null;
};

export type SearchQuery = {
  q?: string;
  emotion?: string;
  tag?: string;
  page: number;
  limit: number;
};
