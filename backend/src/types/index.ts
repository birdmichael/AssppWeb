export interface Software {
  id: number;
  bundleID: string;
  name: string;
  version: string;
  price?: number;
  artistName: string;
  sellerName: string;
  description: string;
  averageUserRating: number;
  userRatingCount: number;
  artworkUrl: string;
  screenshotUrls: string[];
  minimumOsVersion: string;
  fileSizeBytes?: string;
  releaseDate: string;
  releaseNotes?: string;
  formattedPrice?: string;
  primaryGenreName: string;
}

export interface Sinf {
  id: number;
  sinf: string; // base64 encoded
}

export interface Cookie {
  name: string;
  value: string;
  path: string;
  domain?: string;
  hostOnly?: boolean;
  expiresAt?: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface Account {
  email: string;
  password: string;
  appleId: string;
  store: string;
  /** Full X-Set-Apple-Store-Front value, distinct from the region ID. */
  storeFront?: string;
  firstName: string;
  lastName: string;
  passwordToken: string;
  directoryServicesIdentifier: string;
  cookies: Cookie[];
  deviceIdentifier: string;
  pod?: string;
  /** Last successful validated authentication URL; query GUID is not persisted. */
  authEndpoint?: string;
}

export interface DownloadTask {
  id: string;
  software: Software;
  accountHash: string;
  downloadURL: string;
  sinfs: Sinf[];
  iTunesMetadata?: string;
  status:
    | "pending"
    | "downloading"
    | "paused"
    | "injecting"
    | "completed"
    | "failed";
  progress: number;
  speed: string;
  error?: string;
  filePath?: string;
  createdAt: string;
}

export interface PackageInfo {
  id: string;
  software: Software;
  accountHash: string;
  filePath: string;
  fileSize: number;
  createdAt: string;
}
