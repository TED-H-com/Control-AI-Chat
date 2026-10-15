import { randomUUID } from 'node:crypto';
import { lstatSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export interface FileBlobStore {
  put(key:string,bytes:Uint8Array):Promise<void>;
  read(key:string):Promise<Uint8Array|null>;
  remove(key:string):Promise<void>;
  /** Synchronous companion to `read` used to distinguish a prepared unlink from a completed one. */
  existsSync?(key:string):boolean;
  /**
   * Retention uses this while it owns SQLite's write lock, so no legal-hold writer can land
   * between the guarded row transition and the irreversible unlink. An implementation must not
   * return before the name is gone, must treat an already-missing name as success for crash
   * recovery, and throwing must mean that it did not remove the name.
   */
  removeSync?(key:string):void;
}

/**
 * `project_files` has no blob column and is not getting one: a 100 MB upload stored inline shares
 * page cache and WAL frames with every governance query on the tenant, and `extracted_text` is the
 * extracted text, not a place to hide the original. The row therefore keeps only `storage_key` and
 * the bytes live under the configured upload root.
 *
 * `storage_key` is a value read back out of the database, so every operation re-resolves it and
 * refuses anything that leaves the root. Without that check a row whose key contained `../` would
 * address another tenant's bytes — the same read the tenant predicate exists to prevent, taken
 * through the filesystem instead of through SQL.
 */
export function createDiskBlobStore(root:string):FileBlobStore {
  const base=resolve(root);
  const locate=(key:string):string => {
    const path=resolve(base,key);
    if(!path.startsWith(base+sep))throw new Error(`Refusing a storage key outside the upload root: ${key}`);
    return path;
  };
  return {
    // Written to a unique sibling and renamed. rename(2) is atomic within a filesystem, so a reader
    // either sees the whole file or no file; a plain write leaves a truncated blob visible to any
    // concurrent download of the same content-addressed key.
    async put(key,bytes){const path=locate(key),temp=`${path}.${randomUUID()}.tmp`;await mkdir(dirname(path),{recursive:true});await writeFile(temp,bytes);await rename(temp,path);},
    async read(key){try{return new Uint8Array(await readFile(locate(key)))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}},
    async remove(key){await rm(locate(key),{force:true})},
    existsSync(key){try{lstatSync(locate(key));return true}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}},
    removeSync(key){rmSync(locate(key),{force:true})},
  };
}
