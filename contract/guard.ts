/**
 * Stored vocabulary for a held row.
 * Commona does not filter message or file content. A post or file is accepted,
 * and these fields stay empty.
 */

export const BlockCategory = {
  Name: "name",
  HealthNumber: "health_number",
  Dob: "dob",
} as const;

export type BlockCategory = (typeof BlockCategory)[keyof typeof BlockCategory];

export const BLOCK_CATEGORIES = [
  BlockCategory.Name,
  BlockCategory.HealthNumber,
  BlockCategory.Dob,
] as const;

export const BlockLocation = {
  Text: "text",
  FileBody: "file_body",
  FileName: "file_name",
  FileMeta: "file_meta",
} as const;

export type BlockLocation = (typeof BlockLocation)[keyof typeof BlockLocation];

export const BLOCK_LOCATIONS = [
  BlockLocation.Text,
  BlockLocation.FileBody,
  BlockLocation.FileName,
  BlockLocation.FileMeta,
] as const;

export const MAX_MESSAGE_CHARS = 16_000;
export const MAX_FILE_BYTES = 1_048_576;
export const MAX_METADATA_KEYS = 20;
export const MAX_METADATA_CHARS = 200;

export interface GuardHit {
  category: BlockCategory;
  location: BlockLocation;
}
