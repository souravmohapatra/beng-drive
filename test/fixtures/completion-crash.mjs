// Disposable test-only process that exits at a completion boundary.
import { openDatabase } from '../../src/server/db.mjs';
import { StoragePool } from '../../src/server/storage/pool.mjs';
import { completeUpload } from '../../src/server/collections.mjs';

const [root, databasePath, id, point] = process.argv.slice(2);
if (!['before_db_commit','after_db_commit','after_sidecar_cleanup'].includes(point)) throw new Error('Invalid fixture point');
const db=openDatabase(databasePath);
const row=db.prepare('SELECT * FROM uploads WHERE id=? AND status=?').get(id,'finalizing');
if (!row) throw new Error('Invalid fixture state');
const storage=new StoragePool({root,fixture:true,expectedSource:''});
const result=await storage.submit('finalize',{id,collectionId:row.collection_id,size:row.declared_size,originalName:row.original_name});
if (point==='before_db_commit') process.exit(91);
const completed=completeUpload(db,id,result);
if (point==='after_db_commit') process.exit(91);
await storage.submit('cleanupCompletion',{id,collectionId:row.collection_id,size:row.declared_size,
  originalName:row.original_name,locator:completed.storage_locator,hash:completed.content_hash});
process.exit(91);
