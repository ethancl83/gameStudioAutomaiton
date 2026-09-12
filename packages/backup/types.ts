export interface PortableBackupRecord {
  origin?:'created'|'imported';
  id:string;createdAt:string;updatedAt:string;status:'creating'|'ready'|'failed';
  size:number;fileCount:number;credentialCount:number;sha256?:string;error?:string;
}
export interface PortableRestoreRecord {
  id:string;backupId:string;createdAt:string;updatedAt:string;status:'preparing'|'ready'|'committed'|'failed';
  projectCount:number;fileCount:number;credentialCount:number;error?:string;
}
export interface PortableBackupState {backups:PortableBackupRecord[];restore:PortableRestoreRecord|null;busy:boolean}
export interface PortableBackupImport {id:string;size:number}
