import { nanoid } from "nanoid";

export type OrgId = string & { readonly __brand: "OrgId" };
export type UserId = string & { readonly __brand: "UserId" };
export type FileId = string & { readonly __brand: "FileId" };

export function asOrgId(value: string): OrgId {
  return value as OrgId;
}

export function asUserId(value: string): UserId {
  return value as UserId;
}

export function asFileId(value: string): FileId {
  return value as FileId;
}

export function newFileId(): FileId {
  return nanoid(18) as FileId;
}

