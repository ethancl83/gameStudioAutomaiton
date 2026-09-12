import test from 'node:test';
import assert from 'node:assert/strict';
import {AppError} from '../packages/domain/errors.js';
import {listPlayListings,reconcilePlayListingEdit,updatePlayListing} from '../packages/connectors/store-play-edits.js';
import type {ConnectorContext} from '../packages/connectors/types.js';

test('failed Play listing edit cleanup cannot report success and rechecking never writes',async()=>{
 const checkpoints:Record<string,unknown>[]=[];let exists=true;let reads=0;let deletes=0;
 const ctx={checkpoint:(x:Record<string,unknown>)=>checkpoints.push(x),request:async(url:string,opts:{method?:string;write?:boolean}={})=>{
  if(opts.method==='POST')return{id:'pending-edit'};
  if(url.endsWith('/listings'))return{listings:[]};
  if(opts.method==='DELETE'){deletes++;throw new AppError('NETWORK','lost response',503);}
  assert.equal(opts.write,undefined);reads++;if(!exists)throw new AppError('RESOURCE_NOT_FOUND','expired',404);return{id:'pending-edit'};
 }} as unknown as ConnectorContext;
 await assert.rejects(listPlayListings({},ctx,'com.example.app',{}),(error:unknown)=>error instanceof AppError&&error.code==='ACTION_REQUIRED');
 assert.equal(checkpoints.at(-1)?.editDiscarded,false);assert.equal(checkpoints.at(-1)?.editId,'pending-edit');
 const pending=await reconcilePlayListingEdit({listingsEditId:'pending-edit'},ctx,'com.example.app',{});assert.equal(pending.unresolved,true);assert.equal(pending.summary.editDiscarded,false);
 exists=false;const cleared=await reconcilePlayListingEdit({listingsEditId:'pending-edit'},ctx,'com.example.app',{});assert.equal(cleared.summary.editDiscarded,true);assert.equal(cleared.summary.failed,true);assert.equal(deletes,1);assert.equal(reads,2);
});

for (const failedStep of ['PUT','validate','commit','cleanup'] as const) test('Play mutation cleanup respects '+failedStep+' boundary',async()=>{
 const calls:string[]=[];const checkpoints:Record<string,unknown>[]=[];
 const ctx={checkpoint:(x:Record<string,unknown>)=>checkpoints.push(x),request:async(url:string,opts:{method?:string}={})=>{
  const step=url.endsWith(':commit')?'commit':url.endsWith(':validate')?'validate':opts.method??'GET';calls.push(step);
  if(step===failedStep||(failedStep==='cleanup'&&(step==='PUT'||step==='DELETE')))throw new AppError('TEMPORARY','response lost',503);
  if(url.endsWith('/edits'))return{id:'mutation-edit'};return{};
 }} as unknown as ConnectorContext;
 const action=updatePlayListing({language:'en-US',title:'Test'},ctx,'com.example.app',{});
 if(failedStep==='commit'||failedStep==='cleanup')await assert.rejects(action);
 else {const result=await action;assert.equal(result.failed,true);assert.equal(result.summary.editDiscarded,true);}
 assert.equal(calls.filter(x=>x==='DELETE').length,failedStep==='commit'?0:1);
 assert.equal(checkpoints.at(-1)?.phase,failedStep==='commit'?'commit-started':failedStep==='cleanup'?'edit-cleanup-required':'edit-discarded');
});
