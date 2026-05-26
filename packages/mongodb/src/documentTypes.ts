export const DOCUMENT_TYPES = ["interview", "grand_prix_result"] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];
